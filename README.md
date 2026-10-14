# mcp-devops-agent

Zero-DevOps infrastructure provisioning for vibe coders and builders.

A local, stdio-based MCP server that provisions cloud infrastructure for a project under explicit approval. Every remote mutation and every project `.env` write requires an approval form rendered by your MCP client. Internal operation journals are recorded automatically. Approval depends on the client faithfully presenting the form to the user.

## What it does

- Vercel: create projects, deploy from local source uploads, deploy immutable GitHub commits, sync approved `.env` keys, attach and verify custom domains, and roll back to a previous production deployment.
- Supabase: provision projects on an existing organization, then sync the generated credentials (URL, publishable/anon key, optional service-role key, bound database password) into the local `.env` after approval.
- Cloudflare: search registrable domains, fetch live price quotes, register domains, create DNS zones, and create or update A/AAAA/CNAME/TXT records.

Unsupported infrastructure such as Redis, MySQL, AWS, private registries, and unmanaged account spend is never provisioned or estimated.

## Requirements

- Node.js 20 or later.
- An MCP client that supports form elicitation. Without it you can analyze, plan, and read state, but no cloud mutation or `.env` write is possible. There is no boolean/flag approval bypass.
- A GitHub repository must already be connected to your Vercel account for GitHub deploys. The server does not create repositories, run local build scripts, or configure private registries; Vercel builds remotely.

## Setup

```sh
npm ci
npm run build
npm test
node /absolute/path/to/mcp-devops-agent/dist/index.js
```

`npm run dev` runs the TypeScript entrypoint under `tsx watch` for development.

This is a stdio MCP server. stdout is reserved for JSON-RPC; it is not an HTTP server and must be launched by your MCP client (or run standalone for debugging, where it will sit waiting on stdin).

## Command line

The `mcp-devops-agent` executable (the installed `bin`, or `node dist/index.js`) accepts exactly these forms:

- `mcp-devops-agent` or `mcp-devops-agent serve` — start the stdio MCP server (default behavior).
- `mcp-devops-agent --help` / `-h` — print usage, environment variables, and the approval model. Works without any configuration or credentials.
- `mcp-devops-agent --version` / `-v` — print `mcp-devops-agent <version>` and exit.
- `mcp-devops-agent doctor` / `doctor --json` — offline local diagnostics: Node version, configured project roots, state-directory permissions, and provider credential presence (names only, never values). It makes no provider API calls, verifies no authentication, and writes no files; it exits 1 only when local configuration, runtime, or paths are unhealthy. Missing credentials are warnings — local analysis and planning remain available, and remote reads require the relevant credentials.

Anything else exits 2 with a fixed error message. Help and version run before `.env` loading, so they work even with malformed configuration.

## Packaged installation

`npm pack` builds `dist/` and produces a private npm tarball containing only `dist/**/*.js`, `dist/**/*.d.ts`, `dist/**/*.js.map`, and `README.md` (npm adds `package.json` automatically). Install it in another project with `npm install <tarball>`; the `mcp-devops-agent` executable then appears in `node_modules/.bin` and can be used as the MCP client command or for `doctor`/`--version`. The package is `private: true` — publication is intentionally disabled and no license has been chosen.

## MCP client configuration

Configure your client's MCP section with an absolute node binary and the absolute script path, or with the installed `mcp-devops-agent` executable from `node_modules/.bin`, plus the allowed project roots as a JSON array string. Example shape (do not copy host-specific config verbatim; adapt to your client):

```json
{
  "mcpServers": {
    "mcp-devops-agent": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/mcp-devops-agent/dist/index.js"],
      "env": {
        "MCP_DEVOPS_PROJECT_ROOTS": "[\"/absolute/path/to/your/project\"]"
      }
    }
  }
}
```

`MCP_DEVOPS_PROJECT_ROOTS` limits project-file access and the local projects associated with infrastructure changes (default: the server's working directory). Operation journals use the separate state directory. Remote access is additionally scoped by provider credentials and account identifiers; project roots are not a cloud-account permission boundary.

## Credentials and environment

Provider credentials belong in the client process environment or the server working directory `.env`, which dotenv loads quietly at startup. Project `.env` files are accessed separately for explicitly requested secret-management operations:

- `VERCEL_TOKEN`, `VERCEL_TEAM_ID`
- `SUPABASE_ACCESS_TOKEN`
- `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`

Never paste credential values into chat. The server returns only key names and safe identifiers, and validates every provider response before use.

`MCP_DEVOPS_STATE_DIR` is an optional private directory for the operation journal and generated-secret vaults. Point it at an existing `0700` directory outside the deployable project; the default is `~/.local/state/mcp-devops-agent`. Directories are created with `0700` permissions and journal files with `0600`; generated database-password vaults are also `0600`. Keep the journal — it is what makes crash recovery, reconciliation, and budget bookkeeping possible. Do not delete operation history to clear budgets.

## Workflow

The tools form a deliberate pipeline rather than a single magic command:

1. `analyze_project_infra` — read-only, bounded scan of the project (framework, package manager, env key names, infrastructure hints).
2. `propose_infra_plan` — provider comparisons and reviewed baseline estimates. Vercel Pro assumes one $20/mo seat. Supabase Pro's catalog baseline is $25/mo for one Micro project with its included compute credit; actual provisioning conservatively reserves $35/mo because that shared credit may already be used.
3. `check_provider_connections` — verifies which credentials are configured with read-only calls.
4. `prepare_infrastructure_change` — validates preconditions, prices the change, and stores a short-lived prepared operation. Nothing remote changes yet.
5. `execute_infrastructure_change` — renders the approval form (action, account, exact estimate, warnings, file list) and runs the mutation only after acceptance.
6. `get_operation` with `refresh: true` — read-only remote checks update pending operations.

Additional tools: `list_operations`, `cancel_operation` (prepared only — applied changes are not reverted), `reconcile_operation` (resolves `unknown`/crashed operations via deterministic read-only lookups), `get_resource_status`, `inspect_vercel_domain`, `search_domains`, `check_domain_availability`, and `write_env_secrets`.

`pending` means completion has not yet been confirmed. `succeeded` means the requested step completed according to the provider response, a subsequent status check, or the local file write. `failed` reports a failure, and `unknown` means the mutation may have partially applied and needs reconciliation. An operation is never blindly resubmitted; a failed deployment does not imply that previously created resources or charges were reversed.

The host client orchestrates multi-resource work; there is no single atomic transaction across providers.

### Typical sequences

Supabase: `create_supabase_project` → `get_operation` refresh until `ACTIVE_HEALTHY` → `sync_supabase_env` to write credentials into the local `.env` → `sync_env_to_vercel` to publish selected keys to Vercel → `deploy_vercel`.

Domain: `search_domains` / `check_domain_availability` → `prepare_infrastructure_change` with `register_domain` and an explicit `maxUpfrontBudgetUsd` estimate limit → approve → track via `get_operation` refresh.

DNS and custom domain: `create_cloudflare_zone` → wait for nameservers (`get_operation` refresh) → `connect_vercel_domain` → `inspect_vercel_domain` → `upsert_dns_record` → `verify_vercel_domain` (an action on `prepare_infrastructure_change`, not a separate tool).

Rollback: `rollback_vercel` re-points production to a previous READY deployment. Rollback affects hosting only — it does not touch database data and does not delete or reverse other resources.

Example prepare payloads:

```json
{
  "projectPath": "/absolute/path/to/project",
  "action": { "kind": "create_vercel_project", "name": "my-app", "framework": "nextjs" },
  "maxMonthlyBudgetUsd": 20,
  "commercialUse": true
}
```

```json
{
  "projectPath": "/absolute/path/to/project",
  "action": {
    "kind": "deploy_vercel",
    "projectId": "prj_abc123",
    "name": "my-app",
    "target": "production",
    "source": { "type": "github", "org": "my-org", "repo": "my-app", "sha": "0123456789abcdef0123456789abcdef01234567" }
  },
  "maxMonthlyBudgetUsd": 25,
  "commercialUse": true
}
```

GitHub deploys require an immutable 40-character commit SHA. The deploy `name` must equal the real remote project name.

## Budgets and pricing

Approved estimates are scoped per local project: the projection is the catalog baseline plus other active operations for the same project, deduplicated by shared subscription keys. Estimates are not billing caps — usage overages, taxes, add-ons, and unmanaged or unrelated account spend are excluded.

Prices come from a reviewed static catalog (reviewed 2026-10-10). Pricing older than 30 days blocks new paid prepares and executes. Account plans are never upgraded automatically; commercial Vercel use requires Pro.

Domain pricing uses a live quote fetched immediately before the mutation. Execution is blocked if the quote changes, but the price can still change between the final check and checkout. The Cloudflare API has no atomic maximum-price parameter: re-quoting is not an enforceable checkout cap. Registrations are non-refundable, are created with `auto_renew: false`, and require Cloudflare dashboard billing/contact/agreement prerequisites to already be in place.

## Deployment limits and ignores

Local uploads are bounded and filtered: at most 5,000 files, 20,000 scanned entries, 50 MiB total, 20 MiB per file, depth 20. `.env` and credential material, package-manager credential configs (`.npmrc`, `.yarnrc`, `.yarnrc.yml`, `.pypirc`, `.netrc`, `.git-credentials`), protected directories, symlinks, and gitignored files are excluded. Safe build dotfiles (`.nvmrc`, `.node-version`, `.babelrc`, `.browserslistrc`) and `.well-known` static assets are allowed. Skipped credential configuration is reported as a warning; private registry installs are not supported.

## Development

- `npm test` builds and runs the unit and synthetic integration suite (`tests/*.test.mjs`): mocked provider fetches, temp directories, and in-memory or spawned stdio MCP transports. It performs no provider network calls and no npm registry access.
- `npm run test:package` (`tests/package/`) packs the real tarball, installs it into a clean consumer, exercises the installed executable over stdio, and checks the public API surface. It may contact the npm registry for package metadata and dependencies; it never contacts cloud providers.
- `npm run doctor` runs the offline diagnostic against the current environment.
- `npm run typecheck` type-checks without emitting.

Live account behavior requires real accounts and real approvals and is not covered by the test suite.

A GitHub Actions workflow is configured in `.github/workflows/ci.yml` covering six combinations — Node 20, 22, and 24 on Ubuntu and macOS — running `npm ci`, `npm test`, and `npm run test:package` with pinned action SHAs and read-only permissions. Node 20 is the supported minimum; prefer Node 22 or 24 for new environments.
