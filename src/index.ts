import 'dotenv/config';
import { createEngineDeps } from './config.js';
import { InputError, verifyContent } from './core/pipeline.js';

const DEFAULT_INPUT = 'Uzmanlar uyardı! Yeni düzenlemeyle tüm elektronik cihazlara %50 ek vergi kesinleşti.';

async function main() {
  const args = process.argv.slice(2);
  const demo = args.includes('--demo');
  const json = args.includes('--json');
  const input = args.filter((a) => !a.startsWith('--')).join(' ') || DEFAULT_INPUT;

  const deps = createEngineDeps(process.env, demo);
  if (deps.mode === 'demo' && !demo) {
    console.error('Not: TAVILY_API_KEY / GEMINI_API_KEY bulunamadı, kurgusal demo verisiyle çalışılıyor.\n');
  }

  const report = await verifyContent(input, {
    ...deps,
    onProgress: json
      ? undefined
      : (e) => {
          if (e.type === 'stage') console.error(`» ${e.message}`);
          if (e.type === 'search') console.error(`  ⌕ [${e.claimId} · atlama ${e.hop}] ${e.query}`);
          if (e.type === 'pointer') console.error(`  ↳ kök kanıt işaretçisi: ${e.pointer}`);
        },
  });

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`\nGenel karar: ${report.overallVerdict}  ·  Okuryazarlık puanı: ${report.literacyScore}/100  ·  ${report.durationMs} ms (${report.mode})`);
  for (const c of report.claims) {
    console.log(`\n• ${c.claimText}\n  → ${c.verdict} (%${Math.round(c.confidence * 100)}) · ${c.stopReason} · ${c.uniqueClusterCount} bağımsız küme / ${c.rawResultCount} kaynak`);
    console.log(`  ${c.reasoning}`);
    if (c.guardrailNote) console.log(`  ⚠ ${c.guardrailNote}`);
  }
  if (report.manipulationSignals.length) {
    console.log('\nManipülasyon sinyalleri:');
    report.manipulationSignals.forEach((s) => console.log(`  - ${s.type}: "${s.excerpt}"`));
  }
  if (report.warnings.length) {
    console.log('\nUyarılar:');
    report.warnings.forEach((w) => console.log(`  - ${w}`));
  }
}

main().catch((err) => {
  console.error(err instanceof InputError ? `Hata: ${err.message}` : err);
  process.exit(1);
});
