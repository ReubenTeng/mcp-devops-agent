import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AppError } from "../errors.js";
import { OperationService } from "../operations/service.js";
import { OperationStore } from "../operations/store.js";
import { actionSchema, type Operation } from "../operations/types.js";
import type { AppConfig } from "../config.js";
import { PRICING_REVIEWED_AT } from "../planning.js";
import type { Prepared, Plan, Step, Resource } from "./schema.js";

export class NativeBridge {
  readonly service: OperationService;
  readonly store: OperationStore;
  constructor(config: AppConfig, deps: { fetch?: typeof fetch }) { this.service = new OperationService(config, deps); this.store = new OperationStore(config.stateDir); }
  async action(step: Step, parameters: Record<string, unknown>): Promise<unknown> {
    if (step.operation !== "configure_vercel_dns") return { ...parameters, kind: step.operation };
    if (typeof parameters.projectId !== "string" || typeof parameters.zoneId !== "string" || typeof parameters.domain !== "string") throw new AppError("SETUP_REQUIRED", "Complete the hosting project, domain connection and DNS zone first.");
    const recommendations = await this.service.inspectVercelDomain(parameters.projectId, parameters.domain) as { recommendedCNAME: string[]; recommendedIPv4: string[] };
    const content = recommendations.recommendedCNAME[0] ?? recommendations.recommendedIPv4[0];
    if (!content) throw new AppError("DNS_GUIDANCE_REQUIRED", "Vercel has not returned a supported DNS recommendation yet.");
    return { kind: "upsert_dns_record", zoneId: parameters.zoneId, type: recommendations.recommendedCNAME.length ? "CNAME" : "A", name: parameters.domain, content, ttl: 1, proxied: false, vercelSource: { projectId: parameters.projectId, domain: parameters.domain } };
  }
  async prepare(plan: Plan, step: Step, parameters: Record<string, unknown>): Promise<Operation> {
    const action = actionSchema.safeParse(await this.action(step, parameters));
    if (!action.success) throw new AppError("SETUP_REQUIRED", `Supply valid provider parameters for: ${[...new Set(action.error.issues.map((issue) => issue.path.join(".")))].join(", ")}. Propose a new plan with those settings.`);
    const result = await this.service.prepare({ projectPath: plan.projectPath, action: action.data, maxMonthlyBudgetUsd: plan.constraints.maxMonthlyBudgetUsd, maxUpfrontBudgetUsd: plan.constraints.maxUpfrontBudgetUsd, estimatedMonthlyUsageUsd: 0, commercialUse: plan.constraints.commercialUse }) as { operationId: string };
    return this.store.load(result.operationId);
  }
  prepared(op: Operation): Prepared {
    const action = op.action;
    const mutatesLocal = action.kind === "sync_supabase_env";
    return { account: op.account.id, region: "region" in action ? action.region : undefined,
      mutations: [{ action: action.kind === "register_domain" ? "purchase" : action.kind === "deploy_vercel" ? "deploy" : mutatesLocal ? "write" : action.kind.startsWith("create_") ? "create" : "update", target: action.kind, details: JSON.stringify(action) }],
      estimate: { recurring: op.estimate.recurringItems, upfrontCents: op.estimate.upfrontCents, reviewedAt: PRICING_REVIEWED_AT, source: op.account.provider === "vercel" ? "https://vercel.com/pricing" : op.account.provider === "supabase" ? "https://supabase.com/pricing" : "https://developers.cloudflare.com/registrar/", assumptions: op.estimate.warnings },
      preconditions: op.preconditions, expiresAt: op.expiresAt };
  }
  resources(op: Operation): Resource[] {
    const r = op.result ?? {}; const resources: Resource[] = [];
    const add = (id: unknown, kind: string, url?: unknown) => {
      if (typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(id)) return;
      let safeUrl: string | undefined;
      if (typeof url === "string") { try { const u = new URL(url.startsWith("https://") ? url : `https://${url}`); if (u.protocol === "https:" && !u.username && !u.password) safeUrl = u.toString(); } catch {} }
      resources.push({ id, provider: op.account.provider, kind, account: op.account.id, ...(safeUrl ? { url: safeUrl } : {}) });
    };
    if (op.action.kind === "create_vercel_project") add(r.projectId, "project");
    if (op.action.kind === "create_supabase_project") add(r.ref, "project");
    if (op.action.kind === "deploy_vercel") add(r.deploymentId, "deployment", r.url);
    if (op.action.kind === "create_cloudflare_zone") add(r.zoneId, "zone");
    if (op.action.kind === "register_domain") add(op.action.domain, "domain");
    if (op.action.kind === "upsert_dns_record") add(r.recordId, "dns-record");
    return resources;
  }
  async execute(step: Step, server: McpServer, signal?: AbortSignal): Promise<Operation> {
    await this.service.execute(step.legacyOperationId!, server, signal);
    return this.store.load(step.legacyOperationId!);
  }
}
