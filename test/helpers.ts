import type { LLMCallOptions, LLMTask, SearchHit, StructuredLLMProvider, WebSearchProvider } from '../src/core/providers.js';
import type { EvidenceNode, SourceTier, TraceResult } from '../src/core/types.js';

/** Sorguya göre önceden tanımlı sonuç döndüren sahte arama sağlayıcısı; yapılan sorguları kaydeder. */
export class FakeSearch implements WebSearchProvider {
  public readonly queries: string[] = [];
  constructor(private readonly route: (query: string) => SearchHit[] | Error) {}
  async search(query: string): Promise<SearchHit[]> {
    this.queries.push(query);
    const result = this.route(query);
    if (result instanceof Error) throw result;
    return result;
  }
}

/** Görev türüne göre yanıt veren sahte LLM; çağrıları kaydeder. */
export class FakeLLM implements StructuredLLMProvider {
  public readonly calls: Array<{ task?: LLMTask; system: string; user: string }> = [];
  constructor(private readonly responder: Partial<Record<LLMTask, (user: string) => unknown>>) {}
  async generateJSON(system: string, user: string, options?: LLMCallOptions): Promise<unknown> {
    this.calls.push({ task: options?.task, system, user });
    const fn = options?.task ? this.responder[options.task] : undefined;
    if (!fn) throw new Error(`FakeLLM: ${options?.task} için yanıt tanımlı değil`);
    const out = fn(user);
    if (out instanceof Error) throw out;
    return out;
  }
}

export const hit = (url: string, snippet: string, title = 'Başlık'): SearchHit => ({ url, title, snippet });

let counter = 0;
export function node(tier: SourceTier, overrides: Partial<EvidenceNode> = {}): EvidenceNode {
  counter++;
  return {
    id: `n${counter}`,
    url: `https://site${counter}.example/a`,
    domain: `site${counter}.example`,
    title: `Başlık ${counter}`,
    snippet: `Özet ${counter}`,
    tier,
    isTerminalProof: tier === 'TIER_1_TERMINAL_PROOF',
    hopDepth: 0,
    ...overrides,
  };
}

export function trace(nodes: EvidenceNode[], overrides: Partial<TraceResult> = {}): TraceResult {
  return {
    nodes,
    edges: [],
    stopReason: 'MAX_DEPTH_EXCEEDED',
    uniqueClusterCount: nodes.length,
    rawResultCount: nodes.length,
    isEchoChamber: false,
    warnings: [],
    ...overrides,
  };
}
