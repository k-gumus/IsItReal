import { checkDois, type DoiCheck, type DoiResolver } from './citations.js';
import { classifySource, type SourceClassification } from './authority.js';
import { classifyInput, cutReferences, extractDois, pickAnalysisWindow, stripDois, type InputKind } from './input.js';
import { InputError, verifyContent, type VerifyDeps } from './pipeline.js';
import type { PageExtractor } from './providers.js';
import type { VerdictLabel, VerificationReport } from './types.js';

export interface AnalysisSource {
  kind: InputKind;
  /** Arayüzde gösterilen kısa ad: "Metin", alan adı, DOI ya da dosya adı */
  label: string;
  url?: string;
  title?: string;
  pages?: number;
  /** Bağlantı girildiyse bağlantının kendi kaynak katmanı */
  classification?: SourceClassification;
}

export interface CitationSummary {
  total: number;
  found: number;
  notFound: number;
  retracted: number;
  corrected: number;
  unchecked: number;
}

export interface AnalysisReport extends VerificationReport {
  source: AnalysisSource;
  /** Metinde/PDF'te geçen ya da doğrudan girilen DOI'lerin denetimi */
  citations: DoiCheck[];
  citationSummary: CitationSummary;
}

export interface PdfInput {
  name: string;
  pages: number;
  text: string;
  title?: string;
  dois: string[];
}

export type AnalyzeRequest = { text: string } | { pdf: PdfInput };

export interface AnalyzeDeps extends VerifyDeps {
  doiResolver: DoiResolver;
  pageExtractor: PageExtractor;
}

const MAX_CITATIONS = 25;

export function summarizeCitations(checks: DoiCheck[]): CitationSummary {
  return {
    total: checks.length,
    found: checks.filter((c) => c.status === 'found').length,
    notFound: checks.filter((c) => c.status === 'not_found').length,
    retracted: checks.filter((c) => c.isRetracted).length,
    corrected: checks.filter((c) => !c.isRetracted && c.updates.length > 0).length,
    unchecked: checks.filter((c) => c.status === 'error').length,
  };
}

/** Bulunamayan ve geri çekilmiş atıflar şeffaflık puanından düşer (en fazla 40 puan). */
export function citationPenalty(s: CitationSummary): number {
  return Math.min(40, s.notFound * 8 + s.retracted * 12);
}

function citationTips(s: CitationSummary, checks: DoiCheck[], now: Date): string[] {
  const tips: string[] = [];
  if (s.notFound > 0) tips.push('Kayıtlı olmayan DOI\'ler uydurulmuş atıf olabilir (yapay zekâ metinlerinde sık görülür); makale başlığını Google Scholar\'da ayrıca ara.');
  if (s.retracted > 0) tips.push('Geri çekilmiş bir çalışmaya dayanan iddialar artık geçerli kanıt sayılmaz; geri çekme bildirimini oku.');
  const oldest = checks.filter((c) => c.year).map((c) => c.year!).sort()[0];
  if (oldest && now.getFullYear() - oldest >= 10) tips.push(`Atıflardan biri ${now.getFullYear() - oldest} yıllık; konuyla ilgili daha güncel çalışmaları da kontrol et.`);
  return tips;
}

/**
 * İddia hattı çalışmadan, yalnızca atıf denetimiyle rapor:
 * tek bir DOI girildiğinde ya da metin sadece kaynakçadan oluştuğunda.
 */
function citationsOnlyReport(checks: DoiCheck[], source: AnalysisSource, originalInput: string, started: number, now: Date, mode: 'live' | 'demo'): AnalysisReport {
  const summary = summarizeCitations(checks);
  let overallVerdict: VerdictLabel;
  let literacyScore: number;
  if (summary.retracted > 0) [overallVerdict, literacyScore] = ['CONTRADICTED', 5];
  else if (summary.notFound > 0) [overallVerdict, literacyScore] = ['NOT_ENOUGH_EVIDENCE', Math.round((90 * summary.found) / summary.total)];
  else if (summary.corrected > 0) [overallVerdict, literacyScore] = ['MISLEADING_CONTEXT', 60];
  else if (summary.found > 0) [overallVerdict, literacyScore] = ['SUPPORTED', 90];
  else [overallVerdict, literacyScore] = ['NOT_ENOUGH_EVIDENCE', 50];

  const tips = citationTips(summary, checks, now);
  if (summary.found > 0) tips.push('DOI\'nin kayıtlı olması içeriğin doğru olduğunu değil, yayının gerçekten var olduğunu gösterir; makalenin iddia ettiğin şeyi söyleyip söylemediğini oku.');

  return {
    originalInput,
    checkedAt: now.toISOString().split('T')[0]!,
    overallVerdict,
    literacyScore,
    claims: [],
    manipulationSignals: [],
    lateralReadingTips: tips,
    warnings: checks.filter((c) => c.error).map((c) => `${c.doi} denetlenemedi: ${c.error}`),
    durationMs: Date.now() - started,
    mode,
    source,
    citations: checks,
    citationSummary: summary,
  };
}

/**
 * Tüm girdi türleri için tek giriş noktası:
 *  - Metin: iddia hattı + metinde geçen DOI'lerin denetimi
 *  - Bağlantı: sayfa metni çekilir, bağlantının kendi katmanı belirlenir, sonra metin gibi
 *  - DOI: yayın kaydı, geri çekme / düzeltme durumu
 *  - PDF: belge metninin özet bölümü iddia hattına, tüm DOI'ler atıf denetimine
 */
export async function analyze(request: AnalyzeRequest, deps: AnalyzeDeps): Promise<AnalysisReport> {
  const started = Date.now();
  const now = deps.now?.() ?? new Date();
  const emit = deps.onProgress ?? (() => {});
  let source: AnalysisSource;
  let analysisText: string;
  let fullText: string;
  const extraWarnings: string[] = [];

  if ('pdf' in request) {
    const { pdf } = request;
    if (!pdf.text.trim()) throw new InputError('Bu PDF\'te seçilebilir metin yok (taranmış bir belge olabilir).');
    source = { kind: 'pdf', label: pdf.name, pages: pdf.pages, title: pdf.title };
    fullText = pdf.text;
    analysisText = pickAnalysisWindow(cutReferences(pdf.text));
  } else {
    const input = classifyInput(request.text);
    if (input.kind === 'doi') {
      emit({ type: 'stage', stage: 'decompose', message: `DOI kaydı sorgulanıyor: ${input.doi}` });
      const checks = await checkDois(deps.doiResolver, [input.doi]);
      emit({ type: 'stage', stage: 'done', message: 'Rapor hazır' });
      const source: AnalysisSource = { kind: 'doi', label: input.doi, url: checks[0]?.url, title: checks[0]?.title };
      return citationsOnlyReport(checks, source, input.doi, started, now, deps.mode ?? 'live');
    }
    if (input.kind === 'url') {
      const classification = classifySource(input.url);
      emit({ type: 'stage', stage: 'decompose', message: `Bağlantının içeriği alınıyor: ${classification.domain}` });
      let page;
      try {
        page = await deps.pageExtractor.extract(input.url);
      } catch (err) {
        throw new InputError(`Bağlantının içeriği alınamadı. Sayfadaki metni kopyalayıp yapıştırmayı dene. (${(err as Error).message})`);
      }
      source = { kind: 'url', label: classification.domain, url: input.url, title: page.title, classification };
      fullText = page.text;
      analysisText = pickAnalysisWindow(cutReferences([page.title, page.text].filter(Boolean).join('.\n')));
      if (classification.tier === 'TIER_1_TERMINAL_PROOF') {
        extraWarnings.push(`Bağlantı birincil bir kaynağa ait (${classification.reason}); yine de sayfanın tarihine ve kapsamına bak.`);
      }
    } else {
      source = { kind: 'text', label: 'Metin' };
      fullText = input.text;
      analysisText = input.text;
    }
  }

  const dois = extractDois(fullText, MAX_CITATIONS);
  // Kaynakça satırları iddia değildir; DOI'ler ayrı denetlenir
  analysisText = stripDois(analysisText);
  if (analysisText.length < 10 && dois.length > 0) {
    emit({ type: 'stage', stage: 'trace', message: `${dois.length} atıf (DOI) denetleniyor` });
    const checks = await checkDois(deps.doiResolver, dois);
    emit({ type: 'stage', stage: 'done', message: 'Rapor hazır' });
    return citationsOnlyReport(checks, source, fullText.slice(0, 4000), started, now, deps.mode ?? 'live');
  }

  const [verification, citations] = await Promise.all([
    verifyContent(analysisText, deps),
    dois.length > 0
      ? (emit({ type: 'stage', stage: 'trace', message: `${dois.length} atıf (DOI) denetleniyor` }), checkDois(deps.doiResolver, dois))
      : Promise.resolve([] as DoiCheck[]),
  ]);

  const citationSummary = summarizeCitations(citations);
  const tips = [...citationTips(citationSummary, citations, now), ...verification.lateralReadingTips].slice(0, 8);
  if (citationSummary.unchecked > 0) extraWarnings.push(`${citationSummary.unchecked} DOI denetlenemedi (kayıt servislerine ulaşılamadı).`);

  return {
    ...verification,
    literacyScore: Math.max(0, verification.literacyScore - citationPenalty(citationSummary)),
    lateralReadingTips: tips,
    warnings: [...verification.warnings, ...extraWarnings],
    durationMs: Date.now() - started,
    source,
    citations,
    citationSummary,
  };
}
