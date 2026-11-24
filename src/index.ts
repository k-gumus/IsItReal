import 'dotenv/config';
import { GeminiJSONProvider } from './adapters/gemini.js';
import { TavilySearchProvider } from './adapters/tavily.js';
import { verifyContent } from './core/pipeline.js';

async function main() {
  const input =
    process.argv.slice(2).join(' ') ||
    'Uzmanlar uyardı! Yeni düzenlemeyle tüm elektronik cihazlara %50 ek vergi kesinleşti.';

  const tavilyKey = process.env.TAVILY_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;

  if (!tavilyKey || !geminiKey) {
    console.error('Hata: .env dosyasında TAVILY_API_KEY ve GEMINI_API_KEY tanımlı olmalıdır.');
    process.exit(1);
  }

  const report = await verifyContent(input, {
    searchProvider: new TavilySearchProvider(tavilyKey),
    llm: new GeminiJSONProvider(geminiKey),
    tracerConfig: {
      maxDepth: 2,
      googleFactCheckApiKey: process.env.GOOGLE_FACTCHECK_API_KEY,
      languageCode: 'tr',
    },
  });

  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
