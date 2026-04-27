#!/usr/bin/env node
/**
 * brain-mcp migration CLI
 *
 * Migrates from:
 *   1. rebirth-mcp's ~/.claude/identities/* (meta.json + chain.jsonl)
 *   2. rebirth-mcp's ~/.claude/rebirth-index.sqlite
 *
 * Usage:
 *   npx brain-mcp migrate [--dry-run] [--verbose]
 *
 * Idempotent: re-running only adds new rows. Existing rows are skipped.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import Database from 'better-sqlite3';

import { HomeDb } from '../home/db.js';
import { IdentityStore } from '../identity/store.js';

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
// Public API
// ──────────────────────────────────────────

export interface RunMigrateOptions {
  dryRun?: boolean;
}

export function runMigrate(opts: RunMigrateOptions = {}): MigrationResult {
  const dryRun = !!opts.dryRun;

  console.log('[brain-mcp] Migration starting...');
  if (dryRun) console.log('[brain-mcp] DRY RUN — no writes');

  const result: MigrationResult = {
    identitiesMigrated: 0,
    chainEventsMigrated: 0,
    sopsMigrated: 0,
    handoffNotesMigrated: 0,
    sessionsMigrated: 0,
    errors: [],
  };

  const homeDb = dryRun ? null as unknown as HomeDb : HomeDb.open();

  try {
    migrateIdentityFilesystem(homeDb, result, dryRun);
    migrateRebirthIndex(homeDb, result, dryRun);

    console.log('\n[brain-mcp] Migration complete:');
    console.log(`  Identities migrated:    ${result.identitiesMigrated}`);
    console.log(`  Chain events migrated:  ${result.chainEventsMigrated}`);
    console.log(`  SOPs migrated:          ${result.sopsMigrated}`);
    console.log(`  Handoff notes migrated: ${result.handoffNotesMigrated}`);
    console.log(`  Sessions migrated:      ${result.sessionsMigrated}`);
    if (result.errors.length > 0) {
      console.log(`  Errors: ${result.errors.length}`);
      for (const err of result.errors) {
        console.log(`    - ${err}`);
      }
    }
  } finally {
    if (!dryRun) homeDb.close();
  }

  return result;
}

// ──────────────────────────────────────────
// Standalone entrypoint
// ──────────────────────────────────────────

function parseStandaloneArgs(): RunMigrateOptions {
  const args = process.argv.slice(2);
  return { dryRun: args.includes('--dry-run') };
}

const isDirectInvocation = process.argv[1]?.endsWith('migrate.js') || process.argv[1]?.endsWith('migrate.ts');
if (isDirectInvocation) {
  runMigrate(parseStandaloneArgs());
}
