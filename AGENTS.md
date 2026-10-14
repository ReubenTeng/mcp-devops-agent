# mcp-devops-agent

Zero-DevOps infrastructure provisioning MCP server.

## Stack

- Node.js >= 20, ESM (`"type": "module"`), strict TypeScript.
- `@modelcontextprotocol/sdk` (McpServer + StdioServerTransport), `zod` for input schemas, `dotenv` for .env parsing, `ignore` for .gitignore handling.
- Build output goes to `dist/`; source lives in `src/` and imports use `.js` suffixes.

## Commands

- `npm ci` — install from the lockfile.
- `npm run build` — compile TypeScript to `dist/` (with `.d.ts` declarations).
- `npm test` — build, then run `node --test tests/*.test.mjs` (fully synthetic; no registry or provider network).
- `npm run test:package` — build, then run `node --test tests/package/*.test.mjs` (real `npm pack` + clean install; may contact the npm registry, never cloud providers).
- `npm run typecheck` — `tsc -p tsconfig.json --noEmit`.
- `npm run doctor` — offline CLI diagnostics (`node dist/index.js doctor`). Diagnostic path checks use lstat/access (ENOENT is the only "missing") without creating files, changing permissions, or reading project/state file contents. CLI startup may load the server working directory `.env` normally; values are never displayed.
- `npm start` — run the compiled server (`node dist/index.js`); `serve` is an explicit alias.
- `npm run dev` — run `src/index.ts` under `tsx watch`.

## Configuration

- `MCP_DEVOPS_PROJECT_ROOTS` — JSON array of absolute paths the tools may operate under (default: server cwd).
- `MCP_DEVOPS_STATE_DIR` — absolute path for agent state (default: `~/.local/state/mcp-devops-agent`); created lazily.
- Credentials come from `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `SUPABASE_ACCESS_TOKEN`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.

## Conventions and invariants

- In serve mode (the default and `serve` alias) stdout is reserved for MCP JSON-RPC. Never `console.log` from server code; use stderr only. The `--help`, `--version`, and `doctor` commands print to stdout by design and must run before dotenv/config loading where specified in `src/cli.ts`.
- Never log, echo, or return secret values in tool responses or stderr; only key names are reported.
- Filesystem access goes through `src/utils/files.ts`: canonical realpath boundary checks, no symlink following, per-file locks, atomic 0600 writes.
- Project-visible filesystem mutations (`.env` secret writes) and all remote mutations require `requireApproval` (MCP form elicitation) — real human consent through the host UI. No auto-approve paths or bypass env vars. Internal state journal writes under `MCP_DEVOPS_STATE_DIR` do not prompt.
- Budget policy is `approved_estimates` scoped per canonical local project: the projection aggregates baseline plus other active operations for that project only (shared subscription keys deduplicate within the project). It is not an account-wide or state-directory-wide budget. Plan estimates come only from the reviewed static catalog in `src/planning.ts` (`PRICING_REVIEWED_AT`) and operation cost formulas in `src/operations/service.ts`. Never invent provider costs, claim billing caps, or promise provisioning success. Stale pricing (>30 days) blocks paid prepare/execute.
- `analyze_project_infra` is read-only and bounded; it never executes project code, never reads `.env` values, and reports key names only.
- `toolResult` (src/errors.ts) is the only error path for tools: AppError codes/messages are safe to surface; everything else becomes `INTERNAL_ERROR`. `ProviderError` carries `status` and `ambiguous` only — never response bodies or tokens.
- Provider access goes through `src/providers/http.ts` (fixed origins, bearer auth, 15s timeout, 2MiB response cap, retries only for GET/read-only requests, mutations never retried).
- Mutations run through durable operations (`src/operations/`): prepare → approval → running persisted before mutation → succeeded/pending/failed/unknown. Reconcile via read-only lookups; never auto-retry a mutation.
- The operations store lives in `MCP_DEVOPS_STATE_DIR` (0700 dirs, 0600 files; ownership, symlink and permission bits are validated at init); `{id}.secret.json` vault files hold generated secrets and are never listed or returned.
