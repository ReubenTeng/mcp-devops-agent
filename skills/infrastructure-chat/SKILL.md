---
name: infrastructure-chat
description: Plan, provision, resume and verify application infrastructure through the mcp-devops-agent v2 MCP tools when a user asks to deploy or manage an app through chat.
---

Use the connected infrastructure MCP tools for provider operations. The server
records plans and approvals; do not replace them with direct cloud commands.

Start with the user's project path and requested outcome. Analyze the project and
list provider capabilities. Check saved plans for that project before creating
replacement resources. Resume an existing environment when that matches the request.

Recommend architectures by workload fit, reliability, operational simplicity and
cost. Preserve explicit provider/region/compliance preferences. A missing API key
means setup is required, not that the provider is unsuitable. Distinguish executable,
catalog and advisory providers. Live discovery requires the user's opt-in; it must
not send source, environment values or credentials.

Get a monthly and upfront budget before preparing paid work. Present the proposed
architecture, estimate assumptions, missing account settings and any unresolved
requirements in plain language. Never treat an estimate as a billing cap. Unknown
or stale pricing cannot be repaired by inventing a price.

Prepare the plan, execute one ready step through its real approval form, refresh
pending work, then prepare the newly ready dependency steps. Keep going through
the authorized graph. Approval for one step does not approve another step. A chat
acknowledgment is not a substitute for the server's human form approval.

Ask for setting names and account identifiers, never API-key values in chat. Direct
the user to their client's private environment configuration for provider keys.
Use generated database credential transfer steps when available. Public framework
variables may contain public Supabase URL/publishable settings, never database
passwords, service-role credentials or other privileged values.

On pending, unknown or interrupted work, read and reconcile the existing step.
Never create a replacement operation merely because the response was lost. A
provider rejection or ambiguity may leave earlier resources running and billed.

Domain search and quoting are read-only. Purchase needs an exact registrar/domain,
term, live price, renewal disclosure, privacy/auto-renew terms and separate approval.
Use provider profile IDs for contacts; do not put personal registration data in
arguments or plan notes. Teardown requires its own plan and approvals, and never
includes domain deletion or cancellation.

After provisioning, verify the plan and report the deployed URL and actual checks.
Distinguish completed provider operations from verified application health,
database access, secret delivery and domain/TLS readiness. If a required check is
unverified, name that gap instead of describing the application as fully working.

For reconnects, return the saved plan and environment. For unsupported provider
operations, identify the needed executable adapter or unimplemented capability;
do not imply that supplying credentials enables missing code.
