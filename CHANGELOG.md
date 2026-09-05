# Changelog

All notable changes to this project are documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/); versioning is [SemVer](https://semver.org/).

## [1.0.0] - 2026-09-05

First tagged release. Local-first, zero-dependency multi-agent group chat hub — one `node server/server.mjs`, no npm install.

### Added

- **Plugin adapters** (`server/adapters.d/`): drop one folder with a `plugin.json` manifest (id + `match.configKey` + module) and a default-exported adapter class to onboard any new agent — no core code changes. Manifest match outranks built-in type probing; broken plugins log and are skipped at boot, never fatal. A runnable example ships in `adapters.d/example/`; `GET /api/adapters/plugins` lists what is loaded.
- **Three-library UI** (left sidebar): Knowledge (search / preview / delete distilled notes), Skills (declarative JSON registration from the UI), ACL (grant / revoke / audit trail per group × agent × capability). Plus a one-click distill button (funnel icon) in the chat header that sinks the current group into the knowledge base.
- **Conversation-scoped adapters** — adapter instances are cached per `(agentId, convId)`: any native session state (DSH mirror session, MCP transport, bridge workspace) is isolated per group. One group = one project; context can no longer bleed across groups. Control-plane probes use their own instance.
- **Memory layer** (`server/memory/`, zero dependencies):
  - Knowledge base (L2): Obsidian-vault backend — distill-then-store writes append dated sections under the same title (distill, not stack, not delete); keyword search; traversal-safe paths. An ima cloud backend can plug into the same interface later.
  - Skills registry: declarative `skills.json` (each skill must carry a prompt or tools) — adding a skill is editing JSON, not code.
  - ACL: fail-closed, conversation-scoped grants with an audit trail (`grantedBy` + timestamp on every grant).
- **Memory engine pipes**:
  - L0 working-memory budget: context assembly trims oldest turns beyond `ctxBudgetChars` (default 12000), always keeping the turn being answered.
  - Distill pipe (L1 → L2): consensus conclusions are auto-written to the KB via the conclusion hook; whole-group digests or pinned messages via `POST /api/memory/distill`.
  - Retrieval pipe (L2 → L0): up to 3 KB hits for the turn prompt are injected as `recall` into every adapter class. A recall failure never fails a turn.
- **REST**: `/api/kb/*`, `/api/skills`, `/api/acl/*`, `/api/memory/distill`.
- **CI**: GitHub Actions matrix (Node 18/20/22 × Ubuntu/Windows), zero-install `npm test`.
- **Single-instance lock**: pid lockfile with liveness check, stale-lock takeover, and exit cleanup — tray + manual launch can no longer race on `data.json`.

### Fixed

- `/files` endpoint rejected POSIX absolute paths (`/tmp/...`); the guard only recognized Windows drive letters and UNC shares — caught by CI on Linux runners.
- MCP stdio client: a timed-out request now kills the child process tree (Windows `taskkill /T /F`, POSIX process group) with a hard 3s cap on the kill call, instead of leaving an orphaned server buffering stdout forever. A dead-pipe write can no longer hang a turn forever.
- MCP stdio timeouts never actually rejected the caller: the rejection referenced the promise executor's scoped `reject` from the timer callback (a `ReferenceError`), so a slow server only failed via the later close path. Rejections now resolve the same promise the caller awaits.
- An `unhandledRejection` (process-fatal on modern Node) fired on every MCP timeout because the `p.finally(clearTimeout)` derived promise re-raised the rejection unhandled; replaced with a settled two-branch `then`.
- Cross-platform listening-port enumeration (netstat / ss / lsof) replaces the Windows-only `netstat -ano` call in WorkBuddy ACP discovery; a configured port skips the scan entirely.
- DSH adapter keys its mirror-session state by conversation as defense-in-depth under the bus-level isolation.

### Changed

- Repository: dev probe scripts (`scripts/archive/`, 40 files) untracked and gitignored; runtime app data (`kb/`, `skills.json`, `acl.json`) gitignored.
- Model API agents accept per-agent `maxTokens` config; the field is only sent when configured (some providers reject explicit nulls).
- UI: all remaining emoji / text glyphs (✕ ✓ ⚠ ↓ ↻ ↗ ↳ ▾ ▴ ▸) replaced with inline SVG icons; the icon set gained x / chevup / arrowl / arrowr / ext / deleg / funnel / shield / book.

### Notes

- `scripts/archive/` files were present in early public history; they contain no secrets (`.env`/runtime data were ignored from the start) and history was not rewritten.
