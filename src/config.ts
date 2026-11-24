import { DemoLLMProvider, DemoPageExtractor, DemoSearchProvider } from './adapters/demo.js';
import { OpenDoiResolver, RoutingDoiResolver } from './adapters/doi.js';
import { DEFAULT_GEMINI_MODEL, GeminiJSONProvider } from './adapters/gemini.js';
import { GoogleFactCheckProvider } from './adapters/google-factcheck.js';
import { TavilyExtractor, TavilySearchProvider } from './adapters/tavily.js';
import type { AnalyzeDeps } from './core/analyze.js';

export type EngineDeps = Omit<AnalyzeDeps, 'onProgress'> & { mode: 'live' | 'demo' };

/**
 * Ortam değişkenlerinden sağlayıcıları kurar.
 * TAVILY_API_KEY ve GEMINI_API_KEY yoksa (veya demo istendiyse) arama/dil modeli için demo moduna düşer.
 * DOI denetimi anahtar gerektirmeyen açık servislerle (Crossref, doi.org, DataCite) her iki modda da gerçektir;
 * yalnızca 10.5555/demo.* önekli kurgusal DOI'ler demo kayıtlardan yanıtlanır.
 */
export function createEngineDeps(env: NodeJS.ProcessEnv = process.env, forceDemo = false): EngineDeps {
  const maxDepth = Number.parseInt(env.MAX_DEPTH ?? '2', 10);
  const tracerConfig = { maxDepth: Number.isFinite(maxDepth) ? maxDepth : 2, languageCode: env.LANGUAGE_CODE ?? 'tr' };
  const doiResolver = new RoutingDoiResolver(new OpenDoiResolver(env.CROSSREF_MAILTO?.trim() || undefined));

  const tavilyKey = env.TAVILY_API_KEY?.trim();
  const geminiKey = env.GEMINI_API_KEY?.trim();
  const looksPlaceholder = (k?: string) => !k || /x{8,}/i.test(k);

  if (forceDemo || env.DEMO_MODE === '1' || looksPlaceholder(tavilyKey) || looksPlaceholder(geminiKey)) {
    const latency = Number.parseInt(env.DEMO_LATENCY_MS ?? '450', 10);
    return {
      mode: 'demo',
      searchProvider: new DemoSearchProvider(latency),
      llm: new DemoLLMProvider(latency),
      pageExtractor: new DemoPageExtractor(latency),
      doiResolver,
      tracerConfig,
    };
  }

  const factKey = env.GOOGLE_FACTCHECK_API_KEY?.trim();
  return {
    mode: 'live',
    searchProvider: new TavilySearchProvider(tavilyKey!, { searchDepth: env.TAVILY_SEARCH_DEPTH === 'basic' ? 'basic' : 'advanced' }),
    pageExtractor: new TavilyExtractor(tavilyKey!),
    llm: new GeminiJSONProvider(geminiKey!, env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL),
    factCheckProvider: looksPlaceholder(factKey) ? undefined : new GoogleFactCheckProvider(factKey!),
    doiResolver,
    tracerConfig,
  };
}
