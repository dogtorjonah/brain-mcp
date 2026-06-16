import type { AtlasCommitRequiredMetadataField } from './commitIdentityValidation.js';

export interface DerivedSourceHighlight {
  label: string;
  startLine: number;
  endLine: number;
}

export interface DerivedCommitCandidates {
  purpose?: string;
  blurb?: string;
  tags?: string[];
  source_highlights?: DerivedSourceHighlight[];
}

function wordsFromPath(filePath: string): string[] {
  return filePath
    .replace(/\.[^.]+$/, '')
    .split(/[/?#\\._-]+/g)
    .map((part) => part.trim())
    .filter(Boolean);
}

function deriveTags(filePath: string, cluster?: string | null, language?: string | null): string[] {
  const tags = new Set<string>();
  const normalized = filePath.replace(/\\/g, '/');
  const first = normalized.split('/')[0];
  if (first) tags.add(first);
  if (normalized.includes('/atlas/')) tags.add('atlas');
  if (normalized.includes('/tools/')) tags.add('mcp-tool');
  if (normalized.includes('/migrations/')) tags.add('migration');
  if (normalized.includes('/tests/') || /\.test\.[cm]?tsx?$/.test(normalized)) tags.add('test');
  if (/types?\.[cm]?ts$/.test(normalized)) tags.add('types');
  const clusterStem = cluster?.split(/[/:]/g).filter(Boolean).at(-1);
  if (clusterStem) tags.add(clusterStem);
  if (language) tags.add(language);
  return Array.from(tags).slice(0, 7);
}

function deriveIdentityText(filePath: string): Pick<DerivedCommitCandidates, 'purpose' | 'blurb'> {
  const words = wordsFromPath(filePath);
  const subject = words.length > 0 ? words.join(' ') : filePath;
  return {
    purpose: `Maintains ${subject} behavior and related integration points for the local brain-mcp Atlas memory layer.`,
    blurb: `${subject} support for brain-mcp Atlas`,
  };
}

function deriveSourceHighlights(source: string | undefined): DerivedSourceHighlight[] | undefined {
  if (!source) return undefined;
  const lines = source.split(/\r?\n/);
  const candidates: DerivedSourceHighlight[] = [];
  const exportPattern = /^\s*export\s+(?:async\s+)?(?:function|class|interface|type|const)\s+([A-Za-z0-9_$]+)/;
  for (let index = 0; index < lines.length && candidates.length < 4; index += 1) {
    const match = exportPattern.exec(lines[index] ?? '');
    if (!match) continue;
    const startLine = index + 1;
    const endLine = Math.min(lines.length, startLine + 20);
    candidates.push({
      label: `Export ${match[1]}`,
      startLine,
      endLine,
    });
  }
  if (candidates.length > 0) return candidates;
  if (lines.length === 0) return undefined;
  return [{
    label: 'File opening',
    startLine: 1,
    endLine: Math.min(lines.length, 20),
  }];
}

export function deriveCommitCandidates(opts: {
  filePath: string;
  missingFields: AtlasCommitRequiredMetadataField[];
  cluster?: string | null;
  language?: string | null;
  source?: string;
}): DerivedCommitCandidates {
  const missing = new Set(opts.missingFields);
  const candidates: DerivedCommitCandidates = {};
  if (missing.has('tags')) {
    candidates.tags = deriveTags(opts.filePath, opts.cluster, opts.language);
  }
  if (missing.has('purpose') || missing.has('blurb')) {
    const identity = deriveIdentityText(opts.filePath);
    if (missing.has('purpose')) candidates.purpose = identity.purpose;
    if (missing.has('blurb')) candidates.blurb = identity.blurb;
  }
  if (missing.has('source_highlights')) {
    candidates.source_highlights = deriveSourceHighlights(opts.source);
  }
  return candidates;
}

export function formatDerivedCandidates(candidates: DerivedCommitCandidates): string {
  return JSON.stringify(candidates, null, 2);
}
