import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AtlasFileRecord, AtlasSourceChunk, SourceHighlight } from '../types.js';
import type { AtlasFileUpsertInput } from '../db.js';

const RAW_SOURCE_CHUNK_MAX_LINES = 80;
const RAW_SOURCE_CHUNK_MIN_LINES = 20;
const RAW_SOURCE_CHUNK_TARGET_CHARS = 2400;
const RAW_SOURCE_CHUNK_OVERLAP_LINES = 12;

export async function readSourceFile(sourceRoot: string, filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(sourceRoot, filePath), 'utf8');
  } catch {
    return null;
  }
}

export function toFileUpsertInput(
  file: AtlasFileRecord,
  patch: Partial<AtlasFileUpsertInput>,
): AtlasFileUpsertInput {
  return {
    workspace: file.workspace,
    file_path: file.file_path,
    file_hash: patch.file_hash ?? file.file_hash,
    cluster: patch.cluster ?? file.cluster,
    loc: patch.loc ?? file.loc,
    blurb: patch.blurb ?? file.blurb,
    purpose: patch.purpose ?? file.purpose,
    public_api: patch.public_api ?? file.public_api,
    exports: patch.exports ?? file.exports,
    patterns: patch.patterns ?? file.patterns,
    dependencies: patch.dependencies ?? file.dependencies,
    data_flows: patch.data_flows ?? file.data_flows,
    key_types: patch.key_types ?? file.key_types,
    hazards: patch.hazards ?? file.hazards,
    conventions: patch.conventions ?? file.conventions,
    cross_refs: patch.cross_refs ?? file.cross_refs,
    source_highlights: patch.source_highlights ?? file.source_highlights,
    language: patch.language ?? file.language,
    extraction_model: patch.extraction_model ?? file.extraction_model,
    last_extracted: patch.last_extracted ?? file.last_extracted,
  };
}

export function buildEmbeddingInput(file: AtlasFileRecord): string {
  return [
    file.purpose,
    file.blurb,
    file.patterns.join(', '),
    file.hazards.join(', '),
  ].filter((part) => part.trim().length > 0).join('\n');
}

function hashChunkText(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

function normalizeChunkContent(content: string): string {
  return content.replace(/\n+$/u, '');
}

function toHighlightChunk(highlight: SourceHighlight): AtlasSourceChunk | null {
  const content = normalizeChunkContent(highlight.content);
  if (!content.trim()) {
    return null;
  }
  return {
    kind: 'highlight',
    label: highlight.label?.trim() || `snippet ${highlight.id}`,
    startLine: highlight.startLine,
    endLine: highlight.endLine,
    content,
    textHash: hashChunkText(content),
  };
}

export function buildHighlightSourceChunks(file: AtlasFileRecord): AtlasSourceChunk[] {
  return file.source_highlights
    .map(toHighlightChunk)
    .filter((chunk): chunk is AtlasSourceChunk => chunk != null);
}

export function buildRawSourceChunks(source: string): AtlasSourceChunk[] {
  const lines = source.split('\n');
  const chunks: AtlasSourceChunk[] = [];
  let startIndex = 0;

  while (startIndex < lines.length) {
    let endIndex = Math.min(lines.length, startIndex + RAW_SOURCE_CHUNK_MAX_LINES);
    let content = normalizeChunkContent(lines.slice(startIndex, endIndex).join('\n'));

    while (
      content.length > RAW_SOURCE_CHUNK_TARGET_CHARS
      && endIndex - startIndex > RAW_SOURCE_CHUNK_MIN_LINES
    ) {
      endIndex -= 5;
      content = normalizeChunkContent(lines.slice(startIndex, endIndex).join('\n'));
    }

    if (!content.trim()) {
      startIndex = endIndex;
      continue;
    }

    chunks.push({
      kind: 'raw',
      label: null,
      startLine: startIndex + 1,
      endLine: endIndex,
      content,
      textHash: hashChunkText(content),
    });

    if (endIndex >= lines.length) {
      break;
    }

    const nextStart = Math.max(startIndex + 1, endIndex - RAW_SOURCE_CHUNK_OVERLAP_LINES);
    startIndex = nextStart > startIndex ? nextStart : endIndex;
  }

  return chunks;
}

export async function buildSourceChunks(
  sourceRoot: string,
  file: AtlasFileRecord,
): Promise<AtlasSourceChunk[]> {
  const highlightChunks = buildHighlightSourceChunks(file);
  if (highlightChunks.length > 0) {
    return highlightChunks;
  }

  const source = await readSourceFile(sourceRoot, file.file_path);
  if (!source) {
    return [];
  }
  return buildRawSourceChunks(source);
}
