import * as db from './db.js';
import type { AtlasFileRecord, AtlasFileWitnessRecord } from './types.js';

export interface AtlasDbReadOptions {
  dbPath: string;
  cwd?: string;
}

export type AtlasDbTarget = db.AtlasDatabase | AtlasDbReadOptions;

function isAtlasDatabase(target: AtlasDbTarget): target is db.AtlasDatabase {
  return typeof (target as { prepare?: unknown }).prepare === 'function';
}

async function withAtlasDb<T>(target: AtlasDbTarget, fn: (atlasDb: db.AtlasDatabase) => T): Promise<T> {
  if (isAtlasDatabase(target)) {
    return fn(target);
  }

  const readonlyDb = db.openReadonlyAtlasBridgeDb(target.dbPath);
  if (!readonlyDb) {
    throw new Error(`Unable to open Atlas database for readonly access: ${target.dbPath}`);
  }

  try {
    return fn(readonlyDb);
  } finally {
    readonlyDb.close();
  }
}

function requireWritableHandle(target: AtlasDbTarget): db.AtlasDatabase {
  if (isAtlasDatabase(target)) {
    return target;
  }
  throw new Error('This dbAsync operation requires an open AtlasDatabase handle.');
}

export async function getAtlasFileAsync(workspace: string, filePath: string, target: AtlasDbTarget): Promise<AtlasFileRecord | null> {
  return withAtlasDb(target, (atlasDb) => db.getAtlasFile(atlasDb, workspace, filePath));
}

export async function listAtlasFilesAsync(workspace: string, target: AtlasDbTarget): Promise<AtlasFileRecord[]> {
  return withAtlasDb(target, (atlasDb) => db.listAtlasFiles(atlasDb, workspace));
}

export async function lookupSnapshotAsync(workspace: string, filePath: string, at: number | null, target: AtlasDbTarget): Promise<string | null> {
  return withAtlasDb(target, (atlasDb) => db.lookupSnapshot(atlasDb, filePath, workspace, at));
}

export async function lookupSnapshotRecordAsync(workspace: string, filePath: string, at: number | null, target: AtlasDbTarget): Promise<db.AtlasFileSnapshot | null> {
  return withAtlasDb(target, (atlasDb) => db.lookupSnapshotRecord(atlasDb, filePath, workspace, at));
}

export async function listClusterFilesAsync(workspace: string, cluster: string | null, target: AtlasDbTarget): Promise<AtlasFileRecord[]> {
  return withAtlasDb(target, (atlasDb) => (
    cluster == null ? db.listAtlasFiles(atlasDb, workspace) : db.listClusterFiles(atlasDb, workspace, cluster)
  ));
}

export async function listPatternFilesAsync(workspace: string, pattern: string, target: AtlasDbTarget, limit?: number): Promise<AtlasFileRecord[]> {
  return withAtlasDb(target, (atlasDb) => db.listPatternFiles(atlasDb, workspace, pattern, limit));
}

export async function aggregatePatternCountsAsync(workspace: string, target: AtlasDbTarget, limit?: number): Promise<db.AtlasPatternCountEntry[]> {
  return withAtlasDb(target, (atlasDb) => db.aggregatePatternCounts(atlasDb, workspace, limit));
}

export async function countDistinctPatternsAsync(workspace: string, target: AtlasDbTarget): Promise<number> {
  return withAtlasDb(target, (atlasDb) => db.countDistinctPatterns(atlasDb, workspace));
}

export async function listAtlasFileWitnessesAsync(workspace: string, filePath: string, target: AtlasDbTarget, limit?: number): Promise<AtlasFileWitnessRecord[]> {
  return withAtlasDb(target, (atlasDb) => db.listAtlasFileWitnesses(atlasDb, workspace, filePath, limit));
}

export async function listSymbolIdentitiesAsync(workspace: string, filePath: string, target: AtlasDbTarget): Promise<db.AtlasSymbolIdentityRecord[]> {
  return withAtlasDb(target, (atlasDb) => db.listSymbolIdentities(atlasDb, workspace, filePath));
}

export async function listImportsAsync(workspace: string, filePath: string, target: AtlasDbTarget): Promise<string[]> {
  return withAtlasDb(target, (atlasDb) => db.listImports(atlasDb, workspace, filePath));
}

export async function listImportedByAsync(workspace: string, filePath: string, target: AtlasDbTarget): Promise<string[]> {
  return withAtlasDb(target, (atlasDb) => db.listImportedBy(atlasDb, workspace, filePath));
}

export async function listImportEdgesAsync(workspace: string, target: AtlasDbTarget): Promise<db.AtlasImportEdgeRecord[]> {
  return withAtlasDb(target, (atlasDb) => db.listImportEdges(atlasDb, workspace));
}

export async function listSymbolsAsync(workspace: string, target: AtlasDbTarget, filePath?: string): Promise<db.AtlasSymbolRecord[]> {
  return withAtlasDb(target, (atlasDb) => db.listSymbols(atlasDb, workspace, filePath));
}

export async function listReferencesAsync(workspace: string, target: AtlasDbTarget, sourceFile?: string): Promise<db.AtlasReferenceRecord[]> {
  return withAtlasDb(target, (atlasDb) => db.listReferences(atlasDb, workspace, sourceFile));
}

export async function searchFtsAsync(workspace: string, query: string, target: AtlasDbTarget, limit?: number): Promise<db.AtlasSearchHit[]> {
  return withAtlasDb(target, (atlasDb) => db.searchFts(atlasDb, workspace, query, limit));
}

export async function searchAtlasFilesAsync(workspace: string, query: string, target: AtlasDbTarget, limit?: number): Promise<AtlasFileRecord[]> {
  return withAtlasDb(target, (atlasDb) => db.searchAtlasFiles(atlasDb, workspace, query, limit));
}

export async function searchVectorAsync(workspace: string, embedding: number[], target: AtlasDbTarget, limit?: number): Promise<db.AtlasSearchHit[]> {
  return withAtlasDb(target, (atlasDb) => db.searchVector(atlasDb, workspace, embedding, limit));
}

export async function getAtlasEmbeddingAsync(workspace: string, filePath: string, target: AtlasDbTarget): Promise<number[] | null> {
  return withAtlasDb(target, (atlasDb) => db.getAtlasEmbedding(atlasDb, workspace, filePath));
}

export async function queryAtlasChangelogAsync(workspace: string, query: db.AtlasChangelogQuery, target: AtlasDbTarget): Promise<db.AtlasChangelogRecord[]> {
  return withAtlasDb(target, (atlasDb) => db.queryAtlasChangelog(atlasDb, { ...query, workspace }));
}

export async function countAtlasChangelogAsync(workspace: string, query: db.AtlasChangelogQuery, target: AtlasDbTarget): Promise<db.AtlasChangelogStats> {
  return withAtlasDb(target, (atlasDb) => db.countAtlasChangelog(atlasDb, { ...query, workspace }));
}

export async function groupAtlasChangelogAsync(workspace: string, query: db.AtlasChangelogQuery, groupBy: string, target: AtlasDbTarget, limit?: number): Promise<db.AtlasChangelogGroupEntry[]> {
  return withAtlasDb(target, (atlasDb) => db.groupAtlasChangelog(atlasDb, { ...query, workspace }, groupBy, limit));
}

export async function countAtlasChangelogGroupsAsync(workspace: string, query: db.AtlasChangelogQuery, groupBy: string, target: AtlasDbTarget): Promise<number> {
  return withAtlasDb(target, (atlasDb) => db.countAtlasChangelogGroups(atlasDb, { ...query, workspace }, groupBy));
}

export async function timelineAtlasChangelogAsync(workspace: string, query: db.AtlasChangelogQuery, bucket: 'day' | 'week' | 'month', target: AtlasDbTarget): Promise<db.AtlasChangelogTimelineBucket[]> {
  return withAtlasDb(target, (atlasDb) => db.timelineAtlasChangelog(atlasDb, { ...query, workspace }, bucket));
}

export async function getFilePhaseAsync(workspace: string, filePath: string, currentHash: string, target: AtlasDbTarget): Promise<'none' | 'structure' | 'crossref'> {
  return withAtlasDb(target, (atlasDb) => db.getFilePhase(atlasDb, workspace, filePath, currentHash));
}

export async function atlasCrossrefCountAsync(workspace: string, target: AtlasDbTarget): Promise<number> {
  return withAtlasDb(target, (atlasDb) => db.listReferences(atlasDb, workspace).length);
}

export async function deleteAtlasFileAsync(workspace: string, filePath: string, target: AtlasDbTarget): Promise<boolean> {
  const atlasDb = requireWritableHandle(target);
  return db.deleteAtlasFile(atlasDb, workspace, filePath);
}

export async function enqueueReextractAsync(workspace: string, filePath: string, target: AtlasDbTarget): Promise<void> {
  const atlasDb = requireWritableHandle(target);
  db.enqueueReextract(atlasDb, workspace, filePath);
}

export async function upsertFileRecordAsync(workspace: string, file: db.AtlasFileUpsertInput, target: AtlasDbTarget): Promise<void> {
  const atlasDb = requireWritableHandle(target);
  db.upsertFileRecord(atlasDb, { ...file, workspace });
}

export async function insertAtlasChangelogAsync(workspace: string, changelog: db.AtlasChangelogInsertInput, target: AtlasDbTarget): Promise<number> {
  const atlasDb = requireWritableHandle(target);
  return db.insertAtlasChangelog(atlasDb, { ...changelog, workspace }).id;
}

export async function markChangelogVerificationAsync(workspace: string, changelogId: number, status: string, evidence: string, target: AtlasDbTarget): Promise<number> {
  const atlasDb = requireWritableHandle(target);
  const result = db.updateChangelogVerification(atlasDb, workspace, {
    changelogIds: [changelogId],
    status,
    notes: evidence,
  });
  return result.updated;
}

export async function insertSnapshotAsync(workspace: string, filePath: string, content: string, changelogId: number | null, target: AtlasDbTarget): Promise<db.AtlasFileSnapshot | null> {
  const atlasDb = requireWritableHandle(target);
  return db.insertSnapshot(atlasDb, filePath, workspace, content, changelogId);
}

export async function pruneSnapshotsAsync(workspace: string, filePath: string, target: AtlasDbTarget, keepLimit?: number): Promise<number> {
  const atlasDb = requireWritableHandle(target);
  return db.pruneSnapshots(atlasDb, filePath, workspace, keepLimit);
}
