# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Paperclip is a control plane for AI-agent companies — it orchestrates teams of AI agents to perform work across issues, projects, and goals. Before making changes, read in order: `doc/GOAL.md`, `doc/PRODUCT.md`, `doc/SPEC-implementation.md`, `doc/DEVELOPING.md`, `doc/DATABASE.md`. The V1 build contract is `doc/SPEC-implementation.md`.

## Commands

```sh
pnpm install       # install all workspace deps
pnpm dev           # start API + UI in watch mode (localhost:3100)
pnpm build         # build all workspace packages
pnpm typecheck     # typecheck all workspace packages
pnpm test          # run Vitest unit suite (no browser)
pnpm test:e2e      # Playwright e2e (opt-in only)
pnpm db:generate   # generate Drizzle migration (compiles db first)
pnpm db:migrate    # apply pending migrations
```

Dev check before claiming done:
```sh
pnpm -r typecheck && pnpm test:run && pnpm build
```

Run a single Vitest test file:
```sh
pnpm vitest run path/to/test.test.ts
```

Reset local dev DB (uses embedded Postgres when `DATABASE_URL` is unset):
```sh
rm -rf data/pglite && pnpm dev
```

**Lockfile policy:** Do not commit `pnpm-lock.yaml` in PRs — CI owns it via the `refresh-lockfile` workflow.

## Architecture

This is a **pnpm monorepo** (`pnpm-workspace.yaml`). All packages are ESM, TypeScript strict, targeting `ES2023` with `NodeNext` module resolution, compiled to `dist/`.

### Core packages

| Package | Purpose |
|---|---|
| `server/` | Express 5 REST API on port 3100. Auth (Better Auth), WebSocket realtime, plugin host, all orchestration services |
| `ui/` | React 19 + Vite SPA. Served by the API server. Proxies `/api` to port 3100 in dev |
| `packages/db/` | Drizzle ORM schema + numbered SQL migrations for PostgreSQL |
| `packages/shared/` | Types, Zod validators, API path constants shared across all layers |
| `packages/adapters/*/` | Agent runtime adapters (Claude, Codex, Cursor, etc.) — each exports `server`, `ui`, and `cli` sub-paths |
| `packages/plugins/sdk/` | Stable public API for plugin authors |
| `cli/` | `paperclipai` CLI for onboarding, worktrees, issue management |

### Key architectural patterns

**Company scoping** — every domain entity is scoped to a company. Routes and services must enforce company boundaries on all queries and mutations.

**Four-layer contract** — schema changes must be propagated across all four layers: `packages/db` (schema + migration) → `packages/shared` (types/validators) → `server` (routes/services) → `ui` (API clients/pages). Never update one layer without syncing the others.

**Auth** — Better Auth for board users (session cookies). Agents authenticate with bearer API keys stored hashed in `agent_api_keys`. Deployment modes: `local_trusted` (loopback, no auth) and `authenticated`.

**Plugin system** — plugins run as separate worker processes managed by the server. The `plugin-sdk` package is the stable authoring API.

**Adapter registry** — the server has a mutable adapter registry (`server/src/adapters/registry.ts`). External adapters can be registered via `~/.paperclip/adapter-plugins.json`.

**Control-plane invariants to preserve:**
- Single-assignee task model
- Atomic issue checkout semantics
- Approval gates for governed actions
- Budget hard-stop auto-pause
- Activity logging for all mutating actions

### API conventions

- Base path: `/api`
- New endpoints must: apply company access checks, enforce actor permissions (board vs agent), write activity log entries for mutations, return standard HTTP errors (`400/401/403/404/409/422/500`)

## Database Change Workflow

1. Edit `packages/db/src/schema/*.ts`
2. Export new tables from `packages/db/src/schema/index.ts`
3. `pnpm db:generate` (compiles `packages/db` first, then runs drizzle-kit)
4. `pnpm -r typecheck` to validate

Migration files are numbered (`0000_...sql` through `006x_...sql`). Migration numbering is validated automatically before builds.

## Pull Request Requirements

Every PR must use the template at `.github/PULL_REQUEST_TEMPLATE.md`. Required sections:
- **Thinking Path** — 5–8 step reasoning trace from project context to the specific change
- **What Changed** — bullet list of concrete changes
- **Verification** — commands/steps to confirm it works
- **Risks** — what could break
- **Model Used** — AI model used (provider, model ID) or "None — human-authored"
- **Checklist** — all items checked
