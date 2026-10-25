# mcp-devops-agent

An MCP server for planning and provisioning infrastructure through chat.
Node.js 20+, ESM, TypeScript. Version 2 replaces the v1 MCP schemas.

Stdio is the default. `node dist/index.js serve-http` runs a remote service for
one operator with private bearer authentication. See [HTTP setup](DEPLOYMENT.md#remote-http-service)
for HTTPS, persistent state, project access and client requirements.

## Current implementation

The planner composes providers by capabilities, persists workload fingerprints,
environments, budgets, adapter checksums, dependency steps and safe resource
identities. Missing credentials produce setup instructions.

Bundled mutations cover Vercel, Supabase, Cloudflare, prebuilt public GitHub
Pages sites, and a Render template for a remote MCP service. The Render template
uses a public GHCR image pinned by SHA-256 and one persistent disk. More than thirty catalog
manifests supply recommendation leads. **Catalog support does not mean executable
provisioning support.** Additional providers require explicitly installed,
checksum-pinned executable adapters. Full cloud-provider coverage and reviewed
OpenTofu modules remain in development; see [status](IMPLEMENTATION_STATUS.md).

## Connect

Run `npm ci`, `npm run build`, then `npm test`. Configure an MCP client:

```json
{
  "mcpServers": {
    "infrastructure": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/mcp-devops-agent/dist/index.js"],
      "env": {
        "MCP_DEVOPS_PROJECT_ROOTS": "[\"/absolute/path/to/application\"]"
      }
    }
  }
}
```

The client must support human form elicitation for mutations. Credentials belong
in the process environment or the server working directory `.env`, never chat:

- `VERCEL_TOKEN`, `VERCEL_TEAM_ID`
- `SUPABASE_ACCESS_TOKEN`
- `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`
- `GITHUB_TOKEN` for eligible prebuilt public GitHub Pages sites.
- `RENDER_API_KEY`, `RENDER_OWNER_ID`, `RENDER_MCP_HTTP_TOKEN` for the Render
  template. The last setting is the private bearer token for the hosted service.

Existing accounts need billing, permissions and agreements configured. Project
roots constrain local access, not cloud-token permissions.

## Chat workflow

1. `analyze_project_infra({projectPath})`: bounded workload analysis, source
   fingerprint and environment key names; no code execution or environment values.
2. `list_provider_capabilities` / `discover_providers`: distinguish executable
   adapters from catalog/advisory leads. Network discovery is opt-in.
3. `propose_infrastructure_plan({projectPath,constraints,overrides?})`: persist a
   ranked architecture. Scores: fit 40%, reliability 25%, simplicity 20%, cost 15%.
   Unknown prices stay unknown; alternatives are Pareto candidates.
4. `prepare_infrastructure_plan({planId})`: prepare ready dependency steps and
   reserve project budget. Blocked steps report setup requirements.
5. `execute_infrastructure_step({planId,stepId})`: approve that exact mutation
   and estimate. Source, account and prices are checked again. Prepare later steps
   after their predecessors finish.
6. `get_infrastructure_plan({planId,refresh:true})` /
   `reconcile_infrastructure_step`: read-only recovery, no mutation retry.
7. `verify_infrastructure_plan`: distinguish completed operations from application
   probes. Unverified health/database/secrets requirements remain explicit.

Other tools: `list_infrastructure_plans`, `cancel_infrastructure_step`,
`propose_teardown_plan`, `search_domains`, `quote_domain`,
`check_provider_connections`, `write_env_secrets`.

Example:

```json
{
  "projectPath": "/absolute/path/to/application",
  "constraints": {
    "maxMonthlyBudgetUsd": 60,
    "maxUpfrontBudgetUsd": 20,
    "environment": "production",
    "commercialUse": true
  },
  "overrides": {
    "providers": {"serverless":"vercel","postgres":"supabase"},
    "parameters": {
      "supabase": {"organizationSlug":"existing-org","region":"us-east-1"}
    },
    "domain": {"name":"example.com","purchase":false}
  }
}
```

Supabase needs an existing organization and available region. Dependencies cover
database creation, approved local credential transfer, hosting environment and
deployment. Detected public framework names map only to public Supabase settings.
Other application secrets must still be configured privately.

Domain purchase requires `purchase:true`, upfront budget, a fresh quote and its own
approval. Cloudflare checkout has no atomic maximum-price parameter; approval
discloses renewal prices and tax/privacy uncertainty. Other registrars require
executable adapters. Contact data belongs in provider profiles, never plan arguments.

## Adapter SDK

`MCP_DEVOPS_ADAPTERS` is a JSON array:

```json
[{
  "manifestPath":"/absolute/path/provider.json",
  "manifestSha256":"<64 lowercase hex characters>",
  "entrypoint":"/absolute/path/provider.mjs",
  "sha256":"<64 lowercase hex characters>",
  "credentialNames":["PROVIDER_API_KEY","PROVIDER_ACCOUNT_ID"]
}]
```

Use the strict manifest schema in `src/v2/schema.ts` and request/response contract
in `src/v2/adapter.ts`. A standalone bundle reads one JSON request on stdin, writes
one JSON response and exits. Prepare returns exact mutations, account, estimate,
preconditions and a maximum ten-minute expiry. Execute/reconcile return normalized
outcomes and safe identities. Quote/search return domain offers. Verify returns
semantic checks. Catalog manifests omit executable operations and entrypoints.

Bundles run in temporary directories with declared credential/account settings,
bounded I/O and timeouts. No project source is copied; external artifact transfer
is currently disabled. Checksums are verified on every call. **Adapters are trusted
code, not an OS sandbox.** Doctor reports this boundary. Nothing is automatically
downloaded or installed.

`MCP_DEVOPS_DISCOVERY_SOURCES` optionally lists official HTTPS JSON manifest
catalogs. They are fetched only with `allowNetwork:true`, without source, credentials
or project metadata. Discovered providers remain advisory.

## Approval, recovery and budgets

Every cloud mutation and local environment write requires a human approval form.
There is no auto-approve flag or environment variable. Source uploads are bounded,
honor ignores and exclude credential files, environment files and symlinks. Local
project builds never execute.

State defaults to `~/.local/state/mcp-devops-agent`; override with
`MCP_DEVOPS_STATE_DIR` outside deployable projects. Directories use 0700; journals and
secret vaults use 0600. Ownership, symlinks, hardlinks and permissions are validated.
V1 journals are retained and atomically wrapped in recoverable v2 plan entries.

Network calls and approval run outside state transactions. Claims and revisions
prevent stale approval and duplicate execution. Running is persisted before any
mutation. Ambiguous outcomes require reconciliation; reads remain available.

Budgets aggregate approved estimates per canonical local project, deduplicating
subscription keys. They are not account-wide billing caps. Pricing review expires
after thirty days; stale paid execution is blocked. The bundled baseline catalog
was reviewed 2026-10-10. Usage, taxes, add-ons and unrelated spend can exceed estimates.

Teardown is separately planned and approved per step, with reverse dependencies.
Unsupported removal stays blocked; uncertain resources require reconciliation.
Domain deletion and cancellation are never automated.

## Development

- `npm run typecheck`: strict TypeScript.
- `npm test`: synthetic, network-free provider/adapter/MCP regression tests.
- `npm run test:package`: real clean tarball install; may access npm, never clouds.
- `npm run doctor` / `doctor --json`: offline paths/credential presence, no state
  contents, live authentication or file writes.
- `npm start` / `npm run dev`: stdio / watch. Stdout is reserved for JSON-RPC.
- `--help`, `--version`: run before dotenv/config loading.

Live canaries require isolated accounts and real approvals. CI never buys domains.
