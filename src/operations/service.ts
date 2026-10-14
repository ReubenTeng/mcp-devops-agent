import { createHash, randomBytes } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../config.js";
import { requireApproval } from "../approval.js";
import { AppError } from "../errors.js";
import { PRICING_REVIEWED_AT } from "../planning.js";
import { CloudflareProvider } from "../providers/cloudflare.js";
import { ProviderError } from "../providers/http.js";
import { SupabaseProvider } from "../providers/supabase.js";
import { VercelProvider } from "../providers/vercel.js";
import { usdToCents, decimalUsdToCents } from "../utils/budget.js";
import { collectDeploymentManifest } from "../utils/deployment.js";
import { readProjectBytes, resolveProjectPath } from "../utils/files.js";
import { readSelectedEnv, updateEnvSecrets } from "../utils/env.js";
import { aggregateCosts, OperationStore } from "./store.js";
import type { Action, Operation, RecurringItem } from "./types.js";

const PREPARED_TTL_MS = 10 * 60 * 1000;
const PRICING_STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const ESTIMATE_WARNING =
  "Excludes usage overages, taxes, add-ons and existing unrelated account spend. This is not a billing cap.";
const DOMAIN_PURCHASE_WARNING =
  "Domain purchases are non-refundable; the quoted price is pre-tax and may change before checkout. The Cloudflare API has no atomic maximum-price parameter, so the latest check is not a price guarantee.";

export interface PrepareInput {
  projectPath: string;
  action: Action;
  maxMonthlyBudgetUsd: number;
  maxUpfrontBudgetUsd: number;
  estimatedMonthlyUsageUsd: number;
  commercialUse: boolean;
}

interface Preflight {
  account: Operation["account"];
  recurringItems: RecurringItem[];
  upfrontCents: number;
  warnings: string[];
  preconditions: Record<string, unknown>;
  summary: string;
}

interface EffectContext {
  mutationStarted: boolean;
  mutationCompleted: boolean;
}

interface ManifestPrecondition {
  digest: string;
  files: { file: string; sha: string; size: number }[];
}

export class OperationService {
  private readonly store: OperationStore;
  private readonly fetchImpl: typeof fetch | undefined;

  constructor(
    private readonly config: AppConfig,
    deps: { fetch?: typeof fetch } = {},
  ) {
    this.store = new OperationStore(config.stateDir);
    this.fetchImpl = deps.fetch;
  }

  private vercel(signal?: AbortSignal): VercelProvider {
    return new VercelProvider(this.config.credentials, this.fetchImpl ?? fetch, signal);
  }

  private supabase(signal?: AbortSignal): SupabaseProvider {
    return new SupabaseProvider(this.config.credentials, this.fetchImpl ?? fetch, signal);
  }

  private cloudflare(signal?: AbortSignal): CloudflareProvider {
    return new CloudflareProvider(this.config.credentials, this.fetchImpl ?? fetch, signal);
  }

  private pricingStale(now = new Date()): boolean {
    return now.getTime() - Date.parse(`${PRICING_REVIEWED_AT}T00:00:00Z`) > PRICING_STALE_AFTER_MS;
  }

  private async assertStateOutsideProject(root: string): Promise<void> {
    let resolvedState = path.resolve(this.config.stateDir);
    try {
      resolvedState = await realpath(this.config.stateDir);
    } catch {}
    const rel = path.relative(root, resolvedState);
    if (rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel))) {
      throw new AppError(
        "STATE_INSIDE_PROJECT",
        "The state directory must not be inside the project directory; choose another MCP_DEVOPS_STATE_DIR.",
      );
    }
  }

  private async assertOperationRoot(op: Operation): Promise<string> {
    let resolved: string;
    try {
      resolved = await resolveProjectPath(op.projectPath, this.config.projectRoots);
    } catch {
      throw new AppError(
        "PATH_NOT_ALLOWED",
        "The operation's project path is no longer inside the configured project roots. Review it manually.",
      );
    }
    if (resolved !== op.projectPath) {
      throw new AppError(
        "PATH_NOT_ALLOWED",
        "The operation's project path no longer resolves to the approved location. Review it manually.",
      );
    }
    return resolved;
  }

  private vercelPlanCheck(plan: string, commercialUse: boolean): void {
    if (plan !== "hobby" && plan !== "pro") {
      throw new AppError("UNPRICED_PLAN", "The Vercel account uses a plan that this tool cannot price.");
    }
    if (plan === "hobby" && commercialUse) {
      throw new AppError("COMMERCIAL_USE_RESTRICTED", "The Vercel Hobby plan does not allow commercial use.");
    }
  }

  private vercelItems(
    plan: string,
    teamId: string,
    usageKey: string,
    estimatedMonthlyUsageUsd: number,
    commercialUse: boolean,
  ): RecurringItem[] {
    this.vercelPlanCheck(plan, commercialUse);
    const items: RecurringItem[] = [];
    if (plan === "pro") {
      items.push({ key: `vercel:${teamId}:subscription`, cents: 2000 });
    }
    const usageCents = usdToCents(estimatedMonthlyUsageUsd);
    if (usageCents > 0) {
      items.push({ key: `vercel:${teamId}:usage:${usageKey}`, cents: usageCents });
    }
    return items;
  }

  private supabaseItems(plan: string, orgSlug: string, opId: string | undefined, estimatedMonthlyUsageUsd: number): RecurringItem[] {
    const items: RecurringItem[] = [];
    if (plan === "pro") {
      items.push({ key: `supabase:${orgSlug}:subscription`, cents: 2500 });
      if (opId !== undefined) {
        items.push({ key: `supabase:${orgSlug}:compute:${opId}`, cents: 1000 });
      }
    }
    const usageCents = usdToCents(estimatedMonthlyUsageUsd);
    if (usageCents > 0) {
      items.push({ key: `supabase:${orgSlug}:usage`, cents: usageCents });
    }
    return items;
  }

  private async preflight(
    action: Action,
    input: { estimatedMonthlyUsageUsd: number; commercialUse: boolean },
    root: string,
    opId: string | undefined,
    signal?: AbortSignal,
  ): Promise<Preflight> {
    const usage = input.estimatedMonthlyUsageUsd;
    switch (action.kind) {
      case "create_vercel_project": {
        const team = await this.vercel(signal).team();
        const items = this.vercelItems(team.plan, team.id, action.name, usage, input.commercialUse);
        const existing = await this.vercel(signal).findProject(action.name);
        if (existing) {
          throw new AppError("RESOURCE_EXISTS", "A Vercel project with this name already exists in the configured team.");
        }
        return {
          account: { provider: "vercel", id: team.id, plan: team.plan },
          recurringItems: items,
          upfrontCents: 0,
          warnings: [],
          preconditions: { name: action.name, framework: action.framework, teamId: team.id, plan: team.plan },
          summary: `Create Vercel project "${action.name}".`,
        };
      }
      case "deploy_vercel":
      case "connect_vercel_domain":
      case "verify_vercel_domain":
      case "sync_env_to_vercel":
      case "rollback_vercel": {
        const team = await this.vercel(signal).team();
        const project = "projectId" in action ? await this.vercel(signal).findProject(action.projectId) : undefined;
        if ("projectId" in action && !project) {
          throw new AppError("NOT_FOUND", "The Vercel project was not found in the configured team.");
        }
        const canonicalProjectId = project?.id ?? ("projectId" in action ? action.projectId : "");
        const items = this.vercelItems(team.plan, team.id, canonicalProjectId, usage, input.commercialUse);
        const preconditions: Record<string, unknown> = { teamId: team.id, plan: team.plan };
        const warnings: string[] = [];
        let summary = "";
        if (action.kind === "deploy_vercel") {
          if (project && action.name !== project.name) {
            throw new AppError(
              "PROJECT_NAME_MISMATCH",
              "The deployment name must equal the Vercel project name; approve only the real project.",
            );
          }
          preconditions.projectId = canonicalProjectId;
          preconditions.target = action.target;
          if (action.source.type === "local") {
            const manifest = await collectDeploymentManifest(root);
            preconditions.source = "local";
            preconditions.manifest = { digest: manifest.digest, files: manifest.files, totalBytes: manifest.totalBytes };
            warnings.push(
              "Local source may contain hardcoded secrets; review files before approving.",
              ...manifest.warnings,
            );
            summary = `Deploy ${manifest.files.length} files (${manifest.totalBytes} bytes) from the local project to Vercel (${action.target}).`;
          } else {
            preconditions.source = { type: "github", org: action.source.org, repo: action.source.repo, sha: action.source.sha };
            summary = `Deploy immutable GitHub commit ${action.source.sha} of ${action.source.org}/${action.source.repo} to Vercel (${action.target}).`;
          }
        } else if (action.kind === "connect_vercel_domain") {
          preconditions.projectId = canonicalProjectId;
          preconditions.domain = action.domain;
          summary = `Connect domain ${action.domain} to Vercel project ${project?.name ?? action.projectId}.`;
        } else if (action.kind === "verify_vercel_domain") {
          preconditions.projectId = canonicalProjectId;
          preconditions.domain = action.domain;
          summary = `Verify domain ${action.domain} for Vercel project ${project?.name ?? action.projectId}.`;
        } else if (action.kind === "sync_env_to_vercel") {
          await readSelectedEnv(root, action.keys);
          preconditions.projectId = canonicalProjectId;
          preconditions.keys = [...action.keys].sort();
          preconditions.targets = [...action.target].sort();
          summary = `Write ${action.keys.length} local .env values to Vercel project ${project?.name ?? action.projectId} for targets ${action.target.join(", ")}.`;
        } else {
          const deployment = await this.vercel(signal).getDeployment(action.deploymentId);
          if (deployment.readyState !== "READY" || deployment.target !== "production" || deployment.projectId !== canonicalProjectId) {
            throw new AppError(
              "PRECONDITION_FAILED",
              "The deployment is not a READY production deployment of this project.",
            );
          }
          preconditions.projectId = canonicalProjectId;
          preconditions.deploymentId = action.deploymentId;
          summary = `Roll back Vercel project ${project?.name ?? action.projectId} to deployment ${action.deploymentId}.`;
        }
        return {
          account: { provider: "vercel", id: team.id, plan: team.plan },
          recurringItems: items,
          upfrontCents: 0,
          warnings,
          preconditions,
          summary,
        };
      }
      case "create_supabase_project": {
        const org = await this.supabase(signal).organization(action.organizationSlug);
        const orgPlan = org.plan ?? "unknown";
        if (orgPlan !== action.plan) {
          throw new AppError(
            "PLAN_MISMATCH",
            "The Supabase organization plan does not match the requested plan; change plans manually.",
          );
        }
        const regions = await this.supabase(signal).regions(action.organizationSlug);
        if (!regions.includes(action.region)) {
          throw new AppError("INVALID_REGION", "The requested Supabase region is not available for this organization.");
        }
        const projects = await this.supabase(signal).listProjects();
        const conflicts = projects.filter(
          (project) =>
            (project.organization_id === org.id || project.organization_slug === action.organizationSlug) &&
            project.name === action.name,
        );
        if (conflicts.length > 0) {
          throw new AppError("RESOURCE_EXISTS", "A Supabase project with this name already exists in the organization.");
        }
        const warnings: string[] = [];
        if (action.plan === "free") {
          const active = projects.filter(
            (project) =>
              (project.organization_id === org.id || project.organization_slug === action.organizationSlug) &&
              ["ACTIVE_HEALTHY", "COMING_UP", "ACTIVE"].includes(project.status ?? ""),
          );
          if (active.length >= 2) {
            warnings.push("The free plan allows two active projects; this organization may already be at its quota including projects this token cannot see.");
          }
        }
        const items = this.supabaseItems(action.plan, action.organizationSlug, opId, usage);
        if (action.plan === "pro") {
          warnings.push("The shared included compute credit is not assumed; existing unmanaged projects and their usage are excluded.");
        }
        return {
          account: { provider: "supabase", id: org.id, plan: orgPlan },
          recurringItems: items,
          upfrontCents: 0,
          warnings,
          preconditions: {
            name: action.name,
            organizationId: org.id,
            organizationSlug: action.organizationSlug,
            region: action.region,
            plan: action.plan,
          },
          summary: `Create Supabase project "${action.name}" (${action.plan}) in ${action.region}.`,
        };
      }
      case "register_domain": {
        const account = await this.cloudflare(signal).account();
        const offer = await this.cloudflare(signal).checkDomain(action.domain);
        if (
          !offer ||
          offer.registrable !== true ||
          offer.tier !== "standard" ||
          !offer.pricing ||
          offer.pricing.currency !== "USD"
        ) {
          throw new AppError("DOMAIN_UNAVAILABLE", "The domain is not registrable at a standard price; no purchase can be prepared.");
        }
        let registrationCents: number;
        let renewalCents: number;
        try {
          registrationCents = decimalUsdToCents(offer.pricing.registration_cost);
          renewalCents = decimalUsdToCents(offer.pricing.renewal_cost);
        } catch {
          throw new AppError("INVALID_PRICE", "The provider returned a price that cannot be validated.");
        }
        const upfrontCents = registrationCents + renewalCents * (action.years - 1);
        return {
          account: { provider: "cloudflare", id: account.id },
          recurringItems: [],
          upfrontCents,
          warnings: [
            DOMAIN_PURCHASE_WARNING,
            "Auto-renew is disabled. Cloudflare dashboard billing and default-registrant prerequisites must already be configured.",
          ],
          preconditions: {
            domain: action.domain,
            years: action.years,
            registrationCost: offer.pricing.registration_cost,
            renewalCost: offer.pricing.renewal_cost,
          },
          summary: `Register domain ${action.domain} for ${action.years} year(s).`,
        };
      }
      case "create_cloudflare_zone": {
        const account = await this.cloudflare(signal).account();
        const zones = await this.cloudflare(signal).listZones(action.domain);
        if (zones.some((zone) => zone.name === action.domain)) {
          throw new AppError("RESOURCE_EXISTS", "A Cloudflare zone for this domain already exists in the account.");
        }
        return {
          account: { provider: "cloudflare", id: account.id },
          recurringItems: [],
          upfrontCents: 0,
          warnings: ["The zone stays pending until its assigned nameservers are set at the registrar."],
          preconditions: { domain: action.domain, accountId: account.id },
          summary: `Create a Cloudflare DNS zone for ${action.domain}.`,
        };
      }
      case "upsert_dns_record": {
        const account = await this.cloudflare(signal).account();
        const zone = await this.cloudflare(signal).getZone(action.zoneId);
        const normalized = normalizeDnsName(action.name, zone.name);
        validateDnsRecord(action.type, normalized, action.content, action.ttl, action.proxied);
        const desired = { type: action.type, name: normalized, content: action.content, ttl: action.ttl, proxied: action.proxied };
        const preconditions: Record<string, unknown> = { zoneId: action.zoneId, zoneName: zone.name, desired };
        const sameName = (await this.cloudflare(signal).listDns(action.zoneId, normalized)).filter(
          (record) => record.name === normalized && record.id !== action.recordId,
        );
        if (action.recordId) {
          const record = await this.cloudflare(signal).getDns(action.zoneId, action.recordId);
          preconditions.original = {
            id: record.id,
            type: record.type,
            name: record.name,
            content: record.content,
            ttl: record.ttl,
            proxied: record.proxied,
          };
        }
        const addressTypes = new Set(["A", "AAAA"]);
        const hasAddress = sameName.some((record) => addressTypes.has(record.type));
        const hasCname = sameName.some((record) => record.type === "CNAME");
        const sameType = sameName.some((record) => record.type === action.type);
        if (!action.recordId && sameType) {
          throw new AppError("DNS_CONFLICT", "A record with this name and type already exists; update it explicitly by record ID.");
        }
        if (action.recordId && sameType) {
          throw new AppError("DNS_CONFLICT", "Another record with this name and type already exists in the zone.");
        }
        if ((action.type === "CNAME" && hasAddress) || (addressTypes.has(action.type) && hasCname)) {
          throw new AppError("DNS_CONFLICT", "This record conflicts with an existing record at the same name.");
        }
        return {
          account: { provider: "cloudflare", id: account.id },
          recurringItems: [],
          upfrontCents: 0,
          warnings: [],
          preconditions,
          summary: action.recordId
            ? `Update DNS ${action.type} record ${action.recordId} in zone ${zone.name} to ${action.content}.`
            : `Create DNS ${action.type} record ${normalized} -> ${action.content} in zone ${zone.name}.`,
        };
      }
      case "sync_supabase_env": {
        const project = await this.supabase(signal).getProject(action.projectRef);
        if (project.status === "REMOVED") {
          throw new AppError("NOT_FOUND", "The Supabase project was not found.");
        }
        const accountId = project.organization_id ?? project.organization_slug;
        if (!accountId) {
          throw new AppError("ACCOUNT_MISMATCH", "The Supabase project's owning organization could not be verified.");
        }
        const preconditions: Record<string, unknown> = {
          projectRef: action.projectRef,
          projectName: project.name,
          includeServiceRole: action.includeServiceRole,
        };
        if (action.sourceOperationId) {
          const source = await this.store.load(action.sourceOperationId);
          if (
            source.action.kind !== "create_supabase_project" ||
            source.projectPath !== root ||
            source.result?.ref !== action.projectRef
          ) {
            throw new AppError(
              "PRECONDITION_FAILED",
              "The source operation does not match this project and Supabase project reference.",
            );
          }
          if (source.result?.generatedPasswordBound !== true) {
            throw new AppError(
              "UNPROVEN_CREDENTIAL",
              "The stored database password cannot be proven to belong to this project. Prepare the sync without sourceOperationId and configure the database password separately.",
            );
          }
          preconditions.sourceOperationId = action.sourceOperationId;
        }
        return {
          account: { provider: "supabase", id: accountId },
          recurringItems: [],
          upfrontCents: 0,
          warnings: action.sourceOperationId
            ? ["A database password and direct connection string will be written to the local .env; the direct endpoint may require IPv6."]
            : [],
          preconditions,
          summary: `Copy Supabase API credentials for project ${project.name} into the local .env file.`,
        };
      }
      default: {
        const exhaustive: never = action;
        throw new AppError("INTERNAL_ERROR", `Unsupported action ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  private async executePreflight(
    op: Operation,
    signal?: AbortSignal,
  ): Promise<Preflight> {
    let preflight: Preflight;
    try {
      preflight = await this.preflight(
        op.action,
        { estimatedMonthlyUsageUsd: op.estimatedMonthlyUsageUsd, commercialUse: op.commercialUse },
        op.projectPath,
        op.id,
        signal,
      );
    } catch (err) {
      if (err instanceof AppError && err.code === "DOMAIN_UNAVAILABLE" && op.action.kind === "register_domain") {
        throw new AppError(
          "QUOTE_CHANGED",
          "The domain quote or availability changed since approval. Cancel this operation and prepare again.",
        );
      }
      throw err;
    }
    const unchanged =
      JSON.stringify(preflight.account) === JSON.stringify(op.account) &&
      JSON.stringify(preflight.preconditions) === JSON.stringify(op.preconditions) &&
      JSON.stringify(preflight.recurringItems) === JSON.stringify(op.estimate.recurringItems) &&
      preflight.upfrontCents === op.estimate.upfrontCents;
    if (!unchanged) {
      if (op.action.kind === "register_domain") {
        throw new AppError(
          "QUOTE_CHANGED",
          "The domain quote or availability changed since approval. Cancel this operation and prepare again.",
        );
      }
      throw new AppError(
        "PRECONDITION_CHANGED",
        "Remote state changed since this operation was prepared. Cancel it and prepare again.",
      );
    }
    return preflight;
  }

  private operationPreview(op: Operation): Record<string, unknown> | undefined {
    const action = op.action;
    if (action.kind === "deploy_vercel" && action.source.type === "local") {
      const manifest = op.preconditions.manifest as ManifestPrecondition;
      return {
        sourceFiles: manifest.files.map((entry) => entry.file),
        fileCount: manifest.files.length,
        digest: manifest.digest,
      };
    }
    if (action.kind === "upsert_dns_record") {
      return { from: op.preconditions.original ?? null, to: op.preconditions.desired };
    }
    if (action.kind === "register_domain") {
      return { quote: op.preconditions };
    }
    return undefined;
  }

  private approvalMessage(op: Operation, preflight: Preflight, projected: { monthlyCents: number; upfrontCents: number }): string {
    const parts = [
      `Approve this exact infrastructure change: ${preflight.summary}`,
      `Action: ${JSON.stringify(op.action)}.`,
      `Provider account: ${op.account.provider} ${op.account.id}${op.account.plan ? ` (${op.account.plan})` : ""}.`,
      `Project: ${op.projectPath}.`,
      `Operation id: ${op.id}.`,
      `Estimated cost: $${(op.estimate.recurringItems.reduce((sum, item) => sum + item.cents, 0) / 100).toFixed(2)}/month recurring plus $${(op.estimate.upfrontCents / 100).toFixed(2)} upfront.`,
      `Projected totals including other active operations: $${(projected.monthlyCents / 100).toFixed(2)}/month, $${(projected.upfrontCents / 100).toFixed(2)} upfront.`,
      `Approved budget limits: $${op.maxMonthlyBudgetUsd.toFixed(2)}/month, $${op.maxUpfrontBudgetUsd.toFixed(2)} upfront.`,
    ];
    for (const warning of op.estimate.warnings) {
      parts.push(`Warning: ${warning}`);
    }
    const preview = this.operationPreview(op);
    if (op.action.kind === "deploy_vercel" && preview) {
      const names = preview.sourceFiles as string[];
      const shown = names.slice(0, 100).join(", ");
      parts.push(
        `Local source files (${names.length}, digest ${preview.digest}): ${shown}${names.length > 100 ? ` and ${names.length - 100} more` : ""}.`,
        "Local source may contain hardcoded secrets; review files before approving.",
      );
    }
    if (op.action.kind === "upsert_dns_record" && preview) {
      parts.push(`DNS record change: ${JSON.stringify(preview)}.`);
    }
    if (op.action.kind === "sync_supabase_env" && op.action.includeServiceRole) {
      parts.push("Privileged service-role credentials will be written to the local .env file; they grant full database access.");
    }
    if (op.action.kind === "sync_env_to_vercel") {
      parts.push(`Environment variables written by name only: ${(op.action.keys as string[]).join(", ")}.`);
    }
    return parts.join("\n");
  }

  async prepare(input: PrepareInput): Promise<object> {
    const root = await resolveProjectPath(input.projectPath, this.config.projectRoots);
    await this.store.init();
    await this.assertStateOutsideProject(root);
    return this.store.withLock(async () => {
      const now = new Date();
      const opId = crypto.randomUUID();
      const preflight = await this.preflight(input.action, input, root, opId);
      const paid = preflight.recurringItems.length > 0 || preflight.upfrontCents > 0;
      if (paid && this.pricingStale(now)) {
        throw new AppError("PRICING_STALE", "Pricing data is stale and must be reviewed before preparing a paid change.");
      }
      const monthlyCents = preflight.recurringItems.reduce((sum, item) => sum + item.cents, 0);
      const op: Operation = {
        version: 1,
        id: opId,
        projectPath: root,
        action: input.action,
        account: preflight.account,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + PREPARED_TTL_MS).toISOString(),
        status: "prepared",
        costCommitted: false,
        maxMonthlyBudgetUsd: input.maxMonthlyBudgetUsd,
        maxUpfrontBudgetUsd: input.maxUpfrontBudgetUsd,
        estimatedMonthlyUsageUsd: input.estimatedMonthlyUsageUsd,
        commercialUse: input.commercialUse,
        estimate: {
          currency: "USD",
          recurringItems: preflight.recurringItems,
          upfrontCents: preflight.upfrontCents,
          estimatedMonthlyCostUsd: monthlyCents / 100,
          estimatedUpfrontCostUsd: preflight.upfrontCents / 100,
          scope: "managed_project_baseline",
          hardCap: false,
          warnings: [ESTIMATE_WARNING, ...preflight.warnings],
        },
        preconditions: preflight.preconditions,
        events: [{ at: now.toISOString(), event: "prepared" }],
      };
      if ("projectId" in op.action && typeof op.preconditions.projectId === "string") {
        op.action = { ...op.action, projectId: op.preconditions.projectId };
      }
      const existing = await this.store.listForProject(root);
      const projected = aggregateCosts(
        [...existing.filter((other) => other.id !== op.id), op],
        now,
      );
      if (
        projected.monthlyCents > usdToCents(input.maxMonthlyBudgetUsd) ||
        projected.upfrontCents > usdToCents(input.maxUpfrontBudgetUsd)
      ) {
        throw new AppError(
          "BUDGET_EXCEEDED",
          "The proposed change exceeds the approved budget together with other active operations. Nothing was reserved.",
        );
      }
      await this.store.save(op);
      return {
        operationId: op.id,
        status: op.status,
        expiresAt: op.expiresAt,
        action: op.action,
        account: op.account,
        estimate: op.estimate,
        projectedCosts: {
          monthlyUsd: projected.monthlyCents / 100,
          upfrontUsd: projected.upfrontCents / 100,
          scope: "baseline plus other active operations for this project",
        },
        summary: preflight.summary,
        warnings: op.estimate.warnings,
        preview: this.operationPreview(op),
      };
    });
  }

  async execute(operationId: string, server: McpServer, signal?: AbortSignal): Promise<object> {
    await this.store.init();
    return this.store.withLock(async () => {
      const op = await this.store.load(operationId);
      await this.assertOperationRoot(op);
      if (op.status === "succeeded") {
        return { operationId: op.id, status: op.status, result: op.result };
      }
      if (op.status === "cancelled" || op.status === "failed") {
        throw new AppError("INVALID_STATE", "This operation already reached a final state. Prepare a new operation instead.");
      }
      if (op.status === "running" || op.status === "pending" || op.status === "unknown") {
        throw new AppError(
          "RECONCILIATION_REQUIRED",
          "This operation may already be in progress. Reconcile it before retrying; it will not be submitted twice.",
        );
      }
      if (Date.parse(op.expiresAt) < Date.now()) {
        throw new AppError("OPERATION_EXPIRED", "The prepared operation expired. Cancel it and prepare again.");
      }
      await this.assertStateOutsideProject(op.projectPath);
      const now = new Date();
      const preflight = await this.executePreflight(op, signal);
      const paid = op.estimate.recurringItems.length > 0 || op.estimate.upfrontCents > 0;
      if (paid && this.pricingStale(now)) {
        throw new AppError("PRICING_STALE", "Pricing data is stale and must be reviewed before executing a paid change.");
      }
      const others = (await this.store.listForProject(op.projectPath)).filter((other) => other.id !== op.id);
      const projected = aggregateCosts([...others, op], now);
      if (
        projected.monthlyCents > usdToCents(op.maxMonthlyBudgetUsd) ||
        projected.upfrontCents > usdToCents(op.maxUpfrontBudgetUsd)
      ) {
        throw new AppError("BUDGET_EXCEEDED", "The operation no longer fits the approved budget together with other operations.");
      }

      let capturedEnv: Record<string, string> | undefined;
      if (op.action.kind === "sync_env_to_vercel") {
        capturedEnv = await readSelectedEnv(op.projectPath, op.action.keys);
      }

      try {
        await requireApproval(server, this.approvalMessage(op, preflight, projected), signal);
      } catch (err) {
        if (err instanceof AppError && err.code === "APPROVAL_DECLINED") {
          op.status = "cancelled";
          op.events.push({ at: new Date().toISOString(), event: "approval_declined" });
          await this.store.save(op);
          throw new AppError("APPROVAL_DECLINED", "The operation was not approved. No changes were made.");
        }
        throw err;
      }

      if (Date.parse(op.expiresAt) < Date.now()) {
        throw new AppError("OPERATION_EXPIRED", "The prepared operation expired before approval finished. Prepare again.");
      }
      if (signal?.aborted) {
        throw new AppError("CANCELLED", "The request was cancelled before the change started. No changes were made.");
      }
      await this.executePreflight(op, signal);
      const fresh = await this.store.load(op.id);
      if (fresh.status !== "prepared") {
        throw new AppError(
          "INVALID_STATE",
          "This operation changed state while approval was pending. Review it before retrying.",
        );
      }

      if (op.action.kind === "create_supabase_project") {
        const password = randomBytes(32).toString("base64url");
        await this.store.writeVault(op.id, { password });
      }

      op.status = "running";
      op.events.push({ at: new Date().toISOString(), event: "approved_and_started" });
      await this.store.save(op);

      const ctx: EffectContext = { mutationStarted: false, mutationCompleted: false };
      try {
        const outcome = await this.perform(op, capturedEnv, ctx, signal);
        op.status = outcome.status;
        if (outcome.status === "succeeded") {
          op.error = undefined;
        }
        op.result = { ...(op.result ?? {}), ...outcome.result };
        op.costCommitted = op.costCommitted || outcome.costCommitted;
        op.events.push({ at: new Date().toISOString(), event: `status_${outcome.status}` });
        await this.store.save(op);
        return { operationId: op.id, status: op.status, result: op.result };
      } catch (err) {
        if (err instanceof AppError && err.code === "CANCELLED" && !ctx.mutationStarted) {
          op.status = "cancelled";
          op.error = { code: "CANCELLED", message: "The request was cancelled before any change was made." };
          op.events.push({ at: new Date().toISOString(), event: "cancelled" });
          await this.store.save(op);
          throw err;
        }
        const definitive =
          !ctx.mutationStarted ||
          (err instanceof ProviderError && !err.ambiguous && !ctx.mutationCompleted);
        if (definitive) {
          op.status = "failed";
          op.error =
            err instanceof AppError
              ? { code: err.code, message: err.message }
              : { code: "INTERNAL_ERROR", message: "An internal error occurred. No details are exposed." };
          op.events.push({ at: new Date().toISOString(), event: "status_failed" });
          await this.store.save(op);
          throw err;
        }
        op.status = "unknown";
        op.costCommitted = true;
        op.error =
          err instanceof AppError
            ? { code: err.code, message: err.message }
            : { code: "INTERNAL_ERROR", message: "An internal error occurred. No details are exposed." };
        op.events.push({ at: new Date().toISOString(), event: "status_unknown" });
        await this.store.save(op);
        throw err;
      }
    });
  }

  private async perform(
    op: Operation,
    capturedEnv: Record<string, string> | undefined,
    ctx: EffectContext,
    signal?: AbortSignal,
  ): Promise<{ status: "pending" | "succeeded" | "failed"; result: Record<string, unknown>; costCommitted: boolean }> {
    const action = op.action;
    const change = async <T>(run: () => Promise<T>): Promise<T> => {
      if (signal?.aborted) {
        throw new AppError("CANCELLED", "The request was cancelled before the next change started.");
      }
      ctx.mutationStarted = true;
      const result = await run();
      ctx.mutationCompleted = true;
      op.costCommitted = true;
      return result;
    };
    switch (action.kind) {
      case "create_vercel_project": {
        const project = await change(() =>
          this.vercel(signal).createProject({ name: action.name, framework: action.framework }),
        );
        op.result = { projectId: project.id, name: project.name };
        return { status: "succeeded", result: { projectId: project.id, name: project.name }, costCommitted: true };
      }
      case "deploy_vercel": {
        let files: { file: string; sha: string; size: number }[] | undefined;
        if (action.source.type === "local") {
          const manifest = op.preconditions.manifest as ManifestPrecondition;
          const payloads: { entry: { file: string; sha: string; size: number }; bytes: Buffer }[] = [];
          for (const entry of manifest.files) {
            const bytes = await readProjectBytes(op.projectPath, entry.file, entry.size);
            if (bytes === undefined || bytes.byteLength !== entry.size || createHash("sha1").update(bytes).digest("hex") !== entry.sha) {
              throw new AppError("SOURCE_CHANGED", "Local source files changed since this operation was prepared. Prepare again.");
            }
            payloads.push({ entry, bytes });
          }
          for (const payload of payloads) {
            await change(() => this.vercel(signal).uploadFile(payload.bytes, payload.entry.sha));
          }
          files = manifest.files;
        }
        const deployment = await change(() =>
          this.vercel(signal).deploy({
            project: action.projectId,
            name: action.name,
            target: action.target,
            files,
            gitSource: action.source.type === "github" ? action.source : undefined,
            operationId: op.id,
          }),
        );
        op.result = {
          deploymentId: deployment.id,
          url: deployment.url,
          readyState: deployment.readyState,
          projectId: deployment.projectId ?? action.projectId,
        };
        const readyState = deployment.readyState ?? "";
        return {
          status:
            readyState === "READY"
              ? "succeeded"
              : readyState === "ERROR" || readyState === "CANCELED" || readyState === "BLOCKED"
                ? "failed"
                : "pending",
          result: op.result,
          costCommitted: true,
        };
      }
      case "create_supabase_project": {
        const vault = await this.store.readVault(op.id);
        if (!vault) {
          throw new AppError("INTERNAL_ERROR", "The operation credential vault is unavailable.");
        }
        const project = await change(() =>
          this.supabase(signal).createProject({
            name: action.name,
            organizationSlug: action.organizationSlug,
            region: action.region,
            plan: action.plan,
            password: vault.password,
          }),
        );
        if (project.status === "REMOVED") {
          throw new AppError("PROVIDER_REQUEST_FAILED", "The Supabase project was removed during creation.");
        }
        if (project.organization_id !== undefined && project.organization_id !== op.account.id) {
          throw new ProviderError(
            "ACCOUNT_MISMATCH",
            "The Supabase project belongs to a different organization.",
            undefined,
            true,
          );
        }
        op.result = {
          ref: project.ref,
          name: project.name,
          remoteStatus: project.status,
          generatedPasswordBound: true,
        };
        return {
          status: project.status === "ACTIVE_HEALTHY" ? "succeeded" : "pending",
          result: op.result,
          costCommitted: true,
        };
      }
      case "register_domain": {
        const offer = await this.cloudflare(signal).checkDomain(action.domain);
        const expected = op.preconditions as { registrationCost: string; renewalCost: string };
        if (
          !offer ||
          offer.registrable !== true ||
          offer.tier !== "standard" ||
          offer.pricing?.currency !== "USD" ||
          offer.pricing.registration_cost !== expected.registrationCost ||
          offer.pricing.renewal_cost !== expected.renewalCost
        ) {
          throw new AppError("QUOTE_CHANGED", "The domain price or availability changed since approval. No purchase was made.");
        }
        const registration = await change(() => this.cloudflare(signal).registerDomain(action.domain, action.years));
        op.result = { domain: action.domain, registrationStatus: registration.state };
        return {
          status:
            registration.state === "succeeded"
              ? "succeeded"
              : registration.state === "failed" || registration.state === "cancelled"
                ? "failed"
                : "pending",
          result: op.result,
          costCommitted: true,
        };
      }
      case "create_cloudflare_zone": {
        const zone = await change(() => this.cloudflare(signal).createZone(action.domain));
        op.result = { zoneId: zone.id, name: zone.name, zoneStatus: zone.status, nameServers: zone.name_servers ?? [] };
        return {
          status: zone.status === "active" ? "succeeded" : "pending",
          result: op.result,
          costCommitted: true,
        };
      }
      case "upsert_dns_record": {
        const desired = op.preconditions.desired as { type: string; name: string; content: string; ttl: number; proxied: boolean };
        const existing = await this.cloudflare(signal).listDns(action.zoneId, desired.name);
        const sameName = existing.filter((record) => record.name === desired.name && record.id !== action.recordId);
        const addressTypes = new Set(["A", "AAAA"]);
        const hasAddress = sameName.some((record) => addressTypes.has(record.type));
        const hasCname = sameName.some((record) => record.type === "CNAME");
        if (
          sameName.some((record) => record.type === desired.type) ||
          (desired.type === "CNAME" && hasAddress) ||
          (addressTypes.has(desired.type) && hasCname)
        ) {
          throw new AppError("RESOURCE_CHANGED", "A conflicting DNS record appeared since this operation was prepared. No change was made.");
        }
        if (action.recordId) {
          const current = await this.cloudflare(signal).getDns(action.zoneId, action.recordId);
          const original = op.preconditions.original as { type: string; name: string; content: string; ttl?: number; proxied?: boolean };
          if (
            current.type !== original.type ||
            current.name !== original.name ||
            current.content !== original.content ||
            current.ttl !== original.ttl ||
            current.proxied !== original.proxied
          ) {
            throw new AppError("RESOURCE_CHANGED", "The DNS record changed since this operation was prepared. No update was made.");
          }
          const recordId = action.recordId;
          const record = await change(() => this.cloudflare(signal).updateDns(action.zoneId, recordId, desired));
          this.assertDnsReply(record, desired);
          op.result = { recordId: record.id, type: record.type, name: record.name };
          return { status: "succeeded", result: op.result, costCommitted: true };
        }
        const record = await change(() => this.cloudflare(signal).createDns(action.zoneId, desired));
        this.assertDnsReply(record, desired);
        op.result = { recordId: record.id, type: record.type, name: record.name };
        return { status: "succeeded", result: op.result, costCommitted: true };
      }
      case "connect_vercel_domain": {
        await change(() => this.vercel(signal).addDomain(action.projectId, action.domain));
        const projectDomain = await this.vercel(signal).getProjectDomain(action.projectId, action.domain);
        const config = await this.vercel(signal).domainConfig(action.projectId, action.domain);
        const ready = projectDomain.verified === true && config.misconfigured === false;
        op.result = {
          domain: action.domain,
          verified: projectDomain.verified === true,
          misconfigured: config.misconfigured,
          verification: (projectDomain.verification ?? []).map((entry) => ({
            type: entry.type,
            domain: entry.domain,
            value: entry.value,
          })),
          recommendedCNAME: (config.recommendedCNAME ?? []).map((entry) => entry.value),
          recommendedIPv4: (config.recommendedIPv4 ?? []).flatMap((entry) => entry.value),
          nextSteps: ready
            ? "Domain is connected and verified."
            : "Create the recommended DNS records shown, then run verify_vercel_domain. DNS is not changed automatically.",
        };
        return { status: ready ? "succeeded" : "pending", result: op.result, costCommitted: true };
      }
      case "verify_vercel_domain": {
        const result = await change(() => this.vercel(signal).verifyDomain(action.projectId, action.domain));
        const config = await this.vercel(signal).domainConfig(action.projectId, action.domain);
        const ready = result.verified && config.misconfigured === false;
        op.result = { domain: action.domain, verified: result.verified, misconfigured: config.misconfigured };
        return { status: ready ? "succeeded" : "pending", result: op.result, costCommitted: true };
      }
      case "sync_env_to_vercel": {
        if (!capturedEnv) {
          throw new AppError("INTERNAL_ERROR", "Environment values were not captured before approval.");
        }
        const updatedKeys = await change(() => this.vercel(signal).upsertEnv(action.projectId, capturedEnv, action.target));
        op.result = { projectId: action.projectId, updatedKeys };
        return { status: "succeeded", result: op.result, costCommitted: true };
      }
      case "sync_supabase_env": {
        const keys = await this.supabase(signal).getApiKeys(action.projectRef);
        const publishable = keys.find((key) => key.type === "publishable");
        const anon = keys.find((key) => key.name === "anon");
        const secrets: Record<string, string> = { SUPABASE_URL: `https://${action.projectRef}.supabase.co` };
        if (publishable) {
          secrets.SUPABASE_PUBLISHABLE_KEY = publishable.apiKey;
        } else if (anon) {
          secrets.SUPABASE_ANON_KEY = anon.apiKey;
        } else {
          throw new AppError("MISSING_PROVIDER_KEY", "The Supabase publishable API key is not available for this project.");
        }
        if (action.includeServiceRole) {
          const secret = keys.find((key) => key.type === "secret");
          const serviceRole = keys.find((key) => key.name === "service_role");
          if (secret) {
            secrets.SUPABASE_SECRET_KEY = secret.apiKey;
          } else if (serviceRole) {
            secrets.SUPABASE_SERVICE_ROLE_KEY = serviceRole.apiKey;
          } else {
            throw new AppError("MISSING_PROVIDER_KEY", "The Supabase service-role API key is not available for this project.");
          }
        }
        if (action.sourceOperationId) {
          const vault = await this.store.readVault(action.sourceOperationId);
          if (!vault) {
            throw new AppError(
              "MISSING_OPERATION_SECRET",
              "The stored database password for the source operation is unavailable. Prepare the sync without sourceOperationId and configure the database password separately.",
            );
          }
          secrets.SUPABASE_DB_PASSWORD = vault.password;
          secrets.DATABASE_URL = `postgresql://postgres:${encodeURIComponent(vault.password)}@db.${action.projectRef}.supabase.co:5432/postgres?sslmode=require`;
        }
        const updatedKeys = await change(() => updateEnvSecrets(op.projectPath, secrets));
        op.result = { projectRef: action.projectRef, updatedKeys };
        return { status: "succeeded", result: op.result, costCommitted: true };
      }
      case "rollback_vercel": {
        await change(() => this.vercel(signal).rollback(action.projectId, action.deploymentId));
        const project = await this.vercel(signal).getProject(action.projectId);
        const current = project.targets?.production?.id;
        op.result = {
          projectId: action.projectId,
          deploymentId: action.deploymentId,
          productionDeploymentId: current,
        };
        return {
          status: current === action.deploymentId ? "succeeded" : "pending",
          result: op.result,
          costCommitted: true,
        };
      }
      default: {
        const exhaustive: never = action;
        throw new AppError("INTERNAL_ERROR", `Unsupported action ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  private assertDnsReply(
    record: { type: string; name: string; content: string },
    desired: { type: string; name: string; content: string },
  ): void {
    if (record.type !== desired.type || record.name !== desired.name || record.content !== desired.content) {
      throw new AppError(
        "PROVIDER_RESPONSE_INVALID",
        "The provider confirmed a DNS record that does not match the approved change.",
      );
    }
  }

  async checkConnections(): Promise<object> {
    const result: Record<string, unknown> = {};
    const creds = this.config.credentials;
    if (creds.vercelToken && creds.vercelTeamId) {
      try {
        const team = await this.vercel().team();
        result.vercel = { configured: true, accountId: team.id, plan: team.plan };
      } catch (err) {
        result.vercel = { configured: true, error: err instanceof AppError ? err.code : "INTERNAL_ERROR" };
      }
    } else {
      result.vercel = { configured: false, missingCredentials: ["VERCEL_TOKEN", "VERCEL_TEAM_ID"].filter((key) => !(key === "VERCEL_TOKEN" ? creds.vercelToken : creds.vercelTeamId)) };
    }
    if (creds.supabaseToken) {
      try {
        const projects = await this.supabase().listProjects();
        result.supabase = { configured: true, visibleProjects: projects.length };
      } catch (err) {
        result.supabase = { configured: true, error: err instanceof AppError ? err.code : "INTERNAL_ERROR" };
      }
    } else {
      result.supabase = { configured: false, missingCredentials: ["SUPABASE_ACCESS_TOKEN"] };
    }
    if (creds.cloudflareToken && creds.cloudflareAccountId) {
      try {
        const account = await this.cloudflare().account();
        result.cloudflare = { configured: true, accountId: account.id, name: account.name };
      } catch (err) {
        result.cloudflare = { configured: true, error: err instanceof AppError ? err.code : "INTERNAL_ERROR" };
      }
    } else {
      result.cloudflare = { configured: false, missingCredentials: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"].filter((key) => !(key === "CLOUDFLARE_API_TOKEN" ? creds.cloudflareToken : creds.cloudflareAccountId)) };
    }
    return { providers: result };
  }

  async searchDomains(query: string, limit: number): Promise<object> {
    const offers = await this.cloudflare().searchDomains(query, limit);
    return {
      query,
      checkedAt: new Date().toISOString(),
      offers: offers.map((offer) => ({
        name: offer.name,
        registrable: offer.registrable === true,
        tier: offer.tier,
        reason: offer.reason,
        pricing: offer.pricing
          ? {
              currency: offer.pricing.currency,
              registrationCost: offer.pricing.registration_cost,
              renewalCost: offer.pricing.renewal_cost,
            }
          : undefined,
      })),
      warning: "Suggestions are informational only; no purchase is made or reserved.",
    };
  }

  async checkDomainAvailability(domain: string): Promise<object> {
    const offer = await this.cloudflare().checkDomain(domain);
    if (!offer) {
      return { domain, registrable: false, checkedAt: new Date().toISOString(), warning: "Availability is not a reservation or price lock." };
    }
    return {
      domain: offer.name,
      registrable: offer.registrable === true,
      tier: offer.tier,
      reason: offer.reason,
      pricing: offer.pricing
        ? {
            currency: offer.pricing.currency,
            registrationCost: offer.pricing.registration_cost,
            renewalCost: offer.pricing.renewal_cost,
          }
        : undefined,
      checkedAt: new Date().toISOString(),
      warning: "Availability is not a reservation or price lock.",
    };
  }

  async getOperation(operationId: string, refresh: boolean): Promise<object> {
    await this.store.init();
    return this.store.withLock(async () => {
      const op = await this.store.load(operationId);
      await this.assertOperationRoot(op);
      let refreshError: string | undefined;
      if (refresh && op.status === "pending") {
        try {
          await this.refresh(op);
        } catch (err) {
          if (!(err instanceof AppError)) throw err;
          refreshError = err.code;
        }
      }
      return { ...this.safeOperation(op), refreshError };
    });
  }

  private async assertProviderAccount(op: Operation, signal?: AbortSignal): Promise<void> {
    if (op.account.provider === "vercel") {
      const team = await this.vercel(signal).team();
      if (team.id !== op.account.id) {
        throw new AppError(
          "ACCOUNT_MISMATCH",
          "The configured Vercel team no longer matches the approved operation account.",
        );
      }
    } else if (op.account.provider === "cloudflare") {
      const account = await this.cloudflare(signal).account();
      if (account.id !== op.account.id) {
        throw new AppError(
          "ACCOUNT_MISMATCH",
          "The configured Cloudflare account no longer matches the approved operation account.",
        );
      }
    }
  }

  private async refresh(op: Operation): Promise<void> {
    await this.assertProviderAccount(op);
    const action = op.action;
    let next: "pending" | "succeeded" | "failed" | undefined;
    if (action.kind === "deploy_vercel") {
      const deploymentId = op.result?.deploymentId as string | undefined;
      if (deploymentId) {
        const deployment = await this.vercel().getDeployment(deploymentId);
        op.result = { ...(op.result ?? {}), readyState: deployment.readyState, url: deployment.url };
        if (deployment.readyState === "READY") next = "succeeded";
        else if (deployment.readyState === "ERROR" || deployment.readyState === "CANCELED" || deployment.readyState === "BLOCKED") next = "failed";
      }
    } else if (action.kind === "create_supabase_project") {
      const ref = op.result?.ref as string | undefined;
      if (ref) {
        const project = await this.supabase().getProject(ref);
        op.result = { ...(op.result ?? {}), remoteStatus: project.status };
        if (project.status === "ACTIVE_HEALTHY") next = "succeeded";
        else if (project.status === "REMOVED") next = "failed";
      }
    } else if (action.kind === "create_cloudflare_zone") {
      const zoneId = op.result?.zoneId as string | undefined;
      if (zoneId) {
        const zone = await this.cloudflare().getZone(zoneId);
        op.result = { ...(op.result ?? {}), zoneStatus: zone.status, nameServers: zone.name_servers ?? [] };
        if (zone.status === "active") next = "succeeded";
      }
    } else if (action.kind === "register_domain") {
      const registration = await this.cloudflare()
        .getRegistration(action.domain)
        .catch((err) => {
          if (err instanceof ProviderError && err.status === 404) return undefined;
          throw err;
        });
      const checkWorkflow = async (): Promise<void> => {
        const workflow = await this.cloudflare()
          .registrationStatus(action.domain)
          .catch((err) => {
            if (err instanceof ProviderError && err.status === 404) return undefined;
            throw err;
          });
        if (workflow) {
          op.result = { ...(op.result ?? {}), registrationStatus: workflow.state };
          if (workflow.state === "succeeded") next = "succeeded";
          else if (workflow.state === "failed" || workflow.state === "cancelled") next = "failed";
        } else {
          op.result = {
            ...(op.result ?? {}),
            registrationStatus: "unknown",
            nextSteps:
              "No Cloudflare registration resource or workflow was found. Verify the purchase in the Cloudflare dashboard before preparing anything new; the operation will not be resubmitted.",
          };
        }
      };
      if (registration) {
        op.result = { ...(op.result ?? {}), registrationStatus: registration.status };
        if (registration.status === "active") {
          next = "succeeded";
        } else if (registration.status === "registration_pending") {
          await checkWorkflow();
        } else if (registration.status === "failed" || registration.status === "cancelled") {
          next = "failed";
        }
      } else {
        await checkWorkflow();
      }
    } else if (action.kind === "connect_vercel_domain" || action.kind === "verify_vercel_domain") {
      const projectDomain = await this.vercel().getProjectDomain(action.projectId, action.domain);
      const config = await this.vercel().domainConfig(action.projectId, action.domain);
      op.result = {
        ...(op.result ?? {}),
        verified: projectDomain.verified === true,
        misconfigured: config.misconfigured,
      };
      if (projectDomain.verified === true && config.misconfigured === false) next = "succeeded";
    } else if (action.kind === "rollback_vercel") {
      const project = await this.vercel().getProject(action.projectId);
      const current = project.targets?.production?.id;
      op.result = { ...(op.result ?? {}), productionDeploymentId: current };
      if (current === action.deploymentId) next = "succeeded";
    }
    if (next === "succeeded" || next === "failed") {
      op.status = next;
      if (next === "succeeded") {
        op.error = undefined;
      }
      op.events.push({ at: new Date().toISOString(), event: `status_${next}` });
    }
    await this.store.save(op);
  }

  private safeOperation(op: Operation): Record<string, unknown> {
    return {
      operationId: op.id,
      status: op.status,
      projectPath: op.projectPath,
      action: op.action,
      account: op.account,
      createdAt: op.createdAt,
      expiresAt: op.expiresAt,
      costCommitted: op.costCommitted,
      estimate: op.estimate,
      result: op.result,
      error: op.error,
      events: op.events.map((event) => event.event),
    };
  }

  private async isAllowedProjectPath(candidate: string): Promise<boolean> {
    try {
      return (await resolveProjectPath(candidate, this.config.projectRoots)) === candidate;
    } catch {
      return false;
    }
  }

  async listOperations(projectPath: string | undefined, limit: number): Promise<object> {
    let root: string | undefined;
    if (projectPath !== undefined) {
      root = await resolveProjectPath(projectPath, this.config.projectRoots);
    }
    const all = await this.store.listAll();
    const filtered: Operation[] = [];
    for (const op of all) {
      if (root !== undefined) {
        if (op.projectPath !== root) continue;
      } else if (!(await this.isAllowedProjectPath(op.projectPath))) {
        continue;
      }
      filtered.push(op);
    }
    const now = new Date();
    return {
      operations: filtered.slice(0, limit).map((op) => ({
        operationId: op.id,
        status: op.status === "prepared" && Date.parse(op.expiresAt) < now.getTime() ? "expired" : op.status,
        action: op.action.kind,
        provider: op.account.provider,
        createdAt: op.createdAt,
        estimatedMonthlyCostUsd: op.estimate.estimatedMonthlyCostUsd,
        estimatedUpfrontCostUsd: op.estimate.estimatedUpfrontCostUsd,
      })),
      note: "Entries are baseline reservations recorded locally, not a billing meter; unrelated account spend is excluded.",
    };
  }

  async cancel(operationId: string): Promise<object> {
    await this.store.init();
    return this.store.withLock(async () => {
      const op = await this.store.load(operationId);
      await this.assertOperationRoot(op);
      if (op.status !== "prepared") {
        throw new AppError(
          "INVALID_STATE",
          "Only prepared operations can be cancelled here. Pending or applied changes must be removed manually in the provider dashboard.",
        );
      }
      op.status = "cancelled";
      op.events.push({ at: new Date().toISOString(), event: "cancelled" });
      await this.store.save(op);
      return { operationId: op.id, status: "cancelled" };
    });
  }

  async reconcile(operationId: string, resourceId: string | undefined, server: McpServer): Promise<object> {
    await this.store.init();
    return this.store.withLock(async () => {
      const op = await this.store.load(operationId);
      await this.assertOperationRoot(op);
      if (op.status !== "unknown" && op.status !== "running" && op.status !== "pending") {
        return { operationId: op.id, status: op.status, result: op.result, note: "Nothing to reconcile." };
      }
      const action = op.action;
      await this.assertProviderAccount(op);
      let found: { status: "pending" | "succeeded" | "failed"; result: Record<string, unknown> } | undefined;
      if (action.kind === "create_vercel_project") {
        const project = await this.vercel().findProject(action.name);
        if (project) found = { status: "succeeded", result: { projectId: project.id, name: project.name } };
      } else if (action.kind === "deploy_vercel") {
        const deployments = await this.vercel().listDeployments(action.projectId);
        const match = deployments.find((deployment) => deployment.operationId === op.id);
        if (match) {
          if (match.readyState === "ERROR" || match.readyState === "CANCELED") {
            found = { status: "failed", result: { deploymentId: match.id, readyState: match.readyState } };
          } else {
            found = {
              status: match.readyState === "READY" ? "succeeded" : "pending",
              result: { deploymentId: match.id, readyState: match.readyState },
            };
          }
        }
      } else if (action.kind === "create_supabase_project") {
        if (!resourceId) {
          throw new AppError("RESOURCE_ID_REQUIRED", "Supabase reconciliation requires the project ref as resourceId.");
        }
        const project = await this.supabase().getProject(resourceId);
        const createdAt = project.created_at ? Date.parse(project.created_at) : 0;
        if (
          project.name === action.name &&
          (project.organization_slug === action.organizationSlug || project.organization_id === op.account.id) &&
          createdAt >= Date.parse(op.createdAt)
        ) {
          try {
            await requireApproval(
              server,
              `Attach Supabase project ${project.ref} (${project.name}) to operation ${op.id}? Its name, organization and creation time match, but ownership of the original create call cannot be proven. The stored database password will not be treated as bound to this project.`,
            );
          } catch {
            op.events.push({ at: new Date().toISOString(), event: "reconcile_attach_declined" });
            await this.store.save(op);
            throw new AppError(
              "RECONCILE_DECLINED",
              "The matching resource was not approved for attachment. The operation stays unknown.",
            );
          }
          found = {
            status: project.status === "ACTIVE_HEALTHY" ? "succeeded" : "pending",
            result: { ref: project.ref, name: project.name, remoteStatus: project.status, generatedPasswordBound: false },
          };
        }
      } else if (action.kind === "create_cloudflare_zone") {
        const zones = await this.cloudflare().listZones(action.domain);
        const zone = zones.find((entry) => entry.name === action.domain);
        if (zone) {
          found = {
            status: zone.status === "active" ? "succeeded" : "pending",
            result: { zoneId: zone.id, name: zone.name, zoneStatus: zone.status, nameServers: zone.name_servers ?? [] },
          };
        }
      } else if (action.kind === "register_domain") {
        const registration = await this.cloudflare()
          .getRegistration(action.domain)
          .catch((err) => {
            if (err instanceof ProviderError && err.status === 404) return undefined;
            throw err;
          });
        const checkWorkflow = async (): Promise<void> => {
          const workflow = await this.cloudflare()
            .registrationStatus(action.domain)
            .catch((err) => {
              if (err instanceof ProviderError && err.status === 404) return undefined;
              throw err;
            });
          if (workflow) {
            if (workflow.state === "succeeded") {
              found = { status: "succeeded", result: { domain: action.domain, registrationStatus: workflow.state } };
            } else if (workflow.state === "failed" || workflow.state === "cancelled") {
              found = { status: "failed", result: { domain: action.domain, registrationStatus: workflow.state } };
            } else {
              found = { status: "pending", result: { domain: action.domain, registrationStatus: workflow.state } };
            }
          }
        };
        if (registration) {
          if (registration.status === "active") {
            found = { status: "succeeded", result: { domain: action.domain, registrationStatus: registration.status, expiresAt: registration.expiresAt } };
          } else if (registration.status === "failed" || registration.status === "cancelled") {
            found = { status: "failed", result: { domain: action.domain, registrationStatus: registration.status } };
          } else {
            await checkWorkflow();
          }
        } else {
          await checkWorkflow();
        }
      } else if (action.kind === "upsert_dns_record") {
        const desired = op.preconditions.desired as { type: string; name: string; content: string; ttl?: number; proxied?: boolean };
        const recordId = (op.result?.recordId as string | undefined) ?? action.recordId;
        const zone = op.preconditions.zoneName as string;
        const fqName = desired.name === "@" ? zone : desired.name;
        const matches = (record: { type: string; name: string; content: string; ttl?: number; proxied?: boolean }) =>
          record.type === desired.type &&
          record.name === fqName &&
          record.content === desired.content &&
          (desired.ttl === undefined || record.ttl === desired.ttl) &&
          (desired.proxied === undefined || record.proxied === desired.proxied);
        if (recordId) {
          const record = await this.cloudflare()
            .getDns(action.zoneId, recordId)
            .catch((err) => {
              if (err instanceof ProviderError && err.status === 404) return undefined;
              throw err;
            });
          if (record && matches(record)) {
            found = { status: "succeeded", result: { recordId: record.id, type: record.type, name: record.name } };
          }
        } else {
          const records = await this.cloudflare().listDns(action.zoneId, fqName);
          const match = records.find((record) => matches(record));
          if (match) {
            found = { status: "succeeded", result: { recordId: match.id, type: match.type, name: match.name } };
          }
        }
      } else if (action.kind === "connect_vercel_domain" || action.kind === "verify_vercel_domain") {
        const projectDomain = await this.vercel().getProjectDomain(action.projectId, action.domain);
        const config = await this.vercel().domainConfig(action.projectId, action.domain);
        const ready = projectDomain.verified === true && config.misconfigured === false;
        found = ready
          ? { status: "succeeded", result: { domain: action.domain, verified: true, misconfigured: false } }
          : { status: "pending", result: { domain: action.domain, verified: projectDomain.verified === true, misconfigured: config.misconfigured } };
      } else if (action.kind === "rollback_vercel") {
        const project = await this.vercel().getProject(action.projectId);
        if (project.targets?.production?.id === action.deploymentId) {
          found = { status: "succeeded", result: { projectId: action.projectId, deploymentId: action.deploymentId } };
        }
      } else if (action.kind === "sync_env_to_vercel" || action.kind === "sync_supabase_env") {
        return {
          operationId: op.id,
          status: "unknown",
          nextSteps:
            "Remote and local credential values cannot be verified safely. Inspect the provider dashboard and the local .env file, then prepare a new operation with explicit approval if the sync did not complete.",
        };
      }
      if (!found) {
        op.status = "unknown";
        op.events.push({ at: new Date().toISOString(), event: "reconcile_no_proof" });
        await this.store.save(op);
        return {
          operationId: op.id,
          status: "unknown",
          nextSteps: "No matching remote resource was found. Verify in the provider dashboard before retrying; the operation will not be resubmitted automatically.",
        };
      }
      op.status = found.status;
      op.result = { ...(op.result ?? {}), ...found.result };
      if (found.status === "succeeded") {
        op.error = undefined;
      }
      if (found.status !== "failed") {
        op.costCommitted = true;
      }
      op.events.push({ at: new Date().toISOString(), event: `reconciled_${found.status}` });
      await this.store.save(op);
      return { operationId: op.id, status: op.status, result: op.result };
    });
  }

  async getResourceStatus(input: {
    provider: "vercel" | "supabase" | "cloudflare";
    resourceId: string;
    kind: "project" | "deployment" | "zone" | "domain";
    domain?: string;
  }): Promise<object> {
    if (input.provider === "vercel" && input.kind === "project") {
      const project = await this.vercel().getProject(input.resourceId);
      return { provider: "vercel", kind: "project", project: { id: project.id, name: project.name } };
    }
    if (input.provider === "vercel" && input.kind === "deployment") {
      const deployment = await this.vercel().getDeployment(input.resourceId);
      return {
        provider: "vercel",
        kind: "deployment",
        deployment: { id: deployment.id, url: deployment.url, readyState: deployment.readyState, target: deployment.target },
      };
    }
    if (input.provider === "supabase" && input.kind === "project") {
      const project = await this.supabase().getProject(input.resourceId);
      return {
        provider: "supabase",
        kind: "project",
        project: { ref: project.ref, name: project.name, status: project.status, region: project.region },
      };
    }
    if (input.provider === "cloudflare" && input.kind === "zone") {
      const zone = await this.cloudflare().getZone(input.resourceId);
      return { provider: "cloudflare", kind: "zone", zone: { id: zone.id, name: zone.name, status: zone.status, nameServers: zone.name_servers ?? [] } };
    }
    if (input.provider === "cloudflare" && input.kind === "domain" && input.domain) {
      const registration = await this.cloudflare().getRegistration(input.domain);
      return {
        provider: "cloudflare",
        kind: "domain",
        registration: {
          domain: registration.domainName,
          status: registration.status,
          expiresAt: registration.expiresAt,
          autoRenew: registration.autoRenew ?? false,
        },
      };
    }
    throw new AppError("INVALID_REQUEST", "The provider, kind and identifiers do not form a supported resource lookup.");
  }

  async inspectVercelDomain(projectId: string, domain: string): Promise<object> {
    const projectDomain = await this.vercel().getProjectDomain(projectId, domain);
    const config = await this.vercel().domainConfig(projectId, domain);
    return {
      domain: projectDomain.name,
      verified: projectDomain.verified === true,
      misconfigured: config.misconfigured,
      verification: (projectDomain.verification ?? []).map((entry) => ({
        type: entry.type,
        domain: entry.domain,
        value: entry.value,
      })),
      recommendedCNAME: (config.recommendedCNAME ?? []).map((entry) => entry.value),
      recommendedIPv4: (config.recommendedIPv4 ?? []).flatMap((entry) => entry.value),
    };
  }
}

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DNS_UNDERSCORE_LABEL = /^_[a-z0-9-]{1,62}$/;

function normalizeDnsName(name: string, zoneName: string): string {
  const trimmed = name.trim().toLowerCase().replace(/\.$/, "");
  if (trimmed === "@" || trimmed === zoneName) return zoneName;
  if (!trimmed.endsWith(`.${zoneName}`)) {
    throw new AppError("DNS_OUTSIDE_ZONE", "The DNS record name must be '@' or a name inside the zone.");
  }
  return trimmed;
}

function validateDnsRecord(type: string, name: string, content: string, ttl: number, proxied: boolean): void {
  if (name.includes("*")) {
    throw new AppError("INVALID_DNS", "Wildcard DNS records are not supported.");
  }
  const labels = name.split(".");
  const validLabels = labels.every((label) => {
    if (DNS_LABEL.test(label)) return true;
    return type === "TXT" && DNS_UNDERSCORE_LABEL.test(label);
  });
  if (!validLabels) {
    throw new AppError("INVALID_DNS", "The DNS record name contains invalid labels.");
  }
  if (type !== "TXT" && content.includes("*")) {
    throw new AppError("INVALID_DNS", "Wildcard DNS record content is not supported.");
  }
  if (ttl !== 1 && ttl < 60) {
    throw new AppError("INVALID_DNS", "TTL must be 1 (automatic) or at least 60 seconds.");
  }
  if (type === "A" && isIP(content) !== 4) {
    throw new AppError("INVALID_DNS", "An A record must contain an IPv4 address.");
  }
  if (type === "AAAA" && isIP(content) !== 6) {
    throw new AppError("INVALID_DNS", "An AAAA record must contain an IPv6 address.");
  }
  if (type === "CNAME") {
    const target = content.replace(/\.$/, "");
    if (
      target.includes("*") ||
      !/^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/.test(target)
    ) {
      throw new AppError("INVALID_DNS", "A CNAME record must point to a valid hostname.");
    }
  }
  if (type === "TXT" && proxied) {
    throw new AppError("INVALID_DNS", "TXT records cannot be proxied.");
  }
}
