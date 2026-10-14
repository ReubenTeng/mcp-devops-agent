import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { toolResult } from "../errors.js";
import { domainSchema, prepareOperationInput } from "../operations/types.js";
import { OperationService } from "../operations/service.js";
import { projectPathSchema } from "../types/index.js";

const operationIdSchema = z.string().uuid();
const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

export function registerOperationTools(
  server: McpServer,
  config: AppConfig,
  deps: { fetch?: typeof fetch } = {},
): void {
  const service = new OperationService(config, deps);

  server.registerTool(
    "check_provider_connections",
    {
      description: "Reports which provider credentials are configured and verifies read-only connectivity. Never returns secrets.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => toolResult(() => service.checkConnections()),
  );

  server.registerTool(
    "search_domains",
    {
      description: "Searches registrable domain suggestions via Cloudflare Registrar. Read-only; never purchases.",
      inputSchema: { query: z.string().min(1).max(100), limit: z.number().int().min(1).max(20).default(5) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => toolResult(() => service.searchDomains(args.query, args.limit)),
  );

  server.registerTool(
    "check_domain_availability",
    {
      description: "Checks live availability and USD pricing for a domain. A quote is not a reservation or price lock.",
      inputSchema: { domain: domainSchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => toolResult(() => service.checkDomainAvailability(args.domain)),
  );

  server.registerTool(
    "prepare_infrastructure_change",
    {
      description:
        "Validates and prices an infrastructure change, recording a short-lived prepared operation. No remote changes or consent prompt happen at this step.",
      inputSchema: prepareOperationInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => toolResult(() => service.prepare(args)),
  );

  server.registerTool(
    "execute_infrastructure_change",
    {
      description:
        "Executes a previously prepared operation after explicit human approval of the exact change and cost estimate.",
      inputSchema: { operationId: operationIdSchema },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (args, extra) => toolResult(() => service.execute(args.operationId, server, extra.signal)),
  );

  server.registerTool(
    "get_operation",
    {
      description: "Returns the locally recorded status of an operation; optional refresh uses read-only remote checks only.",
      inputSchema: { operationId: operationIdSchema, refresh: z.boolean().default(false) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => toolResult(() => service.getOperation(args.operationId, args.refresh)),
  );

  server.registerTool(
    "list_operations",
    {
      description: "Lists recorded operations (baseline reservations, not a billing meter), newest first.",
      inputSchema: { projectPath: projectPathSchema.optional(), limit: z.number().int().min(1).max(100).default(20) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => toolResult(() => service.listOperations(args.projectPath, args.limit)),
  );

  server.registerTool(
    "cancel_operation",
    {
      description: "Cancels a prepared operation before execution. Applied or pending remote changes are not reverted.",
      inputSchema: { operationId: operationIdSchema },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => toolResult(() => service.cancel(args.operationId)),
  );

  server.registerTool(
    "reconcile_operation",
    {
      description:
        "Reconciles an operation in running/unknown state using read-only remote lookups with deterministic identity matching.",
      inputSchema: { operationId: operationIdSchema, resourceId: idSchema.optional() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args, extra) => toolResult(() => service.reconcile(args.operationId, args.resourceId, server)),
  );

  server.registerTool(
    "get_resource_status",
    {
      description: "Read-only status lookup for a known provider resource.",
      inputSchema: {
        provider: z.enum(["vercel", "supabase", "cloudflare"]),
        resourceId: idSchema,
        kind: z.enum(["project", "deployment", "zone", "domain"]),
        domain: domainSchema.optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => toolResult(() => service.getResourceStatus(args)),
  );

  server.registerTool(
    "inspect_vercel_domain",
    {
      description: "Read-only inspection of a Vercel project domain's verification state and recommended DNS records.",
      inputSchema: { projectId: idSchema, domain: domainSchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => toolResult(() => service.inspectVercelDomain(args.projectId, args.domain)),
  );
}
