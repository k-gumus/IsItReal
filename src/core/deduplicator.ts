import { EvidenceNode } from './types';

function tokenizeShingles(text: string, k = 3): Set<string> {
  const normalized = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
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

/**
 * Benzerlik eşiği (0.55) üzerindeki metinleri aynı "syndication" kümesine atar.
 * Her kümeden en yüksek otoriteye sahip düğümü temsilci olarak bırakır.
 */
export function clusterEchoChambers(
  nodes: EvidenceNode[],
  similarityThreshold = 0.55
): {
  clusteredNodes: EvidenceNode[];
  uniqueClusterCount: number;
  isEchoChamber: boolean;
} {
  const shinglesMap = new Map<string, Set<string>>();
  for (const node of nodes) {
    shinglesMap.set(node.id, tokenizeShingles(`${node.title} ${node.snippet}`));
  }

  const clusters: EvidenceNode[][] = [];

  for (const node of nodes) {
    const currentShingles = shinglesMap.get(node.id)!;
    let placed = false;

    for (const cluster of clusters) {
      const representative = cluster[0];
      const repShingles = shinglesMap.get(representative.id)!;
      if (jaccardSimilarity(currentShingles, repShingles) >= similarityThreshold) {
        cluster.push(node);
        placed = true;
        break;
      }
    }

    if (!placed) {
      clusters.push([node]);
    }
  }

  const clusteredNodes: EvidenceNode[] = [];
  clusters.forEach((cluster, idx) => {
    const clusterId = `cluster_${idx + 1}`;
    for (const item of cluster) {
      clusteredNodes.push({ ...item, clusterId });
    }
  });

  // 4 veya daha fazla sonuç bulunup bunların %70'inden fazlası tek bir kopya kümesine yığılıyorsa yankı odasıdır
  const largestClusterSize = clusters.reduce((max, c) => Math.max(max, c.length), 0);
  const isEchoChamber =
    nodes.length >= 4 && largestClusterSize / nodes.length >= 0.7 && clusters.length <= 2;

  return {
    clusteredNodes,
    uniqueClusterCount: clusters.length,
    isEchoChamber,
  };
}
