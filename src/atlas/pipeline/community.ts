import path from 'node:path';
import type { AtlasDatabase } from '../db.js';

export interface CommunityDetectionResult {
  clustersFound: number;
  filesAssigned: number;
  modularity: number;
  iterations: number;
}

export interface CommunityDetectionOptions {
  resolution?: number;
  minClusterSize?: number;
  maxIterations?: number;
}

interface EdgeRow {
  source_file: string;
  target_file: string;
  usage_count: number;
}

interface Graph {
  nodes: string[];
  adjacency: Map<string, Map<string, number>>;
  degree: Map<string, number>;
  totalWeight: number;
}

type Partition = Map<string, string>;
type MembersMap = Map<string, Set<string>>;

const EPSILON = 1e-12;
const MAX_LEVELS = 24;

function createEmptyGraph(nodes: string[]): Graph {
  const adjacency = new Map<string, Map<string, number>>();
  const degree = new Map<string, number>();
  for (const node of nodes) {
    adjacency.set(node, new Map());
    degree.set(node, 0);
  }
  return {
    nodes,
    adjacency,
    degree,
    totalWeight: 0,
  };
}

function addUndirectedEdge(graph: Graph, a: string, b: string, weight: number): void {
  if (a === b || weight <= 0) {
    return;
  }
  const aAdj = graph.adjacency.get(a);
  const bAdj = graph.adjacency.get(b);
  if (!aAdj || !bAdj) {
    return;
  }
  aAdj.set(b, (aAdj.get(b) ?? 0) + weight);
  bAdj.set(a, (bAdj.get(a) ?? 0) + weight);
}

function finalizeGraph(graph: Graph): Graph {
  let totalWeight = 0;
  for (const node of graph.nodes) {
    const neighbors = graph.adjacency.get(node)!;
    let degree = 0;
    for (const weight of neighbors.values()) {
      degree += weight;
    }
    graph.degree.set(node, degree);
  }

  for (const node of graph.nodes) {
    const neighbors = graph.adjacency.get(node)!;
    for (const [other, weight] of neighbors) {
      if (node < other) {
        totalWeight += weight;
      }
    }
  }
  graph.totalWeight = totalWeight;
  return graph;
}

function buildGraph(filePaths: string[], refs: EdgeRow[]): Graph {
  const nodeSet = new Set(filePaths);
  for (const row of refs) {
    if (row.source_file) nodeSet.add(row.source_file);
    if (row.target_file) nodeSet.add(row.target_file);
  }

  const nodes = [...nodeSet].sort((a, b) => a.localeCompare(b));
  const graph = createEmptyGraph(nodes);

  for (const row of refs) {
    const source = row.source_file.trim();
    const target = row.target_file.trim();
    if (!source || !target || source === target) {
      continue;
    }
    const weight = Number.isFinite(row.usage_count) ? Math.max(1, Math.floor(row.usage_count)) : 1;
    addUndirectedEdge(graph, source, target, weight);
  }

  return finalizeGraph(graph);
}

function singletonPartition(graph: Graph): Partition {
  const partition: Partition = new Map();
  for (const node of graph.nodes) {
    partition.set(node, node);
  }
  return partition;
}

function computeCommunityTotals(graph: Graph, partition: Partition): Map<string, number> {
  const totals = new Map<string, number>();
  for (const node of graph.nodes) {
    const community = partition.get(node)!;
    const degree = graph.degree.get(node) ?? 0;
    totals.set(community, (totals.get(community) ?? 0) + degree);
  }
  return totals;
}

function getNeighborCommunityWeights(graph: Graph, node: string, partition: Partition): Map<string, number> {
  const weights = new Map<string, number>();
  const neighbors = graph.adjacency.get(node);
  if (!neighbors) {
    return weights;
  }
  for (const [neighbor, weight] of neighbors) {
    const community = partition.get(neighbor);
    if (!community) continue;
    weights.set(community, (weights.get(community) ?? 0) + weight);
  }
  return weights;
}

function deltaModularityForMove(
  m2: number,
  gamma: number,
  nodeDegree: number,
  kiInCurrent: number,
  kiInCandidate: number,
  currentTotal: number,
  candidateTotal: number,
): number {
  if (m2 <= 0) return 0;
  const firstTerm = (2 * (kiInCandidate - kiInCurrent)) / m2;
  const secondTerm = -gamma * (
    ((candidateTotal + nodeDegree) ** 2 - candidateTotal ** 2
      + (currentTotal - nodeDegree) ** 2 - currentTotal ** 2)
    / (m2 * m2)
  );
  return firstTerm + secondTerm;
}

function runLocalMoving(graph: Graph, partition: Partition, gamma: number): boolean {
  if (graph.totalWeight <= 0) {
    return false;
  }

  const m2 = 2 * graph.totalWeight;
  const communityTotals = computeCommunityTotals(graph, partition);
  let moved = false;
  const nodes = [...graph.nodes].sort((a, b) => a.localeCompare(b));

  for (const node of nodes) {
    const currentCommunity = partition.get(node)!;
    const nodeDegree = graph.degree.get(node) ?? 0;
    const neighborWeights = getNeighborCommunityWeights(graph, node, partition);
    const candidateCommunities = new Set<string>([currentCommunity, ...neighborWeights.keys()]);

    let bestCommunity = currentCommunity;
    let bestGain = 0;
    const currentTotal = communityTotals.get(currentCommunity) ?? 0;
    const kiInCurrent = neighborWeights.get(currentCommunity) ?? 0;

    const orderedCandidates = [...candidateCommunities].sort((a, b) => a.localeCompare(b));
    for (const candidate of orderedCandidates) {
      if (candidate === currentCommunity) continue;
      const candidateTotal = communityTotals.get(candidate) ?? 0;
      const kiInCandidate = neighborWeights.get(candidate) ?? 0;
      const gain = deltaModularityForMove(
        m2,
        gamma,
        nodeDegree,
        kiInCurrent,
        kiInCandidate,
        currentTotal,
        candidateTotal,
      );
      if (gain > bestGain + EPSILON) {
        bestGain = gain;
        bestCommunity = candidate;
      }
    }

    if (bestCommunity !== currentCommunity && bestGain > EPSILON) {
      partition.set(node, bestCommunity);
      communityTotals.set(currentCommunity, currentTotal - nodeDegree);
      communityTotals.set(bestCommunity, (communityTotals.get(bestCommunity) ?? 0) + nodeDegree);
      moved = true;
    }
  }

  return moved;
}

function connectedComponentsWithinCommunity(
  graph: Graph,
  members: string[],
): string[][] {
  const memberSet = new Set(members);
  const visited = new Set<string>();
  const components: string[][] = [];

  const ordered = [...members].sort((a, b) => a.localeCompare(b));
  for (const start of ordered) {
    if (visited.has(start)) continue;
    const stack = [start];
    visited.add(start);
    const component: string[] = [];

    while (stack.length > 0) {
      const node = stack.pop()!;
      component.push(node);
      const neighbors = graph.adjacency.get(node);
      if (!neighbors) continue;
      const orderedNeighbors = [...neighbors.keys()].sort((a, b) => a.localeCompare(b));
      for (const neighbor of orderedNeighbors) {
        if (!memberSet.has(neighbor) || visited.has(neighbor)) continue;
        visited.add(neighbor);
        stack.push(neighbor);
      }
    }

    components.push(component.sort((a, b) => a.localeCompare(b)));
  }

  components.sort((a, b) => (a[0] ?? '').localeCompare(b[0] ?? ''));
  return components;
}

function refinePartition(graph: Graph, partition: Partition): { changed: boolean; partition: Partition } {
  const byCommunity = new Map<string, string[]>();
  for (const node of graph.nodes) {
    const community = partition.get(node)!;
    if (!byCommunity.has(community)) byCommunity.set(community, []);
    byCommunity.get(community)!.push(node);
  }

  const refined: Partition = new Map(partition);
  let changed = false;

  const communities = [...byCommunity.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [community, members] of communities) {
    if (members.length <= 1) continue;
    const components = connectedComponentsWithinCommunity(graph, members);
    if (components.length <= 1) continue;
    changed = true;

    for (let index = 0; index < components.length; index += 1) {
      const nodes = components[index]!;
      const nextCommunity = index === 0 ? community : `${community}::${index}`;
      for (const node of nodes) {
        refined.set(node, nextCommunity);
      }
    }
  }

  return { changed, partition: refined };
}

function computeModularity(graph: Graph, partition: Partition, gamma: number): number {
  if (graph.totalWeight <= 0) return 0;
  const m2 = 2 * graph.totalWeight;
  const totals = computeCommunityTotals(graph, partition);
  const internalDoubleByCommunity = new Map<string, number>();

  for (const node of graph.nodes) {
    const nodeCommunity = partition.get(node)!;
    const neighbors = graph.adjacency.get(node)!;
    for (const [neighbor, weight] of neighbors) {
      if (node >= neighbor) continue;
      if (partition.get(neighbor) === nodeCommunity) {
        internalDoubleByCommunity.set(nodeCommunity, (internalDoubleByCommunity.get(nodeCommunity) ?? 0) + (2 * weight));
      }
    }
  }

  let modularity = 0;
  for (const [community, total] of totals) {
    const internalDouble = internalDoubleByCommunity.get(community) ?? 0;
    modularity += (internalDouble / m2) - gamma * ((total / m2) ** 2);
  }
  return modularity;
}

function representativeMember(members: Set<string>): string {
  let first = '';
  for (const value of members) {
    if (!first || value.localeCompare(first) < 0) {
      first = value;
    }
  }
  return first;
}

function aggregateGraph(
  graph: Graph,
  partition: Partition,
  membersByNode: MembersMap,
): { graph: Graph; membersByNode: MembersMap; communities: string[] } {
  const byCommunity = new Map<string, string[]>();
  for (const node of graph.nodes) {
    const community = partition.get(node)!;
    if (!byCommunity.has(community)) byCommunity.set(community, []);
    byCommunity.get(community)!.push(node);
  }

  const communities = [...byCommunity.keys()].sort((a, b) => a.localeCompare(b));
  const communityEntries = communities.map((community) => {
    const groupMembers = new Set<string>();
    for (const node of byCommunity.get(community) ?? []) {
      const originals = membersByNode.get(node) ?? new Set<string>([node]);
      for (const file of originals) groupMembers.add(file);
    }
    return { community, members: groupMembers };
  }).sort((a, b) => representativeMember(a.members).localeCompare(representativeMember(b.members)));

  const newNodes = communityEntries.map((_, index) => `L${index}`);
  const communityToNode = new Map<string, string>();
  const newMembers: MembersMap = new Map();
  for (let index = 0; index < communityEntries.length; index += 1) {
    const entry = communityEntries[index]!;
    const nodeId = newNodes[index]!;
    communityToNode.set(entry.community, nodeId);
    newMembers.set(nodeId, entry.members);
  }

  const edgeAccumulator = new Map<string, number>();
  for (const source of graph.nodes) {
    const sourceCommunity = partition.get(source)!;
    const sourceNode = communityToNode.get(sourceCommunity)!;
    const neighbors = graph.adjacency.get(source)!;
    for (const [target, weight] of neighbors) {
      if (source >= target) continue;
      const targetCommunity = partition.get(target)!;
      const targetNode = communityToNode.get(targetCommunity)!;
      if (sourceNode === targetNode) continue;
      const [a, b] = sourceNode < targetNode ? [sourceNode, targetNode] : [targetNode, sourceNode];
      const key = `${a}\u0000${b}`;
      edgeAccumulator.set(key, (edgeAccumulator.get(key) ?? 0) + weight);
    }
  }

  const aggregated = createEmptyGraph(newNodes);
  for (const [key, weight] of edgeAccumulator) {
    const [a, b] = key.split('\u0000');
    addUndirectedEdge(aggregated, a!, b!, weight);
  }

  return {
    graph: finalizeGraph(aggregated),
    membersByNode: newMembers,
    communities: communities,
  };
}

function runLeiden(
  graph: Graph,
  options: Required<CommunityDetectionOptions>,
): { assignment: Map<string, string>; modularity: number; iterations: number } {
  if (graph.nodes.length === 0 || graph.totalWeight <= 0) {
    return { assignment: new Map(), modularity: 0, iterations: 0 };
  }

  let currentGraph = graph;
  let currentMembers: MembersMap = new Map(graph.nodes.map((node) => [node, new Set([node])]));
  let iterations = 0;
  let partition: Partition = singletonPartition(currentGraph);

  for (let level = 0; level < MAX_LEVELS; level += 1) {
    partition = singletonPartition(currentGraph);
    let changedThisLevel = false;

    for (let iter = 0; iter < options.maxIterations; iter += 1) {
      const moved = runLocalMoving(currentGraph, partition, options.resolution);
      const refined = refinePartition(currentGraph, partition);
      partition = refined.partition;
      iterations += 1;
      if (moved || refined.changed) {
        changedThisLevel = true;
      }
      if (!moved && !refined.changed) {
        break;
      }
    }

    const byCommunity = new Set<string>();
    for (const node of currentGraph.nodes) {
      byCommunity.add(partition.get(node)!);
    }

    if (!changedThisLevel || byCommunity.size >= currentGraph.nodes.length) {
      break;
    }

    const aggregated = aggregateGraph(currentGraph, partition, currentMembers);
    currentGraph = aggregated.graph;
    currentMembers = aggregated.membersByNode;

    if (currentGraph.nodes.length <= 1) {
      partition = singletonPartition(currentGraph);
      break;
    }
  }

  const assignment = new Map<string, string>();
  for (const node of currentGraph.nodes) {
    const community = partition.get(node)!;
    const originals = currentMembers.get(node) ?? new Set<string>([node]);
    for (const original of originals) {
      assignment.set(original, community);
    }
  }

  return {
    assignment,
    modularity: computeModularity(currentGraph, partition, options.resolution),
    iterations,
  };
}

function dominantDirectory(files: string[]): string | null {
  const counts = new Map<string, number>();
  for (const file of files) {
    const dir = path.posix.dirname(file).replace(/^\.\/+/, '');
    const normalized = dir === '.' ? '' : dir;
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  const ranked = [...counts.entries()].sort((a, b) => {
    if (a[1] !== b[1]) return b[1] - a[1];
    return a[0].localeCompare(b[0]);
  });
  const winner = ranked[0]?.[0] ?? '';
  return winner || null;
}

function connectedComponents(graph: Graph): string[][] {
  const visited = new Set<string>();
  const components: string[][] = [];
  const nodes = [...graph.nodes].sort((a, b) => a.localeCompare(b));

  for (const start of nodes) {
    if (visited.has(start)) continue;
    const stack = [start];
    visited.add(start);
    const component: string[] = [];

    while (stack.length > 0) {
      const node = stack.pop()!;
      component.push(node);
      const neighbors = graph.adjacency.get(node);
      if (!neighbors) continue;
      const orderedNeighbors = [...neighbors.keys()].sort((a, b) => a.localeCompare(b));
      for (const neighbor of orderedNeighbors) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        stack.push(neighbor);
      }
    }

    components.push(component.sort((a, b) => a.localeCompare(b)));
  }

  components.sort((a, b) => (a[0] ?? '').localeCompare(b[0] ?? ''));
  return components;
}

function toPathSlug(dir: string | null, fallback: string): string {
  if (!dir) return fallback;
  const trimmed = dir.replace(/^src\//, '').replace(/^\/+|\/+$/g, '');
  return trimmed.length > 0 ? trimmed : fallback;
}

function buildFallbackClusterName(filePath: string): string {
  const dir = path.posix.dirname(filePath).replace(/^\.\/+/, '');
  if (!dir || dir === '.') {
    return 'dir/root';
  }

  const parts = dir
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean);

  const deduped: string[] = [];
  for (const part of parts) {
    if (deduped[deduped.length - 1] !== part) {
      deduped.push(part);
    }
  }

  const slug = deduped.join('-').replace(/[^a-zA-Z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  return slug ? `dir/${slug}` : 'dir/root';
}

function assignClusterNames(
  communities: Map<string, string[]>,
  graph: Graph,
): Map<string, string> {
  const clusterNames = new Map<string, string>();
  const used = new Set<string>();

  const components = connectedComponents(graph);
  const fileToComponent = new Map<string, number>();
  for (let componentIndex = 0; componentIndex < components.length; componentIndex += 1) {
    const component = components[componentIndex]!;
    for (const file of component) {
      fileToComponent.set(file, componentIndex);
    }
  }

  const componentToCommunities = new Map<number, string[]>();
  for (const [communityId, files] of communities.entries()) {
    const firstFile = files[0];
    if (!firstFile) continue;
    const componentIndex = fileToComponent.get(firstFile);
    if (componentIndex == null) continue;
    if (!componentToCommunities.has(componentIndex)) componentToCommunities.set(componentIndex, []);
    componentToCommunities.get(componentIndex)!.push(communityId);
  }

  const orderedComponents = [...componentToCommunities.entries()].sort((a, b) => a[0] - b[0]);
  for (let parentOrdinal = 0; parentOrdinal < orderedComponents.length; parentOrdinal += 1) {
    const [componentIndex, communityIds] = orderedComponents[parentOrdinal]!;
    const communityFiles = communityIds.flatMap((communityId) => communities.get(communityId) ?? []);
    const parentBase = toPathSlug(
      dominantDirectory(communityFiles),
      `cluster-${parentOrdinal + 1}`,
    );

    const orderedCommunityIds = [...communityIds].sort((a, b) => {
      const aMin = (communities.get(a) ?? []).slice().sort((x, y) => x.localeCompare(y))[0] ?? '';
      const bMin = (communities.get(b) ?? []).slice().sort((x, y) => x.localeCompare(y))[0] ?? '';
      return aMin.localeCompare(bMin);
    });

    if (orderedCommunityIds.length === 1) {
      const communityId = orderedCommunityIds[0]!;
      let finalName = parentBase;
      let suffix = 2;
      while (used.has(finalName)) {
        finalName = `${parentBase}-${suffix}`;
        suffix += 1;
      }
      used.add(finalName);
      clusterNames.set(communityId, finalName);
      continue;
    }

    for (let childOrdinal = 0; childOrdinal < orderedCommunityIds.length; childOrdinal += 1) {
      const communityId = orderedCommunityIds[childOrdinal]!;
      const files = communities.get(communityId) ?? [];
      const childRaw = toPathSlug(
        dominantDirectory(files),
        `cluster-${componentIndex + 1}-${childOrdinal + 1}`,
      );

      let childBase = childRaw;
      if (childBase === parentBase || childBase.startsWith(`${parentBase}/`)) {
        childBase = `cluster-${childOrdinal + 1}`;
      }

      let finalName = `${parentBase}/${childBase}`;
      let suffix = 2;
      while (used.has(finalName)) {
        finalName = `${parentBase}/${childBase}-${suffix}`;
        suffix += 1;
      }
      used.add(finalName);
      clusterNames.set(communityId, finalName);
    }
  }

  return clusterNames;
}

export function runCommunityDetection(
  db: AtlasDatabase,
  workspace: string,
  options?: CommunityDetectionOptions,
): CommunityDetectionResult {
  const resolved: Required<CommunityDetectionOptions> = {
    resolution: options?.resolution ?? 1.0,
    minClusterSize: options?.minClusterSize ?? 2,
    maxIterations: options?.maxIterations ?? 100,
  };

  const fileRows = db.prepare(
    'SELECT file_path FROM atlas_files WHERE workspace = ? ORDER BY file_path ASC',
  ).all(workspace) as Array<{ file_path: string }>;
  const allFiles = fileRows.map((row) => row.file_path).filter((value) => value.length > 0);

  const edgeRows = db.prepare(
    `SELECT source_file, target_file, usage_count
     FROM "references"
     WHERE workspace = ?`,
  ).all(workspace) as EdgeRow[];

  const graph = buildGraph(allFiles, edgeRows);
  const leiden = runLeiden(graph, resolved);

  const communityToFiles = new Map<string, string[]>();
  for (const [filePath, communityId] of leiden.assignment.entries()) {
    if (!communityToFiles.has(communityId)) {
      communityToFiles.set(communityId, []);
    }
    communityToFiles.get(communityId)!.push(filePath);
  }

  const filteredCommunities = new Map<string, string[]>();
  for (const [communityId, files] of communityToFiles.entries()) {
    const unique = [...new Set(files)].sort((a, b) => a.localeCompare(b));
    if (unique.length >= resolved.minClusterSize) {
      filteredCommunities.set(communityId, unique);
    }
  }

  const namesByCommunity = assignClusterNames(filteredCommunities, graph);
  const fileToCluster = new Map<string, string>();
  for (const [communityId, files] of filteredCommunities.entries()) {
    const clusterName = namesByCommunity.get(communityId);
    if (!clusterName) continue;
    for (const file of files) {
      fileToCluster.set(file, clusterName);
    }
  }

  for (const filePath of allFiles) {
    if (!fileToCluster.has(filePath)) {
      fileToCluster.set(filePath, buildFallbackClusterName(filePath));
    }
  }

  const clearStmt = db.prepare(
    'UPDATE atlas_files SET cluster = NULL, updated_at = CURRENT_TIMESTAMP WHERE workspace = ?',
  );
  const setStmt = db.prepare(
    'UPDATE atlas_files SET cluster = ?, updated_at = CURRENT_TIMESTAMP WHERE workspace = ? AND file_path = ?',
  );

  const tx = db.transaction(() => {
    clearStmt.run(workspace);
    for (const [filePath, cluster] of fileToCluster.entries()) {
      setStmt.run(cluster, workspace, filePath);
    }
  });

  tx();

  return {
    clustersFound: new Set(fileToCluster.values()).size,
    filesAssigned: fileToCluster.size,
    modularity: leiden.modularity,
    iterations: leiden.iterations,
  };
}
