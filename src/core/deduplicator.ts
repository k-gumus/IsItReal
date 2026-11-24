import { tierRank } from './authority.js';
import type { EvidenceNode } from './types.js';

export function tokenizeShingles(text: string, k = 3): Set<string> {
  const normalized = text
    .toLocaleLowerCase('tr-TR')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const words = normalized.split(' ').filter((w) => w.length > 2);
  const shingles = new Set<string>();

  if (words.length < k) {
    if (words.length > 0) shingles.add(words.join(' '));
    return shingles;
  }

  for (let i = 0; i <= words.length - k; i++) {
    shingles.add(words.slice(i, i + k).join(' '));
  }
  return shingles;
}

export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export interface ClusterResult {
  clusteredNodes: EvidenceNode[];
  uniqueClusterCount: number;
  isEchoChamber: boolean;
}

/**
 * Benzerlik eşiği üzerindeki metinleri aynı "syndication" (kopya haber) kümesine atar.
 * Tek bağlantılı kümeleme kullanır: bir metin kümedeki herhangi bir üyeye yeterince benziyorsa o kümeye girer
 * (A→B→C şeklinde zincirleme kopyaları da yakalar).
 * Her kümede en yüksek otoriteye sahip düğüm temsilci olarak işaretlenir.
 */
export function clusterEchoChambers(nodes: EvidenceNode[], similarityThreshold = 0.55): ClusterResult {
  const shingles = new Map<string, Set<string>>();
  for (const node of nodes) {
    shingles.set(node.id, tokenizeShingles(`${node.title} ${node.snippet}`));
  }

  const clusters: EvidenceNode[][] = [];

  for (const node of nodes) {
    const current = shingles.get(node.id) ?? new Set<string>();
    const target = clusters.find((cluster) =>
      cluster.some((member) => jaccardSimilarity(current, shingles.get(member.id) ?? new Set()) >= similarityThreshold)
    );
    if (target) target.push(node);
    else clusters.push([node]);
  }

  const clusteredNodes: EvidenceNode[] = [];
  clusters.forEach((cluster, idx) => {
    const clusterId = `cluster_${idx + 1}`;
    const representative = [...cluster].sort((a, b) => tierRank(a.tier) - tierRank(b.tier))[0];
    for (const item of cluster) {
      clusteredNodes.push({ ...item, clusterId, isClusterRepresentative: item.id === representative?.id });
    }
  });

  // En az 4 sonuç varsa ve bunların %70'i tek bir kopya kümesine yığılmışsa (en fazla 2 küme) yankı odasıdır
  const largestClusterSize = clusters.reduce((max, c) => Math.max(max, c.length), 0);
  const isEchoChamber = nodes.length >= 4 && largestClusterSize / nodes.length >= 0.7 && clusters.length <= 2;

  return { clusteredNodes, uniqueClusterCount: clusters.length, isEchoChamber };
}
