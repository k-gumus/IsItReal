import { DemoLLMProvider, DemoSearchProvider } from './adapters/demo.js';
import { DEFAULT_GEMINI_MODEL, GeminiJSONProvider } from './adapters/gemini.js';
import { GoogleFactCheckProvider } from './adapters/google-factcheck.js';
import { TavilySearchProvider } from './adapters/tavily.js';
import type { VerifyDeps } from './core/pipeline.js';

export type EngineDeps = Omit<VerifyDeps, 'onProgress'> & { mode: 'live' | 'demo' };

/**
 * Ortam değişkenlerinden sağlayıcıları kurar.
 * TAVILY_API_KEY ve GEMINI_API_KEY yoksa (veya demo istendiyse) çevrimdışı demo moduna düşer.
 */
export function createEngineDeps(env: NodeJS.ProcessEnv = process.env, forceDemo = false): EngineDeps {
  const maxDepth = Number.parseInt(env.MAX_DEPTH ?? '2', 10);
  const tracerConfig = { maxDepth: Number.isFinite(maxDepth) ? maxDepth : 2, languageCode: env.LANGUAGE_CODE ?? 'tr' };

  const tavilyKey = env.TAVILY_API_KEY?.trim();
  const geminiKey = env.GEMINI_API_KEY?.trim();
  const looksPlaceholder = (k?: string) => !k || /x{8,}/i.test(k);

  if (forceDemo || env.DEMO_MODE === '1' || looksPlaceholder(tavilyKey) || looksPlaceholder(geminiKey)) {
    const latency = Number.parseInt(env.DEMO_LATENCY_MS ?? '450', 10);
    return {
      mode: 'demo',
      searchProvider: new DemoSearchProvider(latency),
      llm: new DemoLLMProvider(latency),
      tracerConfig,
    };
  }

  const factKey = env.GOOGLE_FACTCHECK_API_KEY?.trim();
  return {
    mode: 'live',
    searchProvider: new TavilySearchProvider(tavilyKey!, { searchDepth: env.TAVILY_SEARCH_DEPTH === 'basic' ? 'basic' : 'advanced' }),
    llm: new GeminiJSONProvider(geminiKey!, env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL),
    factCheckProvider: looksPlaceholder(factKey) ? undefined : new GoogleFactCheckProvider(factKey!),
    tracerConfig,
  };
}
