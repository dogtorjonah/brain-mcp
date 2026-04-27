export interface AtlasPublicApiEntry {
  name: string;
  type: string;
  signature?: string;
  description?: string;
}

export interface AtlasKeyTypeEntry {
  name: string;
  kind: string;
  exported: boolean;
  description?: string;
}

/**
 * AI-curated source code snippet. During atlas_commit, the agent selects the
 * most important/relevant sections of the file — potentially disjointed segments
 * from a large file. This replaces naive top-N line truncation with intelligent
 * curation by the agent that has maximum context.
 *
 * Snippets are numbered for referencing: changelog entries can say "refer to snippet 3".
 */
export interface SourceHighlight {
  /** 1-indexed snippet number for referencing ("see snippet 3") */
  id: number;
  /** Optional description ("main export", "error handling", "config parsing") */
  label?: string;
  /** 1-indexed start line in the source file */
  startLine: number;
  /** 1-indexed end line in the source file */
  endLine: number;
  /** The actual source code text of this segment */
  content: string;
}

export type AtlasSourceChunkKind = 'highlight' | 'raw';

export interface AtlasSourceChunk {
  kind: AtlasSourceChunkKind;
  label: string | null;
  startLine: number;
  endLine: number;
  content: string;
  textHash: string;
}

export interface AtlasFileExtraction {
  purpose: string;
  public_api: AtlasPublicApiEntry[];
  exports?: Array<{ name: string; type: string }>;
  patterns: string[];
  dependencies: Record<string, unknown>;
  data_flows: string[];
  key_types: AtlasKeyTypeEntry[];
  hazards: string[];
  conventions: string[];
}

export interface AtlasCrossRefCallSite {
  file: string;
  usage_type: string;
  count: number;
  context: string;
}

export interface AtlasCrossRefSymbol {
  type: string;
  call_sites: AtlasCrossRefCallSite[];
  total_usages: number;
  blast_radius: string;
}

export interface AtlasCrossRefs {
  symbols: Record<string, AtlasCrossRefSymbol>;
  total_exports_analyzed: number;
  total_cross_references: number;
  crossref_model?: string;
  crossref_timestamp?: string;
}

export interface AtlasFileRecord {
  id: number;
  workspace: string;
  file_path: string;
  file_hash: string | null;
  cluster: string | null;
  loc: number;
  blurb: string;
  purpose: string;
  public_api: unknown[];
  exports: Array<{ name: string; type: string }>;
  patterns: string[];
  dependencies: Record<string, unknown>;
  data_flows: string[];
  key_types: unknown[];
  hazards: string[];
  conventions: string[];
  cross_refs: AtlasCrossRefs | null;
  source_highlights: SourceHighlight[];
  language: string;
  extraction_model: string | null;
  last_extracted: string | null;
}

export interface AtlasEmbeddingRecord {
  file_id: number;
  embedding: Buffer | string;
}

export interface AtlasQueueRecord {
  id: number;
  workspace: string;
  file_path: string;
  trigger_reason: string;
  queued_at: string;
  started_at: string | null;
  completed_at: string | null;
  status: string;
  error_message: string | null;
}

export interface AtlasMetaRecord {
  workspace: string;
  source_root: string;
  brain_version: string | null;
  updated_at: string;
}

export interface AtlasServerConfig {
  workspace: string;
  sourceRoot: string;
  dbPath: string;
  concurrency: number;
  sqliteVecExtension: string;
  embeddingModel: string;
  embeddingDimensions: number;
  force?: boolean;
}

export interface AtlasCommitEdgeEmitter {
  emitCommitEdges(opts: {
    identityName: string;
    workspace: string;
    filePath: string;
    changelogId: number;
    sessionId?: string;
    hazardsAdded?: string[];
    hazardsRemoved?: string[];
    patternsAdded?: string[];
    patternsRemoved?: string[];
  }): unknown;
}

export interface AtlasRuntime {
  config: AtlasServerConfig;
  db: import('./db.js').AtlasDatabase;
  server?: import('@modelcontextprotocol/sdk/server/mcp.js').McpServer;
  edgeEmitter?: AtlasCommitEdgeEmitter;
}
