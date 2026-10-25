# Infrastructure planner v2 implementation status

This checkpoint is work in progress. Provider credentials alone do not complete
the requested v2 system.

The existing Vercel, Supabase and Cloudflare operations have synthetic coverage.
The public server exposes the v2 tools. Workload analysis, bounded capability
ranking, persistent plans, dependency steps, approval-bound adapter execution,
budget reservations, cancellation, recovery migration, registrar quote aggregation,
Cloudflare purchase/DNS orchestration and separate teardown proposals are implemented.
GitHub Pages supports separately approved source refs, settings, builds, status,
reconciliation and site removal for public repositories with prebuilt static content.
The bundled Render adapter creates a remote MCP service from a public GHCR image
pinned by SHA-256, with one persistent disk and a separately configured HTTP token.
It checks workspace access, binds preparation to the image and private token,
reserves reviewed compute and disk estimates, and recovers lost creation responses
with read-only lookups. Creation includes the initial deployment. Updates, removal,
private registries and rollbacks remain unsupported. Synthetic coverage does not
establish live provider acceptance.
Public HTTPS probes reject private networks and redirects; database/application
semantics still require adapter verification. External adapters remain explicitly
installed and checksum-pinned. The legacy provider implementation remains covered
by its regression harness.

The `serve-http` command supports remote use by one operator. It adds private
bearer authentication, exact host and origin checks, bounded requests and sessions,
idle expiry, a public liveness check and signal shutdown. HTTP tests cover form
approval, interrupted connections and plan recovery after restart. It uses the
installed SDK's session-based Streamable HTTP transport. Tenant isolation, OAuth
discovery and durable event replay are not implemented. Host billing, TLS, disk,
secrets and project source access require separate setup.

Remaining integration includes complete new-provider coverage, reviewed OpenTofu
modules, additional registrar purchases and comprehensive application verification.
GitHub workflow-file editing/commits and general external artifact transfer are
also unfinished. The GitHub Pages adapter currently uses prebuilt committed source.
Catalog entries describe recommendation leads, not tested executable integrations.

Live provider acceptance requires isolated accounts and actual client approvals.
Synthetic tests never purchase domains or provision cloud resources.
