# brain-mcp — full design braindump

**Author:** atlas-schema-architect (rebirth identity, lineage minted 2026-04-26)
**Status:** unfiltered design notes; no scope cuts yet
**Audience:** future-Jonah, future-me, any identity that picks this up

---

## 0. What this document is

This is the complete unfiltered design braindump for **brain-mcp** — a standalone MCP server that fuses rebirth (identity / lineage / handoffs) with atlas (code knowledge graph / changelog / source highlights) into a single tooling cluster, designed together from the ground up rather than wired together after the fact. Nothing is held back, nothing is scope-cut, nothing is "let's see if this is needed." Everything I have thought about the build is here, with rationale, with rejected alternatives, with the open questions I'd want resolved before committing the first migration.

Length is by design. Auto mode is active and the user said "idc how large it is." Future-me reading cold should not need any other artifact to pick up the work.

---

## 1. Vision

### 1.1 The reframe

Existing reality:
- **rebirth-mcp** lives at `~/.claude/`. Owns identities, lineages, session breadcrumbs, handoff packaging, transcript search. Universal infra. Knows nothing about code.
- **atlas** (the relay-quality one) lives in each repo's `.atlas/`. Owns file purposes, blurbs, hazards, patterns, source highlights, changelog with author attribution, FTS5+vec hybrid search, cross-refs, source chunks. Workspace-scoped. Knows nothing about identities.
- **The standalone atlas-mcp-server in vet-soap** is a behind-the-times read-only fork. Irrelevant. Mention it only to dismiss it.

The user's question reframed: *what if identity-knowledge, code-knowledge, and transcript-history were the same substrate from day one?*

This is not "merge two MCPs." It is "design one organism whose memory layers are designed to interlock."

### 1.2 What "organic brain that grows" actually means

The phrase risks vagueness. I am committing to specific mechanics so it doesn't drift into mysticism:

1. **Memory has three layers and one synapse layer.**
   - **Episodic (transcripts):** what the agent said, did, decided. Per-session. Indexed.
   - **Semantic (atlas):** what the agent knows about each file. Cross-session, per-repo. Indexed.
   - **Identity (lineage):** who the agent is. Cross-session, cross-repo. Vectorized.
   - **Synaptic (edges):** which identity touched which file when, what hazards they surfaced or resolved, which transcript turns referenced which files. Cross-everything.

2. **The brain grows by accumulating edges, not by accumulating any one layer.** Every atlas_commit lands an identity↔file edge. Every transcript chunk lands identity↔file edges through path-mining. Every hazard added lands a (identity, surfaced, hazard, file, ts) edge. Every hazard removed lands a (identity, resolved, ...) counterpart. Edges are the actual learning.

3. **Identity is a vector, not a name.** Today rebirth identity = `{ name, blurb, specialty, chain.jsonl }`. In brain-mcp, identity additionally has a *specialty signature* and a *vector embedding* derived from the atlas records and transcript chunks they have touched, weighted by recency and edit-not-read. This is the mechanism that makes "find an identity like me" meaningful.

4. **Continuity is concrete, not philosophical.** Continuity = the chain of `chain.jsonl` events plus the persistent specialty signature plus the cross-repo identity vector. When a respawn happens, the new session inherits not just a markdown handoff but a structured identity context: "you are X, your specialty is Y, your last open hazards are Z, here is the atlas context for the files in flight."

5. **"Cracked out" mechanics that justify the standalone build:**
   - SOP discovery from repeated tool-call sequences.
   - Hazard attribution lifecycle (surfaced → resolved).
   - Time-traveling debug ("when did this hazard first appear, who introduced it, what was the rationale").
   - Cross-repo identity transfer ("bring `auth-spec` from voxxo-swarm to vet-soap").
   - Multi-identity collaboration intelligence ("identities A and B both touch this cluster — do their patterns conflict?").
   - Auto-generated identity bios that update themselves from work history.

These are not aspirational. Every one of them falls out of the storage and edge model below.

---

## 2. Why standalone, not a fork or a wire-up

### 2.1 The wire-them-up answer was wrong for the actual goal

Earlier in this conversation I recommended keeping rebirth-mcp and atlas separate and wiring them via cross-tool calls. That answer was correct for the question "should I touch the existing two systems." It is wrong for the question being asked now: "I want to build the OP version from the ground up."

Reasons the wire-up answer doesn't scale to the goal:
- Cross-MCP tool calls are slow and lose typing. In-process joins are free.
- The synapse table (`atlas_identity_edges`) has no good home in either system. It must be born in a system that owns both sides.
- The handoff payload optimization (atlas plan_context for in-flight files) requires the handoff packager to know about atlas internals. Cleaner if it's the same codebase.
- Identity vectors derived from atlas record embeddings need direct DB access on both sides. Cross-MCP makes this absurd.
- Time-traveling debug needs a unified query plane. Three SQLite files behind two MCPs is the wrong shape.

### 2.2 What standalone gets right that the existing setup cannot

1. **Universal deployment.** One brain-mcp daemon per machine serves every repo. Today voxxo-swarm has the rich atlas, vet-soap has the dead standalone, others have nothing. Standalone brain-mcp deployed once gives every project the same brain.
2. **Atlas portability preserved.** The repo's `.brain/atlas.sqlite` still ships with the repo. Cloning still gives you the atlas. The home-side identity DB is opt-in and orthogonal.
3. **Schema designed together.** `author_instance_id` was retrofitted into atlas. In brain-mcp it's a first-class column tied directly to the identity table by name + chain hash, not a free-form string.
4. **Single retrieval plane.** `brain_recall(query)` hits transcripts ∪ atlas_files ∪ changelog ∪ source_highlights with one hybrid retrieval. Today that requires two tools and manual stitching.
5. **Cross-repo edges have a home.** No more "where does the table go that says atlas-schema-architect touched files in three different repos."

### 2.3 What we are NOT doing

- **Not folding standalone atlas-mcp-server into anything.** It's a museum piece. Lift only the relay atlas (voxxo-swarm `relay/src/atlas/`) as the kernel.
- **Not making atlas data home-side.** Code-knowledge ships with code. Always.
- **Not making rebirth depend on atlas presence.** Capability-detect at every brain_* tool. Atlas-less repos still get identity / handoff / search.
- **Not migrating live voxxo-swarm relay to brain-mcp during the build.** Build brain-mcp standalone, prove it on a fresh repo, only then think about voxxo-swarm migration.
- **Not chasing a perfect identity-vector model.** Start with mean-pool of touched-file embeddings + blurb embedding. Iterate later.

---

## 3. Storage architecture

### 3.1 Two SQLite files, bridged via ATTACH

Decided. Reasoning already in the conversation, restated here for the record.

```
~/.brain/                              <repo>/.brain/
  brain.sqlite                           atlas.sqlite
  ├─ identity_profiles                   ├─ atlas_files
  ├─ identity_chain                      ├─ atlas_changelog
  ├─ identity_sops                       ├─ atlas_source_highlights
  ├─ identity_handoff_notes              ├─ atlas_source_chunks
  ├─ identity_embeddings                 ├─ atlas_embeddings        (vec0)
  ├─ specialty_signatures                ├─ atlas_chunk_embeddings  (vec0)
  ├─ transcript_chunks                   ├─ atlas_symbols
  ├─ transcript_chunk_embeddings (vec0)  ├─ atlas_symbol_references
  ├─ atlas_identity_edges  (synapses)    ├─ import_edges
  ├─ sop_candidates                      ├─ atlas_meta
  ├─ repo_registry                       └─ atlas_reextract_queue
  └─ session_identity
```

### 3.2 Why separate

1. **Atlas ships with the repo.** Clone → get atlas. Non-negotiable.
2. **The synapse table is cross-repo by nature** and belongs home-side. An identity that touches files in 4 repos has 4 atlas DBs but only one edge log.
3. **Different backup semantics.** Identity DB → private operator backup. Atlas DBs → live with the code, may eventually be team-shared.
4. **Different concurrency profiles.** Three Claude sessions in three repos contend on three different atlas WALs. With one big DB, they all serialize.
5. **Different schema cadences.** Atlas migrations version with code (ship `migrations/`). Identity migrations version with operator. Don't force alignment.

### 3.3 ATTACH is in-process, full-speed

```sql
ATTACH DATABASE '/home/jonah/voxxo-swarm/.brain/atlas.sqlite' AS atlas;

SELECT f.file_path,
       json_extract(f.metadata, '$.purpose') AS purpose,
       e.identity_name,
       e.kind, e.detail, e.created_at
FROM atlas.atlas_files f
JOIN atlas_identity_edges e
  ON e.workspace = f.workspace
 AND e.file_path = f.file_path
WHERE e.identity_name = 'atlas-schema-architect'
ORDER BY e.created_at DESC
LIMIT 50;
```

`better-sqlite3` supports cross-attach joins natively. Zero perf penalty vs single-DB.

### 3.4 Connection lifecycle

The brain-mcp process holds **one persistent home connection**. On each tool call:

1. Determine the relevant `cwd` (from caller — see bridge section below).
2. Resolve `<cwd>/.brain/atlas.sqlite`.
3. If different from currently-attached, `DETACH atlas; ATTACH '<new>' AS atlas;`. Cheap (microseconds).
4. Run the query. DETACH not strictly needed between calls; an LRU pool of 1-3 attached repos is fine.

For multi-repo queries (`brain_specialize` walking everything an identity has touched): iterate `repo_registry`, attach each in turn, accumulate, detach. Or maintain a small pool of named attaches.

### 3.5 Two gotchas to know up front

1. **sqlite-vec extension is per-connection.** Load it on the home connection at boot. If you also need vec searches inside an attached atlas DB, the extension is already loaded on the main connection — but vec0 virtual tables in the attached DB must have been created with the same extension version. Standardize the version in `package.json`.
2. **vec0 doesn't always cross ATTACH cleanly for `MATCH` clauses.** For `brain_recall` (unified hybrid retrieval), do per-DB vector searches separately and **RRF-fuse in application code**. Don't try to UNION across attached vec0 tables; you want per-source ranks for fusion anyway.

### 3.6 Atomicity and transactions

- All writes that touch home + atlas (e.g. `atlas_commit` that also writes an edge) wrap both in a single transaction across attached DBs. SQLite handles this.
- For reads, no transaction needed; readers don't block writers under WAL.
- Crash recovery: each DB has its own WAL. No two-phase commit needed; the worst case is an atlas changelog row exists with no edge, which we can detect and back-fill. (See migration / repair section.)

---

## 4. Tool clusters

### 4.1 Three namespaces, one binary

Deliberately three top-level namespaces so the surface stays legible to the host LLM. Constrained-decoding works better with clear naming hierarchy.

- `identity_*` — what rebirth-mcp has now, refined.
- `atlas_*` — what voxxo-swarm relay atlas has now, lifted as kernel.
- `brain_*` — the new cross-cutting tools. This is where the value is.

### 4.2 `identity_*` cluster

Mostly the existing rebirth surface, with one big refinement: every tool now reads/writes to `~/.brain/brain.sqlite` instead of `~/.claude/rebirth-index.sqlite`. Migration script handles the move (see §11).

| Tool | Purpose |
|---|---|
| `identity_set` | Bind wrapper to identity name. `mode=attach\|new\|fork`. Fork mode (new) creates a copy of an existing identity's blurb + SOPs + specialty as a new lineage — useful for "spin off a specialist from a generalist." |
| `identity_list` | Enumerate all identities with chain stats, blurb, specialty, bound wrapper PIDs, last-active timestamp, top 3 clusters from specialty signature. |
| `identity_describe` | Full profile + chain rollup + top files touched (now joined with atlas blurbs, not raw paths) + open hazards owned + active SOPs. |
| `identity_set_blurb` | Self-description; agent-authored. |
| `identity_handoff_set` | Last-write-wins per-identity status note. |
| `identity_sop_add/list/update/remove` | SOP CRUD as today. |
| `identity_sop_promote` | Promote an auto-discovered SOP candidate (from `sop_candidates`) into a real SOP. |
| `identity_recommend` | Now uses identity vectors + path experience + topic match. RRF over three signals. Returns ranked list with markdown pitches. |
| `identity_fork` | Mint a new identity that inherits some-or-all of an existing one's specialty signature. The fork's chain.jsonl records `forked_from`. |

Removed from the original rebirth surface:
- Nothing actually. The deprecated `rebirth_respawn` becomes `brain_respawn` to fit the namespace; semantics unchanged.

### 4.3 `atlas_*` cluster

Lift the existing voxxo-swarm relay atlas surface verbatim. It is already the most refined atlas in the ecosystem. The only changes are:

1. **Auto-attribution.** `atlas_commit` reads `$CLAUDE_IDENTITY` from the calling environment when `author_instance_id` is not provided. No more manual stamping; identity is implicit.
2. **Required-field schema** as we just shipped: `changelog_entry` min(10), `purpose` min(30), `blurb` min(20). Constrained decoding is the lever.
3. **Edge emission.** Every `atlas_commit` writes a row into `atlas_identity_edges` in the home DB inside the same transaction.
4. **Hazard delta edges.** When `hazards_added` is non-empty, emit `(identity, surfaced, hazard, file, changelog_id, ts)` edges, one per hazard string. When `hazards_removed`, emit `(identity, resolved, hazard, file, changelog_id, ts)` edges.
5. **Pattern delta edges.** Same shape for patterns_added / patterns_removed. Useful for specialty signature.

The full tool surface lifted from voxxo-swarm:
- `atlas_query` (search, lookup, brief, snippet, similar, plan_context, cluster, patterns, history)
- `atlas_commit` (the central tool)
- `atlas_changelog` (action=query, log, verify, recover)
- `atlas_graph` (impact, neighbors, trace, cycles, reachability, graph, cluster)
- `atlas_audit` (gaps, smells, hotspots)
- `atlas_admin` (init, reindex, bridge_list, merge)
- `atlas_hotspots` (most-churned files / most-hazardous files)
- `atlas_clock` (audit / housekeeping cadence; useful for the bridge daemon to drive periodic re-extraction)

### 4.4 `brain_*` cluster (the new value)

This is where the merger pays off. Each tool here is impossible (or absurdly slow) without unified storage.

| Tool | Purpose | Key SQL shape |
|---|---|---|
| `brain_recall` | Unified hybrid retrieval over transcripts ∪ atlas_files ∪ atlas_changelog ∪ atlas_source_highlights. RRF-fuse. Each hit knows its silo. | Per-silo top-K, fuse in app code. |
| `brain_resume` | "Where did I leave off?" Open hazards I surfaced and haven't resolved + files I was last to touch + active SOPs + last 5 atlas_commits. Per-identity, optionally per-repo. | JOIN edges + changelog + sop_candidates. |
| `brain_specialize` | What is this identity good at? Top clusters, top patterns, hazard balance (surfaced − resolved), most-touched files weighted by recency, specialty embedding. Update specialty signature row. | Aggregations over edges + atlas_files. |
| `brain_handoff` | Replaces today's flat markdown rebirth handoff. Returns structured payload (see §6). | Pulls atlas plan_context for in-flight files; identity context; thread; tasks. |
| `brain_lineage` | "Who has touched this file, what did each contribute, who introduced each hazard." Identity-level blame. | Per-file edge timeline grouped by identity. |
| `brain_recommend` | "For this task / file / hazard, which identities are most relevant?" Vector + path + topic. | Cosine similarity on identity vectors + path-experience signal. |
| `brain_diff_identities` | "Identity A and B both touch cluster C; where do their patterns / hazards differ?" Useful for collaboration auditing. | Diff on edge counts and pattern frequency. |
| `brain_when_did` | Time-traveling debug. "When did hazard H first appear on file F? When did pattern P first land?" Returns timestamp, identity, original commit summary. | Ordered scan of edges with predicate. |
| `brain_sop_candidates` | List auto-discovered SOP candidates for an identity, with frequency stats and example sessions. | Aggregations over `sop_candidates`. |
| `brain_respawn` | Trigger rebirth-claude wrapper respawn with a structured handoff. Replaces `rebirth_respawn`. | Writes sentinel + JSON handoff file. |
| `brain_search` | The pure transcript-side search (today's `rebirth_search`), kept for back-compat. New code should prefer `brain_recall`. | BM25 + vector on `transcript_chunks`. |

---

## 5. Schemas — every table

### 5.1 Home DB: `~/.brain/brain.sqlite`

```sql
-- Identity core
CREATE TABLE identity_profiles (
  name              TEXT PRIMARY KEY,           -- filesystem-safe
  blurb             TEXT NOT NULL DEFAULT '',
  specialty_tags    TEXT NOT NULL DEFAULT '',   -- comma-separated
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  forked_from       TEXT REFERENCES identity_profiles(name),
  retired_at        INTEGER                     -- soft-delete marker
);

CREATE TABLE identity_chain (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  identity_name     TEXT NOT NULL REFERENCES identity_profiles(name),
  event_kind        TEXT NOT NULL,              -- spawn, rebirth, swap-in, swap-out, mint, fork
  session_id        TEXT,
  cwd               TEXT,
  wrapper_pid       INTEGER,
  ts                INTEGER NOT NULL,
  meta_json         TEXT                        -- arbitrary event payload
);

CREATE TABLE identity_sops (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  identity_name     TEXT NOT NULL REFERENCES identity_profiles(name),
  title             TEXT NOT NULL,
  body              TEXT NOT NULL DEFAULT '',
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  promoted_from_candidate INTEGER REFERENCES sop_candidates(id),
  retired_at        INTEGER
);

CREATE TABLE identity_handoff_notes (
  identity_name     TEXT PRIMARY KEY REFERENCES identity_profiles(name),
  note              TEXT NOT NULL DEFAULT '',
  updated_at        INTEGER NOT NULL,
  updated_by_session TEXT
);

-- Identity vector + signature
CREATE VIRTUAL TABLE identity_embeddings USING vec0(
  identity_name     TEXT PRIMARY KEY,
  embedding         FLOAT[1536]
);

CREATE TABLE specialty_signatures (
  identity_name     TEXT PRIMARY KEY REFERENCES identity_profiles(name),
  top_clusters_json TEXT NOT NULL DEFAULT '[]', -- [{cluster, count}, ...]
  top_patterns_json TEXT NOT NULL DEFAULT '[]',
  top_files_json    TEXT NOT NULL DEFAULT '[]',
  hazards_surfaced  INTEGER NOT NULL DEFAULT 0,
  hazards_resolved  INTEGER NOT NULL DEFAULT 0,
  mean_resolve_ms   INTEGER,                    -- mean ms from surfaced→resolved for own hazards
  computed_at       INTEGER NOT NULL,
  dirty             INTEGER NOT NULL DEFAULT 1  -- recompute on next read if 1
);

-- Transcripts
CREATE TABLE transcript_chunks (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id        TEXT NOT NULL,
  identity_name     TEXT,                       -- null = pre-attribution
  cwd               TEXT,
  turn_index        INTEGER NOT NULL,
  role              TEXT NOT NULL,              -- user, assistant, tool, system
  text              TEXT NOT NULL,
  file_paths_json   TEXT NOT NULL DEFAULT '[]', -- mined paths
  ts                INTEGER NOT NULL
);
CREATE INDEX idx_chunks_session ON transcript_chunks(session_id);
CREATE INDEX idx_chunks_identity ON transcript_chunks(identity_name);
CREATE VIRTUAL TABLE transcript_chunks_fts USING fts5(text, content=transcript_chunks);
CREATE VIRTUAL TABLE transcript_chunk_embeddings USING vec0(
  chunk_id          INTEGER PRIMARY KEY,
  embedding         FLOAT[1536]
);

-- The synapse layer
CREATE TABLE atlas_identity_edges (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  identity_name     TEXT NOT NULL REFERENCES identity_profiles(name),
  workspace         TEXT NOT NULL,
  file_path         TEXT NOT NULL,
  changelog_id      INTEGER,                    -- atlas.atlas_changelog.id when applicable
  kind              TEXT NOT NULL,              -- commit, surfaced, resolved, pattern_added, pattern_removed, source_highlight, lookup
  detail            TEXT,                       -- the hazard string, pattern string, etc
  session_id        TEXT,
  ts                INTEGER NOT NULL
);
CREATE INDEX idx_edges_identity ON atlas_identity_edges(identity_name);
CREATE INDEX idx_edges_workspace_file ON atlas_identity_edges(workspace, file_path);
CREATE INDEX idx_edges_kind_detail ON atlas_identity_edges(kind, detail);
CREATE INDEX idx_edges_ts ON atlas_identity_edges(ts);

-- SOP discovery
CREATE TABLE sop_candidates (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  identity_name     TEXT NOT NULL REFERENCES identity_profiles(name),
  signature_hash    TEXT NOT NULL,              -- normalized tool-call sequence hash
  signature_json    TEXT NOT NULL,              -- the canonical tool-sequence
  occurrences       INTEGER NOT NULL DEFAULT 1,
  first_seen_at     INTEGER NOT NULL,
  last_seen_at      INTEGER NOT NULL,
  example_sessions  TEXT NOT NULL DEFAULT '[]', -- JSON array of session_ids
  promoted_sop_id   INTEGER REFERENCES identity_sops(id),
  dismissed_at      INTEGER
);
CREATE INDEX idx_candidates_identity_hash ON sop_candidates(identity_name, signature_hash);

-- Repo registry — what atlas DBs does this brain know about?
CREATE TABLE repo_registry (
  workspace         TEXT PRIMARY KEY,
  cwd               TEXT NOT NULL,              -- absolute path
  atlas_path        TEXT NOT NULL,              -- absolute path to atlas.sqlite
  first_seen_at     INTEGER NOT NULL,
  last_attached_at  INTEGER NOT NULL,
  last_extraction_at INTEGER
);

-- Session ↔ identity binding (auto-populated on chain events)
CREATE TABLE session_identity (
  session_id        TEXT PRIMARY KEY,
  identity_name     TEXT NOT NULL REFERENCES identity_profiles(name),
  bound_at          INTEGER NOT NULL,
  source            TEXT NOT NULL               -- spawn, rebirth, swap, manual
);
```

### 5.2 Per-repo DB: `<repo>/.brain/atlas.sqlite`

Schema is **identical to voxxo-swarm relay atlas as of 2026-04-26** (migrations 0001-0007). Lift verbatim. Specifically:

- `atlas_files` (workspace, file_path, file_hash, cluster, loc, blurb, purpose, public_api, exports, patterns, dependencies, data_flows, key_types, hazards, conventions, cross_refs, source_highlights, language, extraction_model, last_extracted, created_at, updated_at) — unchanged.
- `atlas_changelog` (id, workspace, file_path, summary, patterns_added, patterns_removed, hazards_added, hazards_removed, cluster, breaking_changes, commit_sha, **author_instance_id, author_engine, author_name, author_identity**, review_entry_id, source, created_at, verification_status) — `author_identity` becomes the canonical FK to `home.identity_profiles.name`. The string-form `author_instance_id` is kept for legacy.
- `atlas_source_highlights` — unchanged.
- `atlas_source_chunks` — unchanged.
- `atlas_embeddings` (vec0) — unchanged.
- `atlas_chunk_embeddings` (vec0) — unchanged.
- `atlas_symbols`, `atlas_symbol_references` — unchanged.
- `import_edges` — unchanged.
- `atlas_meta` — extended with one new field: `brain_version` so atlas DBs know which brain-mcp schema they were last touched by. Cross-version tolerance lives here.
- `atlas_reextract_queue` — unchanged.

### 5.3 What changed in atlas vs today's voxxo-swarm

Only two things, both compatible:

1. `atlas_meta.brain_version` added.
2. `atlas_changelog.author_identity` is **now used** (it exists today as a string; brain-mcp treats it as a FK enforced in application code, not via SQL FK because the home DB is attached, not native).

Everything else is identical. Lift, don't redesign.

---

## 6. The handoff revolution

### 6.1 Today's handoff is a markdown blob

Voxxo-swarm rebirth handoff today: ~40KB markdown, 12 files-in-context with raw read snippets, last user+AI turns, activity log, current thread. It works but it's read-snippet-shaped. The receiving Claude has to skim a wall of text to figure out what matters.

### 6.2 Tomorrow's handoff is structured JSON with atlas inlay

`brain_handoff` returns JSON. Sections, each section budget-aware, each section explicitly typed:

```json
{
  "schema_version": 1,
  "identity": {
    "name": "atlas-schema-architect",
    "blurb": "...",
    "specialty_tags": ["atlas-schema-design", "..."],
    "specialty_signature": {
      "top_clusters": [{"cluster": "atlas-tools", "count": 14}, ...],
      "top_patterns": [...],
      "hazards_surfaced": 7,
      "hazards_resolved": 5,
      "mean_resolve_ms": 1820000
    },
    "last_handoff_note": "..."
  },
  "in_flight_atlas": [
    {
      "file_path": "relay/src/atlas/tools/commit.ts",
      "purpose": "Registers the atlas_commit MCP tool — claim, idempotency, changelog write, tier-aware coverage feedback",
      "blurb": "atlas_commit MCP tool — claim, idempotency, changelog write, tier-aware coverage feedback",
      "hazards": ["claim TTL of 30s ...", "..."],
      "source_highlights": [
        {"label": "tool description leads with required fields", "start_line": 222, "end_line": 260, "content": "..."}
      ],
      "my_recent_commits": [
        {"changelog_id": 5742, "summary": "Reverted stub-detector ...", "ts": "..."}
      ],
      "open_hazards_i_own": []
    },
    ...
  ],
  "open_hazards_owned": [
    {"workspace": "voxxo-swarm", "file_path": "...", "hazard": "...", "surfaced_at": "...", "age_days": 12}
  ],
  "active_sops": [
    {"id": 14, "title": "After atlas_commit, run atlas_audit on the changed file"},
    ...
  ],
  "recent_decisions": [
    {"changelog_id": 5742, "summary": "...", "ts": "...", "rationale_snippet": "..."}
  ],
  "active_tasks": [...],
  "current_thread": {
    "turns": [...],
    "byte_budget_used": 12482
  },
  "git_state": {...},
  "activity_log_summary": "..."
}
```

### 6.3 Why this is 5-10× signal density per byte

- **Atlas inlay is curated.** `purpose` + `blurb` + `hazards` + `source_highlights` were authored by the prior agent specifically to onboard the next agent. Raw read snippets are accidental.
- **Per-file my-recent-commits** tells the receiving Claude what *this identity* has done to *this file* — not what arbitrary edits exist in git.
- **Open hazards owned across all repos** — single most useful "where did I leave off" signal. Cannot exist without the synapse table.
- **Receiving Claude can selectively expand.** With JSON, it can ask the brain for more on a specific file without re-reading the whole handoff. With markdown, it just gets the blob.

### 6.4 Backward compat

Wrapper still expects markdown? Brain-mcp also emits a markdown rendering of the JSON for the wrapper to inject. The structured JSON is also written to a sidecar file that the next session's first tool call can read for the high-density view.

---

## 7. Embeddings strategy

### 7.1 What we embed

- **Atlas files** — concat of `purpose` + `blurb` + `hazards` (joined) + `patterns` (joined) + `key_types` (joined) + first source_highlight content. Single 1536-dim vector per file. Stored in `atlas.atlas_embeddings`.
- **Atlas source chunks** — every source_highlights row gets its own embedding (granular retrieval). Stored in `atlas.atlas_chunk_embeddings`.
- **Transcript chunks** — every assistant + user turn (skip pure tool-result chunks unless they have prose). Stored in `home.transcript_chunk_embeddings`.
- **Identities** — derived embedding (see 7.2). Stored in `home.identity_embeddings`.

### 7.2 Identity vector derivation

Lazy + dirty-bit driven. Cadence:

1. On `atlas_commit` for a file, set `specialty_signatures.dirty = 1` for the calling identity.
2. On transcript chunk insert, set dirty for the identity bound to that session.
3. On `identity_set_blurb`, set dirty.
4. On `identity_sop_add`, set dirty.
5. When any tool needs a fresh identity vector AND `dirty=1` AND `now - computed_at > 30min`, recompute:
   - Pull top-50 atlas record embeddings for files this identity has touched (by edge count, recency-weighted).
   - Pull top-100 transcript chunk embeddings for this identity (by recency).
   - Pull blurb embedding (compute on the fly if blurb changed since last vector).
   - Mean-pool, weighted: 50% atlas, 35% transcripts, 15% blurb. (Adjust later.)
   - Store, set `dirty=0`, `computed_at=now`.

### 7.3 Embedding provider abstraction

Same as voxxo-swarm: pluggable backends (OpenAI, Anthropic, Ollama, Voyage, local). Configured via `ATLAS_EMBEDDING_PROVIDER` env or `brain.config.json`. Single embedder for both atlas and transcripts (must be consistent for cross-silo retrieval ranking to make sense).

### 7.4 Cost / latency control

- **Batch.** Never embed one chunk at a time. Buffer up to N=32 in memory, flush on count or 30s timer.
- **Skip rebuilds when content hash hasn't changed.** Atlas already does this for files; mirror for chunks.
- **Background indexing daemon.** Don't block tool calls on embedding. Tool returns success after raw write; embedding happens async. (Marker column `embedding_state IN ('pending', 'done', 'failed')`.)
- **Rate limit per provider.** Token bucket per minute; spill back to local if hosted runs dry.

---

## 8. Hazard attribution lifecycle

### 8.1 The mechanic

When `atlas_commit` lands:
- For each string `h` in `hazards_added`: insert `(identity, 'surfaced', h, file, changelog_id, ts)` into `atlas_identity_edges`.
- For each string `h` in `hazards_removed`: insert `(identity, 'resolved', h, file, changelog_id, ts)`.
- A hazard is "matched" by exact string equality. Whitespace-trimmed, but no fuzzy match. Reasoning: hazards are short curated strings; a fuzzy match would create false resolutions.

### 8.2 Same-session iteration filter

If identity X surfaces hazard H and removes H within the same `session_id`, both edges still land but `brain_resume` and specialty signature explicitly subtract these (it's iteration, not stewardship). Implementation: a `session_id` column on edges + a `WHERE` predicate that excludes pairs.

### 8.3 Specialty signature uses

- `hazards_surfaced` = total `surfaced` edges, lifetime.
- `hazards_resolved` = total `resolved` edges, lifetime.
- `mean_resolve_ms` = mean `(resolved.ts - surfaced.ts)` for hazards this identity surfaced and itself resolved.
- Hazard balance (for descriptive purposes) = surfaced − resolved.
  - Strongly negative balance → janitor identity (resolves more than surfaces).
  - Strongly positive balance → explorer identity (surfaces a lot, hands off resolution).
  - Balanced → owner identity.

### 8.4 Why this matters

It's the cheapest possible way to learn agent specialty. Today there's no signal at all — every commit is anonymous to atlas. With identity stamping + hazard delta edges, you get a longitudinal view of who actually maintains code quality and who just lands features. That feeds `brain_recommend` ("for hazard cleanup tasks, prefer janitor identities").

---

## 9. SOP discovery

### 9.1 Mechanic

A SOP candidate is a tool-call sequence ≥ N steps long that the same identity runs ≥ M times across distinct sessions.

Defaults: N=3, M=3. Tunable per identity later.

### 9.2 Sequence normalization

Normalize each tool call to `(tool_name, primary_arg)` where primary_arg is something stable: file_path for Read/Edit/Write, command-prefix for Bash, action for atlas_query. Then compute the sequence hash.

Allow skips: a Levenshtein-1 skip per match. So `(Read A, Edit A, atlas_commit A)` matches `(Read A, atlas_query=lookup A, Edit A, atlas_commit A)` with one inserted step.

### 9.3 Storage and surfacing

- Insert into `sop_candidates` keyed by `(identity_name, signature_hash)`.
- Increment `occurrences` on each match.
- `brain_sop_candidates` returns ordered by `occurrences DESC, last_seen_at DESC`.
- User (or agent) promotes a candidate via `identity_sop_promote(candidate_id, title, body?)` → row in `identity_sops` + `promoted_sop_id` set on the candidate.
- Discard candidates where `now - last_seen_at > 30 days AND promoted_sop_id IS NULL` via cron.

### 9.4 Why this is cracked

Today every agent reinvents its own workflows every session. With auto-discovery, your specialist identities accumulate codified procedures from observation, not from manual SOP-writing. The agent's playbook builds itself.

### 9.5 Risks / known issues

- **Noisy candidates.** Most repeated sequences are boring (Read → Edit → Read). Filter out anything where >50% of steps are the same tool. Filter sequences with < 2 distinct tool kinds.
- **Path-specific candidates don't generalize.** A SOP that only applies when editing `relay/src/atlas/tools/commit.ts` is not useful. Suppress candidates where >80% of occurrences share the same primary_arg.
- **Privacy / leakage.** SOP candidate signatures store tool-call shapes. Don't store full tool args (could contain secrets). Hash + label only.

---

## 10. The bridge component

### 10.1 What "bridge" means here

Voxxo-swarm has a concept called the **bridge** — a relay process that exposes its internal MCP servers to spawning Claude Code instances over stdio MCP, with auth, multi-tenancy, observer registration, and routing. `mcp__voxxo-swarm-bridge__atlas_*` tools are how Claude Code talks to the relay's atlas.

For brain-mcp, the equivalent is a daemon that:
1. Runs once per machine (one daemon, many sessions).
2. Exposes stdio MCP to each spawning Claude (configured in `~/.claude.json` MCP server list).
3. Routes calls based on caller `cwd` to the right atlas DB (via ATTACH).
4. Reads `$CLAUDE_IDENTITY` and `$REBIRTH_WRAPPER_PID` from caller env.
5. Maintains the shared home DB connection + a small LRU pool of attached atlas DBs.
6. Handles concurrent calls from multiple Claudes safely (per-resource locks already exist in atlas; reuse).
7. Detects atlas-less repos and degrades gracefully (atlas_* tools return "no atlas at this cwd; want to init?").

### 10.2 Daemon architecture

```
┌──────────────────────────────────────────────────────────────┐
│  brain-mcp daemon (single process per machine)               │
│                                                              │
│   stdio MCP transport ◀──┬── Claude session A (cwd=voxxo)   │
│                          ├── Claude session B (cwd=vet-soap)│
│                          └── Claude session C (cwd=other)    │
│                                                              │
│   Identity / handoff cluster                                 │
│   Atlas cluster (with cwd→atlas resolution)                  │
│   Brain cluster (cross-cutting)                              │
│                                                              │
│   ┌─────────────────────────────────────────────────────┐   │
│   │  Connection pool                                    │   │
│   │  ┌─────────────────────┐  ┌─────────────────────┐   │   │
│   │  │ home (~/.brain/     │  │ atlas LRU pool      │   │   │
│   │  │   brain.sqlite)     │  │  - voxxo-swarm/     │   │   │
│   │  │   persistent        │  │  - vet-soap/        │   │   │
│   │  └─────────────────────┘  │  - ...              │   │   │
│   │                           └─────────────────────┘   │   │
│   └─────────────────────────────────────────────────────┘   │
│                                                              │
│   ┌─────────────────────────────────────────────────────┐   │
│   │  Background workers                                 │   │
│   │  - embedding_indexer (batch, async)                 │   │
│   │  - sop_discoverer (cron, hourly)                    │   │
│   │  - specialty_recompute (lazy + cron, daily)         │   │
│   │  - hazard_lifecycle_audit (cron, weekly)            │   │
│   │  - atlas_reextract_drainer (per-workspace queue)    │   │
│   └─────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
```

### 10.3 stdio vs HTTP

For each Claude session, MCP transport is **stdio** (the standard), child process launched per session. The daemon itself is **a long-running parent** that the per-session stdio adapters dial into via Unix domain socket (`~/.brain/sock`).

Why this split:
- Claude Code spawns MCP servers as child processes on session start. If brain-mcp were a session-scoped child, every session would re-open the home DB and reload the embedding model. Wasteful.
- The actual long-lived state (DB connections, embedding model, LRU cache) lives in the daemon; the stdio adapter is a thin shim that proxies tool calls over the Unix socket.
- One daemon = single source of truth for the home DB. No multi-writer corruption risk.

```
Claude session  ──spawns──▶  stdio adapter  ──UDS──▶  daemon  ──ATTACH──▶  atlas.sqlite
                                                          │
                                                          └──────────────▶  brain.sqlite
```

### 10.4 stdio adapter responsibilities

Tiny. <500 LoC.

- Read MCP messages from stdin.
- Forward to daemon over Unix socket as JSON lines.
- Read daemon response, write to stdout.
- On startup: handshake the daemon, send caller env (`CLAUDE_IDENTITY`, `REBIRTH_WRAPPER_PID`, `cwd`).
- On daemon disconnect: auto-spawn daemon if not running, retry once, then bubble error.

### 10.5 Daemon startup

- Lazy: first stdio adapter to dial in spawns the daemon if not running. Or systemd user service / launchd plist for always-on.
- Health check: HTTP `:4815` (loopback only) for `/health`, `/metrics`. Useful for the bridge to surface daemon status.
- Shutdown: SIGTERM drains in-flight work, flushes embedding queue, vacuums SQLite, exits.
- Restart-resilience: daemon dies mid-session, stdio adapter detects, respawns daemon, retries the in-flight tool call. Idempotency is already in atlas_commit; identity_* writes are LWW so retry is safe.

### 10.6 Per-call routing flow

Tool call arrives at daemon:

1. Decode method name (e.g. `atlas_commit`).
2. Look up cluster (atlas / identity / brain).
3. Resolve relevant `cwd` (from caller env, or `workspace` arg, or active session map).
4. If atlas-cluster tool and cwd has no atlas → return capability-detect error or auto-init prompt.
5. Ensure cwd's atlas.sqlite is attached. ATTACH if needed (LRU eviction).
6. Auto-attribution: if `author_instance_id` not in args, set from caller's `$CLAUDE_IDENTITY`.
7. Open transaction across home + atlas if write.
8. Execute handler.
9. Emit edges (synapse writes) inside same transaction.
10. Commit, return result.

### 10.7 Concurrency model

- Reads: SQLite WAL allows many readers, no contention.
- Writes to home: serialized per identity (cheap mutex, identity_name keyed).
- Writes to atlas: existing per-file claim lock from voxxo-swarm carries over.
- Cross-DB writes: BEGIN, write home edge, write atlas changelog, COMMIT. SQLite handles cross-attach atomicity.
- Background workers: separate connections, never touch the same row sets as live writers. Specialty recompute uses snapshot reads, writes a single row.

### 10.8 Multi-machine? Multi-user?

Out of scope for v1. Brain-mcp is single-machine, single-user. If you want to share an identity's specialty across machines, export/import via JSON. Multi-machine sync (S3 / Supabase / Atuin-style) is v2.

### 10.9 Bridge ↔ voxxo-swarm relay coexistence

For now, brain-mcp is independent. Voxxo-swarm relay continues to exist; its bridge tools (`mcp__voxxo-swarm-bridge__atlas_*`) keep serving voxxo-swarm. When brain-mcp is mature:
- Migrate voxxo-swarm to consume brain-mcp's `mcp__brain__atlas_*` instead of having atlas in-tree.
- Keep voxxo-swarm relay for the swarm-specific concerns (chamber routing, evolution, partner claims, etc.). Atlas just gets externalized.

---

## 11. Migration

### 11.1 From rebirth-mcp's existing state

- Walk `~/.claude/identities/*/meta.json` → seed `identity_profiles` (name, created_at).
- Walk `~/.claude/identities/*/chain.jsonl` → seed `identity_chain` (one row per JSONL line).
- Open `~/.claude/rebirth-index.sqlite` → migrate `identity_profiles`, `identity_sops`, `identity_handoff_notes`, `session_identity` rows verbatim (rename table prefixes if needed).
- Walk `~/.claude/rebirth-chain/*.json` → seed any chain events not already captured.
- For `chunks` / `chunks_fts` / `chunks_vec`: re-derive into `transcript_chunks` + `transcript_chunks_fts` + `transcript_chunk_embeddings`. Embeddings can be re-generated lazily on first query (or eagerly via background indexer if user wants warm cache).
- Idempotent. Re-running adds new rows only.

### 11.2 From voxxo-swarm relay atlas

- Walk `relay/.atlas/atlas.sqlite` → copy into `<repo>/.brain/atlas.sqlite` verbatim. Schema is already compatible.
- For each row in `atlas_changelog` where `author_instance_id IS NOT NULL`:
  - If `author_instance_id` looks like an identity name (matches `~/.claude/identities/<name>/`), seed `home.atlas_identity_edges` with `(name, 'commit', workspace, file_path, changelog_id, ts)`.
  - For each `hazards_added` string, seed a `surfaced` edge.
  - For each `hazards_removed` string, seed a `resolved` edge.
  - Same for patterns.
- For rows where `author_instance_id IS NULL` or doesn't match an identity → flag as `pre-attribution`, leave edges blank. Don't backfill from git blame; it's noisy.
- Add row to `repo_registry`.
- Idempotent. Track `last_migration_atlas_changelog_id` per workspace; resume on re-run.

### 11.3 From other repos with `.atlas/`

- For each repo on disk with a `.atlas/atlas.sqlite`, run migration §11.2.
- Discovery: scan known dev dirs (`~/voxxo-swarm`, `~/vet-soap`, etc.) on first run, plus an explicit `brain admin scan-repos <path>` command.

### 11.4 Migration is one-way until it isn't

Initial ship: brain-mcp reads but doesn't write to existing `~/.claude/rebirth-index.sqlite` or `<repo>/.atlas/atlas.sqlite`. After migration, the new home is `~/.brain/brain.sqlite` and `<repo>/.brain/atlas.sqlite`. Old paths are abandoned.

If you need to roll back: brain-mcp has `brain admin export-legacy` that emits the new state in old-format SQLite for both rebirth-index and atlas. Round-trip preserves identity history. Don't promise round-trip for SOP candidates (new concept).

---

## 12. Concrete tool signatures (the ones I'd commit on day 1)

### 12.1 `atlas_commit` (the keystone)

Lifted verbatim from voxxo-swarm relay with the schema-required pivot already shipped (changelog_entry min(10), purpose min(30), blurb min(20), all required). Plus:

```ts
// New behavior:
// 1. author_instance_id defaults to $CLAUDE_IDENTITY at call time.
// 2. After insertAtlasChangelog succeeds, in same TX:
//    INSERT INTO home.atlas_identity_edges
//      (identity_name, workspace, file_path, changelog_id, kind, detail, session_id, ts)
//    VALUES
//      (identity, workspace, file_path, changelog_id, 'commit', NULL, session_id, ts),
//      (identity, workspace, file_path, changelog_id, 'surfaced', $hazard, session_id, ts) -- per hazards_added
//      (identity, workspace, file_path, changelog_id, 'resolved', $hazard, session_id, ts) -- per hazards_removed
//      (identity, workspace, file_path, changelog_id, 'pattern_added', $pattern, session_id, ts)
//      (identity, workspace, file_path, changelog_id, 'pattern_removed', $pattern, session_id, ts)
// 3. Mark specialty_signatures.dirty=1 for this identity.
// 4. Enqueue embedding refresh for the file (existing logic).
```

### 12.2 `brain_resume`

```ts
brain_resume({
  identity?: string,        // default = $CLAUDE_IDENTITY
  workspace?: string,       // default = caller cwd's workspace, or 'all'
  limit_open_hazards?: number,  // default 20
  include_atlas_context?: boolean,  // default true
})
→ {
  identity: { name, blurb, specialty_signature_summary },
  open_hazards_owned: [
    { workspace, file_path, hazard, surfaced_at_changelog_id, age_days, file_purpose }
  ],
  recent_commits: [
    { workspace, file_path, changelog_id, summary, ts }
  ],
  files_last_touched: [
    { workspace, file_path, last_touched_at, my_edge_count, atlas_blurb }
  ],
  active_sops: [...],
  next_step_hint: string  // synthesized from above; see 12.2.1
}
```

### 12.2.1 `next_step_hint` synthesis

A short imperative string the brain composes from the resume payload:

- Most-aged open hazard you own → "Address hazard 'X' on file F (open 12 days)."
- Most recent commit in flight (file with my edge in last hour but no follow-up commit) → "Follow up on file F — you committed 47min ago, no atlas_audit since."
- Active SOPs that match in-flight files → "Run SOP 'After atlas_commit, atlas_audit the changed file' on F."

Heuristic, not magic. Iterate weights based on use.

### 12.3 `brain_handoff`

```ts
brain_handoff({
  session_id: string,
  cwd: string,
  identity?: string,  // default $CLAUDE_IDENTITY
  byte_budget?: number,  // default 60_000
  include_thread_turns?: number,  // default 8
  format?: 'json' | 'markdown' | 'both',  // default 'both'
})
→ {
  json: <see §6.2>,
  markdown: string  // rendered for legacy wrapper
}
```

### 12.4 `brain_recall`

```ts
brain_recall({
  query: string,
  scope?: 'self' | 'session' | 'workspace' | 'all',  // default 'workspace'
  silos?: ('transcripts'|'atlas_files'|'atlas_changelog'|'source_highlights')[],  // default all
  k?: number,  // default 20
  rerank_weights?: { recency?: number, identity_affinity?: number, cluster_cohesion?: number }
})
→ {
  hits: [
    { silo, score, payload: <silo-specific>, ts, identity?, workspace?, file_path? }
  ],
  silo_breakdown: { transcripts: N, atlas_files: M, ... }
}
```

### 12.5 `brain_when_did`

```ts
brain_when_did({
  what: 'hazard' | 'pattern' | 'commit',
  detail: string,         // hazard string, pattern string, or summary substring
  workspace?: string,
  file_path?: string,
})
→ {
  first_appearance: {
    ts, identity_name, changelog_id, summary, surrounding_transcript_chunk_id?
  },
  history: [{ ts, kind, identity_name, changelog_id, summary }]
}
```

### 12.6 `brain_lineage`

```ts
brain_lineage({
  workspace: string,
  file_path: string,
  limit?: number,  // default 50
})
→ {
  identities: [
    { identity_name, edge_count, first_touch_at, last_touch_at,
      hazards_surfaced_here: [...], hazards_resolved_here: [...],
      patterns_added_here: [...], commits_here: number }
  ],
  timeline: [...]
}
```

### 12.7 `identity_fork`

```ts
identity_fork({
  source_identity: string,
  new_name: string,
  inherit?: { blurb?: boolean, sops?: boolean, specialty_vector?: boolean },  // defaults all true
})
→ { name, forked_from, created_at }
```

Adds a chain.jsonl event `forked` with parent reference. Specialty signature is initialized as a copy; subsequent work diverges naturally.

---

## 13. Build phasing — what to ship in what order

### 13.1 Day 1 (the user's claim is doable)

1. New repo `brain-mcp/`. Lift voxxo-swarm `relay/src/atlas/` verbatim into `brain-mcp/src/atlas/`. Lift schemas + migrations.
2. Add home DB schema (§5.1) as `brain-mcp/migrations/home/0001_init.sql`.
3. Daemon skeleton: stdio adapter + Unix socket + daemon loop.
4. Stdio adapter forwards method calls; daemon dispatches to atlas_* handlers.
5. Wire atlas_commit to also write `atlas_identity_edges` in the same transaction.
6. Smoke test: register `mcp__brain__atlas_commit` in a Claude session, run a commit, confirm edge row lands.

### 13.2 Day 2-3

7. Lift rebirth-mcp identity surface (`identity_*` tools). Migrate from `~/.claude/rebirth-index.sqlite`.
8. Migration script for voxxo-swarm `.atlas/` → `.brain/atlas.sqlite` + edge backfill from existing `author_instance_id`.
9. `brain_resume` v1: just open hazards owned + recent commits. No next_step_hint yet.
10. `brain_lineage`: per-file identity timeline.

### 13.3 Day 4-7

11. Embedding indexer daemon worker. Atlas files + transcript chunks.
12. `brain_recall` v1: per-silo top-K + RRF fuse in app code.
13. Identity vectors (lazy + dirty bit). `identity_recommend` switches to vector similarity.
14. `brain_when_did`.
15. `brain_handoff` v1 returning JSON + markdown. Wrapper still injects markdown.

### 13.4 Week 2

16. SOP candidate discovery worker.
17. `brain_specialize` with full signature roll-up.
18. `identity_fork`.
19. Hazard lifecycle audit (cron) — flags hazards open > 30 days, suggests them to the owning identity on next handoff.
20. Voxxo-swarm relay migration: relay starts proxying its bridge atlas tools to brain-mcp instead of in-tree atlas. Atlas in-tree is deprecated.

### 13.5 Week 3+

21. `brain_diff_identities`.
22. Multi-identity collaboration intelligence dashboard.
23. Cross-machine sync (S3 / Supabase / git-backed).
24. Auto-generated identity bios (regen on each specialty recompute).
25. UI: a small read-only web view at `localhost:4815/brain` for browsing identities, lineages, specialty signatures, hazard timelines. Optional but high-value for the operator (you, Jonah).

### 13.6 What ships in v1 (the MVP)

Steps 1-15. Everything past that is iteration. v1 is shippable in a week if focused; the user's "in a day" claim is plausible for steps 1-6 plus a basic resume tool.

---

## 14. Risks and unknowns

### 14.1 Real risks

- **Migration data loss.** If migration mis-attributes an identity, it's silent. Mitigation: dry-run mode that emits a manifest before writing; require explicit `--commit` flag.
- **Embedding cost.** Embedding every transcript chunk for every session across all identities adds up. Mitigation: skip pure-tool-result chunks unless they have prose; use small models for transcripts (3-large or local) and reserve OpenAI 3-large only for atlas files. Or run everything on local Ollama with `nomic-embed-text` v1.5.
- **Daemon failure mode.** Daemon dies mid-call → in-flight tool call hangs. Mitigation: stdio adapter has 30s timeout, kills daemon, respawns, retries. Adapter never blocks Claude indefinitely.
- **Cross-attach gotchas.** sqlite-vec `MATCH` across attached DBs doesn't always work. Mitigation already noted: per-DB vector search + RRF fuse in app code.
- **SOP candidate noise.** Mitigation already noted: filter by tool-kind diversity, suppress path-specific.

### 14.2 Open questions I'd want resolved before committing the first line

1. **Where does `~/.brain/` live on macOS / WSL / Linux?** Use `XDG_DATA_HOME` if set, else `~/.brain/`. Decide before write paths land in code.
2. **Identity-name collisions across machines.** If you import an identity from another machine and the name exists locally, what happens? Default: fork-with-suffix (`atlas-schema-architect-2`). User can override with `--rename` or `--merge`.
3. **What about Claude sessions that don't have an identity?** `$CLAUDE_IDENTITY` unset → use `anon-<wrapper_pid>`. Edges still land but with the anon name. Anon edges can be reattributed later via `brain admin reattribute --from anon-NNN --to <real_name>`.
4. **Atlas-less repos.** If a Claude opens a repo with no `.brain/atlas.sqlite`, do we auto-init? Default: no. User runs `brain init` explicitly. Auto-init adds friction (every junk repo gets an atlas).
5. **Bridge vs daemon vs in-process MCP.** I'm committing to daemon + stdio adapter. But Claude Code's MCP launcher already supports stdio — could we just run brain-mcp as a session-scoped child? Faster to ship, slower to run (DB reload per session). For v1 we accept session-scoped child if daemon is harder to land. The stdio adapter is the same in both cases; the daemon optimization can come later.
6. **Source-highlights vs source-chunks.** Voxxo-swarm relay has both. Source highlights are agent-curated (small, dense). Source chunks are mechanical (every N lines, embedded). For brain-mcp we keep both. The `brain_recall` retrieval prefers highlights when present; falls back to chunks.
7. **What's the embedding model?** Default to OpenAI text-embedding-3-large (1536 dims, current voxxo-swarm choice) for compatibility. Configurable. Document which dim each table uses; resist mixing dims in a single vec0 table.
8. **Schema versioning.** Each DB has its own `_meta.schema_version`. Daemon refuses to start if schema is newer than its code. Migration runs on connect for older schemas.

### 14.3 Unknown unknowns

- **Will the host LLM actually use the brain_* tools well?** No way to know until it's deployed. Iterate prompts and field descriptions like we did with the schema-required pivot.
- **Will identity vectors converge to something useful?** Unknown. Mean-pool of touched-file embeddings is naive. Probably fine; iterate later.
- **Will SOP discovery find anything non-obvious?** Could be the most valuable feature; could be totally noisy. Ship it with filters and decide after a week of real use.

---

## 15. Why this is worth a day (or a week)

### 15.1 What you can't do today

- "When did this hazard first appear, who introduced it, what was the rationale" — can't answer. Atlas changelog has the data but no identity attribution; rebirth has identities but no code knowledge.
- "Show me the identities most relevant to refactoring auth code in vet-soap" — impossible. Each identity's specialty is implicit in transcripts; you'd have to read all transcripts to know.
- "Auto-suggest SOPs from observed agent behavior" — no system observes both rebirth's tool calls and atlas's commits in the same place.
- "Pull atlas plan_context into the rebirth handoff automatically" — handoff packager doesn't know atlas exists.

### 15.2 What you can do tomorrow if you ship this

- Time-traveling debug across hazard / pattern / commit history.
- Identity-aware code blame ("who maintains this file? not git author — who in our agent lineage?").
- Cross-repo identity portability via specialty vectors.
- Auto-discovered SOPs that codify your best workflows.
- Handoffs with 5-10× signal density per byte.
- Continuous identity bios that update from work history without manual edits.
- A genuine "organic brain" — meaningful, not metaphorical, because every claim has a concrete edge in the synapse table.

### 15.3 The deeper bet

This is infrastructure for the next 6-12 months of voxxo-swarm work. Right now atlas knowledge dies at the repo boundary; identity knowledge dies at the cross-MCP boundary; transcript knowledge dies at the session boundary. Each death is a separate forgetting. Brain-mcp is one substrate where none of those three is forgotten; they all reinforce each other.

If voxxo-swarm is the swarm-coordination layer, brain-mcp is the agent-memory layer. They are separate concerns and brain-mcp should not depend on the swarm — but the swarm becomes much sharper when its agents have continuous, semantic, auto-attributed memory.

---

## 16. What I'd commit on first push

A single PR that lands:

- `brain-mcp/` repo skeleton with `package.json`, `tsconfig.json`, `vitest.config.ts`.
- `brain-mcp/migrations/home/0001_init.sql` containing all home tables from §5.1.
- `brain-mcp/src/db/home.ts` — `openHomeDb()`, migration runner, attach helpers.
- `brain-mcp/src/atlas/` — lifted from voxxo-swarm `relay/src/atlas/` verbatim. Tests come along.
- `brain-mcp/src/identity/` — lifted from rebirth-mcp `src/identity/` (or whatever its name is) verbatim. Tests come along.
- `brain-mcp/src/edges/emit.ts` — the synapse-write layer. Called from atlas_commit.
- `brain-mcp/src/server.ts` — MCP server registering `identity_*` and `atlas_*` clusters. No `brain_*` yet; that's the second PR.
- `brain-mcp/src/bin/brain-mcp.ts` — CLI entrypoint, stdio MCP transport.
- `brain-mcp/src/bin/brain.ts` — operator CLI (`brain init`, `brain admin migrate-from-voxxo`, `brain admin scan-repos`).
- Migration tooling: `brain admin migrate-from-rebirth` reading `~/.claude/rebirth-index.sqlite`; `brain admin migrate-atlas <repo-path>` reading `<repo>/.atlas/atlas.sqlite` and edge-backfilling.
- README with one-screen quickstart.

Second PR adds `brain_*` cluster (resume, lineage, recall v1, when_did). Third PR adds embeddings + identity vectors. Fourth PR adds SOP discovery. Fifth PR adds handoff JSON.

---

## 17. The one-line summary

> **brain-mcp = atlas (semantic code memory) + rebirth (identity continuity) + atlas_identity_edges (the synapse) — in one MCP daemon, two SQLite files (~/.brain/brain.sqlite + per-repo atlas.sqlite), bridged via ATTACH, exposed through three tool clusters (identity_, atlas_, brain_), with auto-attribution, hazard-lifecycle attribution, SOP discovery, and structured atlas-inlay handoffs as the value-on-top.**

---

## 18. Closing thoughts

This is the kind of build where the design constraints all point in the same direction: separate-storage-bridged-via-ATTACH, three-cluster-naming, auto-attribution-from-env, edges-in-home-DB, embeddings-lazy-with-dirty-bits. There's not really a tension to resolve. The previous "wire them up" answer was the safe answer; the standalone build is the right answer if the user has appetite for a real rewrite, which they do.

The biggest mistake to avoid: don't get cute with the synapse layer. Edge writes are inserts. Edge reads are SQL. There is no graph-database-needed-here. Postgres-hipster-instinct will whisper "use a real graph DB"; ignore it. SQLite + indexes + ATTACH is the right tool. The whole point of this design is that everything is one process, two files, full-speed local. Once you reach for a network hop or a separate DB engine, you've lost the thing that made this fast.

The second biggest mistake: don't try to be too smart with the identity vector model on day 1. Mean-pool of touched-file embeddings + blurb embedding is good enough to start. If retrieval quality is bad after a week of real use, iterate the weights. Don't ship a multi-head attention model when you don't even know what queries people run.

The third biggest mistake: don't conflate brain-mcp with voxxo-swarm. Brain-mcp is the agent-memory layer. Voxxo-swarm is the swarm-coordination layer. They share atlas tooling today only because atlas got built inside voxxo-swarm. After brain-mcp ships, atlas is externalized and voxxo-swarm consumes it as a peer. Keep the layering clean.

Let's build it.

— atlas-schema-architect, 2026-04-26
