import { extractText, getDocumentProxy, getMeta } from 'unpdf';
import { extractDois } from '../core/input.js';

export interface PdfExtraction {
  pages: number;
  text: string;
  title?: string;
  dois: string[];
}

export class PdfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PdfError';
  }
}

export const MAX_PDF_BYTES = 15 * 1024 * 1024;
const MAX_PAGES = 80;

/** PDF'ten düz metin ve içindeki DOI'leri çıkarır. Taranmış (görüntü) PDF'lerde metin boş döner. */
export async function extractPdf(bytes: Uint8Array): Promise<PdfExtraction> {
  if (bytes.byteLength === 0) throw new PdfError('Dosya boş.');
  if (bytes.byteLength > MAX_PDF_BYTES) throw new PdfError('PDF en fazla 15 MB olabilir.');
  // %PDF imzası ilk 1024 bayt içinde olmalı
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  if (!head.includes('%PDF-')) throw new PdfError('Bu dosya bir PDF değil.');

  let pdf;
  try {
    pdf = await getDocumentProxy(new Uint8Array(bytes));
  } catch {
    throw new PdfError('PDF açılamadı; dosya bozuk ya da şifreli olabilir.');
  }

  try {
    if (pdf.numPages > MAX_PAGES) throw new PdfError(`PDF en fazla ${MAX_PAGES} sayfa olabilir (bu dosya ${pdf.numPages} sayfa).`);
    const { text } = await extractText(pdf, { mergePages: true });
    let title: string | undefined;
    try {
      const meta = await getMeta(pdf);
      const t = (meta.info as { Title?: unknown } | undefined)?.Title;
      if (typeof t === 'string' && t.trim().length > 3) title = t.trim().slice(0, 200);
    } catch {
      // üst veri isteğe bağlı
    }
    const clean = text.replace(/\u0000/g, '').trim();
    return { pages: pdf.numPages, text: clean, title, dois: extractDois(clean) };
  } finally {
    await Promise.resolve(pdf.cleanup?.()).catch(() => {});
  }
}
