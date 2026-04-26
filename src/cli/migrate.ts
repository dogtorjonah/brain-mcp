#!/usr/bin/env node
/**
 * brain-mcp migration CLI
 *
 * Migrates from:
 *   1. rebirth-mcp's ~/.claude/identities/* (meta.json + chain.jsonl)
 *   2. rebirth-mcp's ~/.claude/rebirth-index.sqlite
 *   3. rebirth-mcp's ~/.claude/rebirth-chain/*.json
 *   4. Per-repo .atlas/ atlas DBs → edge backfill + repo registration
 *
 * Usage:
 *   npx brain-mcp migrate [--from-rebirth] [--scan-repos <path>] [--dry-run] [--verbose]
 *
 * Idempotent: re-running only adds new rows. Existing rows are skipped.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import Database from 'better-sqlite3';

import { HomeDb } from '../home/db.js';
import { IdentityStore } from '../identity/store.js';
import { EdgeEmitter } from '../edges/emitter.js';

// ──────────────────────────────────────────
// Config
// ──────────────────────────────────────────

const CLAUDE_DIR = join(homedir(), '.claude');
const IDENTITIES_DIR = join(CLAUDE_DIR, 'identities');
const REBIRTH_INDEX = join(CLAUDE_DIR, 'rebirth-index.sqlite');
const REBIRTH_CHAIN_DIR = join(CLAUDE_DIR, 'rebirth-chain');

// ──────────────────────────────────────────
// Types
// ──────────────────────────────────────────

interface MigrationResult {
  identitiesMigrated: number;
  chainEventsMigrated: number;
  sopsMigrated: number;
  handoffNotesMigrated: number;
  sessionsMigrated: number;
  reposScanned: number;
  edgesBackfilled: number;
  errors: string[];
}

// ──────────────────────────────────────────
// Migration: rebirth-mcp identity filesystem
// ──────────────────────────────────────────

function migrateIdentityFilesystem(homeDb: HomeDb, result: MigrationResult, dryRun: boolean): void {
  if (!existsSync(IDENTITIES_DIR)) {
    console.log('[migrate] No identities directory found at', IDENTITIES_DIR);
    return;
  }

  const store = new IdentityStore(homeDb);
  const dirs = readdirSync(IDENTITIES_DIR).filter(d => {
    const full = join(IDENTITIES_DIR, d);
    return statSync(full).isDirectory();
  });

  console.log(`[migrate] Found ${dirs.length} identity directories`);

  for (const dirName of dirs) {
    try {
      // Skip if already exists in brain DB.
      if (store.exists(dirName)) {
        console.log(`[migrate]   Identity "${dirName}" already exists, skipping profile`);
      } else {
        const metaPath = join(IDENTITIES_DIR, dirName, 'meta.json');
        let createdAt = Date.now();
        if (existsSync(metaPath)) {
          try {
            const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
            createdAt = meta.created_at ?? meta.createdAt ?? Date.now();
          } catch {
            // Use default.
          }
        }
        if (!dryRun) {
          store.create(dirName);
          // Patch created_at to match the original.
          homeDb.db.prepare('UPDATE identity_profiles SET created_at = ? WHERE name = ?').run(createdAt, dirName);
        }
        result.identitiesMigrated++;
        console.log(`[migrate]   ✓ Identity "${dirName}" created (created_at: ${new Date(createdAt).toISOString()})`);
      }

      // Migrate chain.jsonl events.
      const chainPath = join(IDENTITIES_DIR, dirName, 'chain.jsonl');
      if (existsSync(chainPath)) {
        const lines = readFileSync(chainPath, 'utf8').split('\n').filter(l => l.trim());
        let chainCount = 0;
        for (const line of lines) {
          try {
            const event = JSON.parse(line);
            if (!dryRun) {
              // Check if this chain event already exists (idempotent by ts + event_kind + session_id).
              const existing = homeDb.db.prepare(
                'SELECT 1 FROM identity_chain WHERE identity_name = ? AND event_kind = ? AND ts = ? AND (session_id = ? OR (session_id IS NULL AND ? IS NULL))'
              ).get(dirName, event.kind ?? event.eventKind ?? event.type, event.ts ?? event.timestamp, event.session_id ?? null, event.session_id ?? null);
              if (!existing) {
                store.appendChainEvent({
                  identityName: dirName,
                  eventKind: event.kind ?? event.eventKind ?? event.type ?? 'unknown',
                  sessionId: event.session_id ?? event.sessionId,
                  cwd: event.cwd,
                  wrapperPid: event.wrapper_pid ?? event.wrapperPid,
                  metaJson: JSON.stringify(event),
                });
                chainCount++;
              }
            }
          } catch {
            // Skip malformed lines.
          }
        }
        result.chainEventsMigrated += chainCount;
        if (chainCount > 0) console.log(`[migrate]     ${chainCount} chain events migrated`);
      }
    } catch (err) {
      result.errors.push(`Identity "${dirName}": ${err}`);
      console.error(`[migrate]   ✗ Error migrating "${dirName}":`, err);
    }
  }
}

// ──────────────────────────────────────────
// Migration: rebirth-index.sqlite
// ──────────────────────────────────────────

function migrateRebirthIndex(homeDb: HomeDb, result: MigrationResult, dryRun: boolean): void {
  if (!existsSync(REBIRTH_INDEX)) {
    console.log('[migrate] No rebirth-index.sqlite found at', REBIRTH_INDEX);
    return;
  }

  console.log('[migrate] Migrating from rebirth-index.sqlite');
  const rebirthDb = new Database(REBIRTH_INDEX, { readonly: true });

  try {
    // Identity profiles (if they have richer data than filesystem).
    try {
      const profiles = rebirthDb.prepare('SELECT * FROM identity_profiles').all() as any[];
      for (const p of profiles) {
        if (!dryRun && !homeDb.db.prepare('SELECT 1 FROM identity_profiles WHERE name = ?').get(p.name)) {
          homeDb.db.prepare(`
            INSERT OR IGNORE INTO identity_profiles (name, blurb, specialty_tags, created_at, updated_at, forked_from, retired_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(p.name, p.blurb ?? '', p.specialty_tags ?? p.specialtyTags ?? '', p.created_at ?? Date.now(), p.updated_at ?? Date.now(), p.forked_from ?? null, p.retired_at ?? null);
        }
      }
      console.log(`[migrate]   ${profiles.length} identity profiles checked`);
    } catch { /* Table may not exist */ }

    // SOPs.
    try {
      const sops = rebirthDb.prepare('SELECT * FROM identity_sops').all() as any[];
      for (const sop of sops) {
        if (!dryRun) {
          const existing = homeDb.db.prepare('SELECT 1 FROM identity_sops WHERE identity_name = ? AND title = ? AND created_at = ?').get(sop.identity_name, sop.title, sop.created_at);
          if (!existing) {
            homeDb.db.prepare(`
              INSERT INTO identity_sops (identity_name, title, body, created_at, updated_at, promoted_from_candidate, retired_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(sop.identity_name, sop.title, sop.body ?? '', sop.created_at, sop.updated_at, sop.promoted_from_candidate ?? null, sop.retired_at ?? null);
            result.sopsMigrated++;
          }
        }
      }
      console.log(`[migrate]   ${sops.length} SOPs checked, ${result.sopsMigrated} migrated`);
    } catch { /* Table may not exist */ }

    // Handoff notes.
    try {
      const notes = rebirthDb.prepare('SELECT * FROM identity_handoff_notes').all() as any[];
      for (const note of notes) {
        if (!dryRun) {
          homeDb.db.prepare(`
            INSERT INTO identity_handoff_notes (identity_name, note, updated_at, updated_by_session)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(identity_name) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at
          `).run(note.identity_name, note.note ?? '', note.updated_at, note.updated_by_session ?? null);
          result.handoffNotesMigrated++;
        }
      }
      console.log(`[migrate]   ${notes.length} handoff notes checked, ${result.handoffNotesMigrated} migrated`);
    } catch { /* Table may not exist */ }

    // Session identity bindings.
    try {
      const sessions = rebirthDb.prepare('SELECT * FROM session_identity').all() as any[];
      for (const s of sessions) {
        if (!dryRun) {
          homeDb.db.prepare(`
            INSERT OR IGNORE INTO session_identity (session_id, identity_name, bound_at, source)
            VALUES (?, ?, ?, ?)
          `).run(s.session_id, s.identity_name, s.bound_at, s.source ?? 'migration');
          result.sessionsMigrated++;
        }
      }
      console.log(`[migrate]   ${sessions.length} session bindings checked, ${result.sessionsMigrated} migrated`);
    } catch { /* Table may not exist */ }

  } finally {
    rebirthDb.close();
  }
}

// ──────────────────────────────────────────
// Migration: repo atlas → edge backfill
// ──────────────────────────────────────────

function migrateAtlasRepos(homeDb: HomeDb, result: MigrationResult, dryRun: boolean, scanPaths?: string[]): void {
  const emitter = new EdgeEmitter(homeDb);
  const defaultScanPaths = [
    join(homedir(), 'voxxo-swarm'),
    join(homedir(), 'vet-soap'),
  ];

  const paths = scanPaths ?? defaultScanPaths;

  for (const repoPath of paths) {
    const atlasPath = join(repoPath, '.atlas', 'atlas.sqlite');
    if (!existsSync(atlasPath)) {
      continue;
    }

    const workspace = basename(repoPath);
    console.log(`[migrate] Scanning atlas for repo "${workspace}" at ${repoPath}`);

    // Register repo.
    if (!dryRun) {
      homeDb.db.prepare(`
        INSERT INTO repo_registry (workspace, cwd, atlas_path, first_seen_at, last_attached_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(workspace) DO UPDATE SET last_attached_at = ?
      `).run(workspace, repoPath, atlasPath, Date.now(), Date.now(), Date.now());
    }
    result.reposScanned++;

    // Backfill edges from changelog.
    const atlasDb = new Database(atlasPath, { readonly: true });
    try {
      const rows = atlasDb.prepare(`
        SELECT id, workspace, file_path, summary, hazards_added, hazards_removed,
               patterns_added, patterns_removed, author_instance_id, author_identity,
               created_at
        FROM atlas_changelog
        WHERE author_instance_id IS NOT NULL OR author_identity IS NOT NULL
        ORDER BY id ASC
      `).all() as any[];

      for (const row of rows) {
        // Resolve identity name.
        const identityName = row.author_identity ?? row.author_instance_id;
        if (!identityName) continue;

        // Skip if identity doesn't exist (pre-attribution).
        if (!homeDb.db.prepare('SELECT 1 FROM identity_profiles WHERE name = ?').get(identityName)) continue;

        // Skip if edges already exist for this changelog entry.
        const existing = homeDb.db.prepare(
          'SELECT 1 FROM atlas_identity_edges WHERE changelog_id = ? AND workspace = ?'
        ).get(row.id, row.workspace ?? workspace);
        if (existing) continue;

        if (!dryRun) {
          const hazardsAdded: string[] = parseJsonStringArray(row.hazards_added);
          const hazardsRemoved: string[] = parseJsonStringArray(row.hazards_removed);
          const patternsAdded: string[] = parseJsonStringArray(row.patterns_added);
          const patternsRemoved: string[] = parseJsonStringArray(row.patterns_removed);

          emitter.emitCommitEdges({
            identityName,
            workspace: row.workspace ?? workspace,
            filePath: row.file_path,
            changelogId: row.id,
            hazardsAdded,
            hazardsRemoved,
            patternsAdded,
            patternsRemoved,
          });
          result.edgesBackfilled++;
        }
      }
      console.log(`[migrate]   ${rows.length} changelog entries scanned, ${result.edgesBackfilled} edge sets migrated`);
    } catch (err) {
      result.errors.push(`Atlas repo "${workspace}": ${err}`);
      console.error(`[migrate]   ✗ Error scanning atlas for "${workspace}":`, err);
    } finally {
      atlasDb.close();
    }
  }
}

// ──────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────

function parseJsonStringArray(val: unknown): string[] {
  if (!val) return [];
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      // Single string.
      return [String(val)];
    }
  }
  if (Array.isArray(val)) return val.map(String);
  return [];
}

function parseArgs(): { dryRun: boolean; verbose: boolean; scanRepos: string[] | undefined } {
  const args = process.argv.slice(2);
  let dryRun = false;
  let verbose = false;
  let scanRepos: string[] | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run') dryRun = true;
    if (args[i] === '--verbose') verbose = true;
    if (args[i] === '--scan-repos' && args[i + 1]) {
      scanRepos = args[++i].split(',').map(p => p.trim());
    }
  }

  return { dryRun, verbose, scanRepos };
}

// ──────────────────────────────────────────
// Main
// ──────────────────────────────────────────

function main(): void {
  const { dryRun, scanRepos } = parseArgs();

  console.log('[brain-mcp] Migration starting...');
  if (dryRun) console.log('[brain-mcp] DRY RUN — no writes');

  const result: MigrationResult = {
    identitiesMigrated: 0,
    chainEventsMigrated: 0,
    sopsMigrated: 0,
    handoffNotesMigrated: 0,
    sessionsMigrated: 0,
    reposScanned: 0,
    edgesBackfilled: 0,
    errors: [],
  };

  // Open (or create) the brain home DB.
  const homeDb = dryRun ? null as any : HomeDb.open();

  try {
    // Phase 1: Identity filesystem.
    migrateIdentityFilesystem(homeDb, result, dryRun);

    // Phase 2: rebirth-index.sqlite.
    migrateRebirthIndex(homeDb, result, dryRun);

    // Phase 3: Atlas repo edge backfill.
    migrateAtlasRepos(homeDb, result, dryRun, scanRepos);

    // Summary.
    console.log('\n[brain-mcp] Migration complete:');
    console.log(`  Identities migrated:    ${result.identitiesMigrated}`);
    console.log(`  Chain events migrated:  ${result.chainEventsMigrated}`);
    console.log(`  SOPs migrated:          ${result.sopsMigrated}`);
    console.log(`  Handoff notes migrated: ${result.handoffNotesMigrated}`);
    console.log(`  Sessions migrated:      ${result.sessionsMigrated}`);
    console.log(`  Repos scanned:          ${result.reposScanned}`);
    console.log(`  Edge sets backfilled:   ${result.edgesBackfilled}`);
    if (result.errors.length > 0) {
      console.log(`  Errors: ${result.errors.length}`);
      for (const err of result.errors) {
        console.log(`    - ${err}`);
      }
    }
  } finally {
    if (!dryRun) homeDb.close();
  }
}

main();
