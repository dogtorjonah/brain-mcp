# @voxxo/brain-mcp

**Persistent memory layer for Claude Code** — identity lineage, codebase atlas, transcript search, SOPs, and session respawn, all as a local MCP server backed by SQLite.

## What it does

brain-mcp gives Claude Code a **persistent, self-improving memory** that survives across sessions and context rebirths with zero cloud dependencies:

- **Identity tracking** — named agent identities with specialty signatures, SOPs, handoff notes, and a full lineage of who touched what file and when
- **Codebase Atlas** — per-repo code intelligence graph storing purpose, hazards, patterns, public API, import edges, clusters, and changelog for every source file
- **Hybrid search** — BM25 + 384-dim vector embeddings (local ONNX, no API calls) across transcripts, atlas files, changelogs, and source highlights
- **Session respawn** — when context fills up, builds a structured handoff packet and relaunches Claude in a fresh session via the `brain-claude` wrapper
- **SOP discovery** — detects repeated tool-call patterns and promotes them into standing operating procedures

## Install

```bash
npm install -g @voxxo/brain-mcp
brain setup
```

The `brain setup` wizard runs five idempotent steps:

| Step | What it does |
|------|-------------|
| **shim** | Appends `claude() { brain-claude "$@"; }` to your shell rc file |
| **mcp** | Registers brain-mcp via `claude mcp add brain-mcp -s user` |
| **brain-home** | Creates `~/.brain/` and runs migrations on `brain.sqlite` |
| **claude-md** | Appends atlas-first usage guidance to `~/.claude/CLAUDE.md` |
| **embeddings** | Pre-fetches the local HF embedding model (~30 MB) |

Skip any step with `--no-<step>`. Re-running is always safe — each step detects if it's already done.

### Manual install (without npm global)

```bash
git clone https://github.com/dogtorjonah/brain-mcp.git
cd brain-mcp
npm install && npm run build
brain setup
```

### Add to Claude Code directly

```bash
claude mcp add brain-mcp -s user -- npx -y @voxxo/brain-mcp
```

## Architecture

### Two processes

brain-mcp runs as a **thin MCP adapter** that auto-starts a **long-lived daemon** on first tool call:

```
Claude Code ←stdio→ brain-mcp (adapter) ←unix socket→ brain-daemon
```

- **brain-mcp** — the MCP server Claude Code connects to. Proxies every tool call to the daemon over a Unix socket at `~/.brain/brain.sock`. Auto-starts the daemon if it's not running.
- **brain-daemon** — singleton process that owns all SQLite databases, embedding workers, atlas pools, and background indexers. Shared across concurrent Claude sessions.

### Data storage

All data lives in **local SQLite databases** — no cloud, no API calls for memory:

| Database | Location | Contents |
|----------|----------|----------|
| **Home DB** | `~/.brain/brain.sqlite` | Identity profiles, chain events, SOPs, handoff notes, specialty signatures, synapse edges, transcript search index |
| **Atlas DB** | `<repo>/.brain/atlas.sqlite` | Per-repository code intelligence (file metadata, changelog, import edges, clusters, source highlights) |

Both use WAL mode for safe concurrent access.

### brain-claude wrapper

The `brain-claude` shell wrapper replaces `claude` as a function in your shell. It:

1. Launches Claude Code normally
2. Watches for a **respawn sentinel** written by `brain_respawn`
3. When Claude exits and a sentinel exists, reads the handoff file and relaunches Claude with it as the initial prompt
4. Supports mid-flight identity swaps via sidecar files
5. Passes through `--effort`, `--model`, and `--identity` flags across respawns

## Tools

brain-mcp exposes **18 tools** to Claude Code, organized into three groups:

### Brain tools

| Tool | Purpose |
|------|---------|
| `brain_daemon_status` | Inspect the running daemon — caller context, pools, registered tools |
| `brain_search` | Cross-silo hybrid search (transcripts + atlas files + changelog + source highlights) |
| `brain_resume` | "Where did I leave off?" — open hazards, recent work, SOPs, next-step hint |
| `brain_lineage` | Per-file identity timeline (who touched what, when) |
| `brain_when_did` | Time-travel debug ("when did X first appear?") |
| `brain_specialize` | Recompute the current identity's specialty signature |
| `brain_recommend` | Rank identities by fitness for a task |
| `brain_diff_identities` | Compare two identities side-by-side |
| `brain_respawn` | Build a handoff packet + trigger wrapper relaunch |
| `brain_handoff` | Build a rich diagnostic/archival handoff snapshot |
| `brain_sop_candidates` | Discover repeated tool-call patterns worth promoting |
| `identity_sop_promote` | Promote a discovered pattern into a standing SOP |

### Atlas tools (composite — 5 tools, 20+ actions)

| Tool | Actions | Purpose |
|------|---------|---------|
| `atlas_query` | `search`, `lookup`, `brief`, `snippet`, `similar`, `plan_context`, `cluster`, `patterns`, `history` | Codebase discovery, inspection, and structured context |
| `atlas_graph` | `impact`, `neighbors`, `trace`, `cycles`, `reachability`, `graph`, `cluster` | Dependency analysis, blast radius, import/call graphs |
| `atlas_audit` | `gaps`, `smells`, `hotspots` | Quality and risk scanning |
| `atlas_admin` | `init`, `reset`, `reindex`, `bridge_list`, `merge` | Atlas maintenance and workspace discovery |
| `atlas_changelog` | `query` | File-level changelog queries (writing is via `atlas_commit`) |
| `atlas_commit` | — | Post-edit metadata writeback (purpose, hazards, patterns, changelog) |

## Source layout

```
src/
├── bin/
│   ├── brain-mcp.ts              # MCP server entrypoint (stdio adapter)
│   └── brain-daemon.ts           # Daemon entrypoint (unix socket server)
├── adapter/                      # MCP adapter ↔ daemon bridge
│   ├── registerProxyTools.ts     # Discovers daemon tools, registers as MCP proxies
│   ├── client.ts                 # Unix socket client for daemon RPC
│   ├── daemonProcess.ts          # Auto-start daemon if not running
│   └── env.ts                    # Caller context (cwd, pid, identity, session)
├── daemon/                       # Daemon internals
│   ├── server.ts                 # Unix socket server + health HTTP endpoint
│   ├── runtime.ts                # Owns DBs, atlas pool, embedding workers
│   ├── toolRegistry.ts           # Tool name → handler dispatch
│   ├── registrars.ts             # Wires atlas + brain tools into registry
│   ├── protocol.ts               # JSON-line protocol types
│   ├── atlasToolPool.ts          # Per-workspace atlas DB connection pool
│   ├── resourcePool.ts           # Generic resource pool
│   ├── requestContext.ts         # Per-request caller context threading
│   ├── workers.ts                # Background worker orchestration
│   └── paths.ts                  # ~/.brain/ path resolution
├── atlas/                        # Codebase Atlas engine
│   ├── server.ts                 # Standalone atlas MCP server (also used embedded)
│   ├── db.ts                     # Atlas SQLite schema + migrations
│   ├── config.ts                 # Atlas configuration
│   ├── types.ts                  # Atlas type definitions
│   ├── watcher.ts                # File-system change watcher
│   ├── embeddings.ts             # Atlas-level embedding support
│   ├── lifetimeDigest.ts         # Lifespan changelog arc for handoffs
│   ├── pipeline/                 # Indexing pipeline
│   │   ├── scan.ts               # File discovery + content hashing
│   │   ├── structure.ts          # Tree-sitter symbol extraction
│   │   ├── crossref.ts           # Import/call edge extraction
│   │   ├── community.ts          # Cluster detection
│   │   ├── flow.ts               # Pipeline orchestration
│   │   └── treesitter.ts         # Tree-sitter grammar loading
│   └── tools/                    # Atlas tool implementations
│       ├── query.ts              # Composite: search/lookup/brief/snippet/similar/plan_context
│       ├── graphComposite.ts     # Composite: impact/neighbors/trace/cycles/reachability
│       ├── audit.ts              # Composite: gaps/smells/hotspots
│       ├── admin.ts              # Composite: init/reset/reindex/bridge_list/merge
│       ├── commit.ts             # Post-edit metadata writeback
│       ├── changelog.ts          # Changelog query tool
│       └── bridge.ts             # Cross-workspace bridge discovery
├── home/                         # Home database
│   └── db.ts                     # ~/.brain/brain.sqlite connection + migrations
├── identity/                     # Identity subsystem
│   └── store.ts                  # Profiles, chains, SOPs, specialty signatures
├── edges/                        # Synapse edges
│   └── emitter.ts                # Identity↔file relationship tracking
├── search/                       # Hybrid search engine
│   ├── brainSearch.ts            # brain_search tool registration
│   ├── crossSiloFusion.ts        # Cross-silo reciprocal rank fusion
│   ├── scopeResolver.ts          # Search scope → silo mapping
│   ├── transcriptSearch.ts       # Transcript indexing + search
│   ├── transcriptStore.ts        # FTS5 + sqlite-vec store
│   ├── transcriptEmbed.ts        # Local ONNX embeddings (BGE-small-en-v1.5, 384-dim)
│   ├── transcriptChunk.ts        # Transcript → chunk splitting
│   ├── transcriptRrf.ts          # BM25+vector reciprocal rank fusion
│   └── transcriptTokenize.ts     # FTS query preparation
├── sop/                          # SOP discovery + promotion
│   ├── candidatesTool.ts         # brain_sop_candidates tool
│   ├── promoteTool.ts            # identity_sop_promote tool
│   ├── worker.ts                 # Background SOP pattern detection
│   ├── hasher.ts                 # Tool-call sequence hashing
│   └── normalizer.ts             # Pattern normalization
├── tools/                        # Brain tool implementations
│   ├── registerAllTools.ts       # Master tool registration
│   ├── brain_resume.ts           # "Where did I leave off?"
│   ├── brain_search.ts → search/ # (registered via brainSearch.ts)
│   ├── brain_lineage.ts          # File-identity timeline
│   ├── brain_when_did.ts         # Time-travel debug
│   ├── brain_specialize.ts       # Specialty signature computation
│   ├── brain_recommend.ts        # Identity fitness ranking
│   ├── brain_diff_identities.ts  # Identity comparison
│   ├── brain_respawn.ts          # Session respawn + wrapper relaunch
│   └── brain_handoff.ts          # Rich handoff snapshot builder
├── package/                      # Handoff package builder
│   ├── build.ts                  # Section renderer
│   ├── sections.ts               # Section layout
│   ├── gradient.ts               # Gradient-bucketed activity log
│   ├── fileContext.ts            # File-set collection for atlas cross-refs
│   ├── gitStatus.ts              # Git status integration
│   ├── history.ts                # History extraction
│   └── todos.ts                  # TODO extraction
├── trace/                        # Transcript parsing
│   ├── parse.ts                  # JSONL transcript reader
│   ├── reduce.ts                 # Transcript reduction
│   ├── effort.ts                 # Effort level estimation
│   └── types.ts                  # Trace types
├── persistence/denseRetrieval/   # Embedding infrastructure
│   ├── embedClient.ts            # Embedding client
│   ├── embedWorker.ts            # Background embedding worker
│   └── types.ts                  # Embedding types
├── io/                           # I/O and respawn
│   ├── selfSpawn.ts              # Self-spawn for wrapper relaunch
│   ├── respawn.ts                # Respawn sentinel management
│   ├── chain.ts                  # JSONL chain reader
│   └── shim.ts                   # Shim utilities
├── bridge/                       # Cross-workspace bridge
│   ├── connectionPool.ts         # Atlas DB connection pool
│   ├── workspaceLocator.ts       # Workspace discovery
│   └── attachCoordinator.ts      # Atlas attach coordination
├── install/                      # Install wizard
│   ├── wizard.ts                 # `brain setup` orchestrator
│   ├── shim.ts                   # Shell shim installer
│   ├── brainHome.ts              # ~/.brain/ initializer
│   ├── claudeMd.ts               # CLAUDE.md guidance appender
│   └── embeddings.ts             # Embedding model pre-fetcher
├── cli/                          # CLI
│   ├── brain.ts                  # Multi-subcommand dispatcher
│   └── migrate.ts                # rebirth-mcp → brain-mcp migration
└── binaryResolution.ts           # Native binary (tree-sitter, sqlite) resolution
```

## CLI

```bash
brain setup                # Full install wizard
brain migrate              # Import from rebirth-mcp
brain install-shim         # Just the shell shim
brain uninstall-shim       # Remove the shell shim
brain warm-embeddings      # Pre-fetch embedding model
brain help                 # Usage
```

## Embeddings

Transcript and atlas search uses **BGE-small-en-v1.5** (384 dimensions) via `@huggingface/transformers` running locally through ONNX Runtime. No API calls, no cloud — the model is downloaded once (~30 MB) and cached in the HuggingFace cache directory.

If the embedding model isn't available, search falls back to **BM25-only** (FTS5) with no vector component.

## Configuration

brain-daemon accepts CLI flags:

```bash
brain-daemon --socket /path/to/brain.sock   # Custom socket path
             --home /path/to/.brain          # Custom brain home directory
             --db /path/to/brain.sqlite      # Custom home DB path
             --health-port 7420              # Custom health check port
             --atlas-pool-size 4             # Max concurrent atlas DB connections
```

Environment variables read by the adapter:

| Variable | Purpose |
|----------|---------|
| `CLAUDE_IDENTITY` | Override identity name (set by brain-claude wrapper) |
| `BRAIN_WRAPPER_PID` | PID of the brain-claude wrapper (for respawn) |
| `BRAIN_WRAPPER_PROJECT_DIR` | Project directory for respawn sentinels |

## Development

```bash
npm run build              # Compile TypeScript
npm run check              # Type-check only (no emit)
npm run dev                # Watch mode for MCP server
npm run dev:daemon         # Watch mode for daemon
```

## Dependencies

| Package | Purpose |
|---------|---------|
| `@modelcontextprotocol/sdk` | MCP server framework |
| `better-sqlite3` | SQLite driver (WAL mode, FTS5) |
| `sqlite-vec` | Vector similarity search extension |
| `@huggingface/transformers` | Local ONNX embedding inference |
| `tree-sitter` + grammars | Source code parsing for symbol extraction |
| `zod` | Runtime schema validation |

## License

MIT
