import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../config.js";
import { requireApproval } from "../approval.js";
import { AppError } from "../errors.js";
import { collectDeploymentManifest } from "../utils/deployment.js";
import { resolveProjectPath } from "../utils/files.js";
import { assertPublic } from "./adapter.js";
import { NativeBridge } from "./native.js";
import { newPlan } from "./planner.js";
import { Registry } from "./registry.js";
import { PlanStore } from "./store.js";
import { analyzeWorkload } from "./workload.js";
import { probeHttps, type HealthProbe } from "./health.js";
import { approvalDigest, constraintsSchema, outcomeSchema, preparedSchema, pricingFresh, type Constraints, type Overrides, type Plan, type Step } from "./schema.js";

export class InfrastructureEngine {
  readonly registry: Registry;
  readonly store: PlanStore;
  readonly native: NativeBridge;
  private initialized?: Promise<void>;
  constructor(readonly config: AppConfig, readonly deps: { fetch?: typeof fetch; healthProbe?: HealthProbe } = {}) {
    this.registry = new Registry(config, deps); this.store = new PlanStore(config.stateDir); this.native = new NativeBridge(config, deps);
  }
  async init(): Promise<void> {
    this.initialized ??= this.registry.init().then(() => this.migrate());
    try { await this.initialized; } catch (err) { this.initialized = undefined; throw err; }
  }
  private async root(projectPath: string): Promise<string> {
    const root = await resolveProjectPath(projectPath, this.config.projectRoots);
    // State is never a deployment artifact, including on the first lazy creation.
    const state = await realpath(this.config.stateDir).catch(() => path.resolve(this.config.stateDir));
    const rel = path.relative(root, state);
    if (rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel))) throw new AppError("STATE_INSIDE_PROJECT", "Keep the private state directory outside the deployable project.");
    return root;
  }
  private async load(id: string): Promise<Plan> {
    await this.init(); const plan = await this.store.load(id);
    if (await this.root(plan.projectPath) !== plan.projectPath) throw new AppError("PATH_NOT_ALLOWED", "The project location changed.");
    return plan;
  }
  private step(plan: Plan, id: string): Step {
    const step = plan.steps.find((s) => s.id === id);
    if (!step) throw new AppError("NOT_FOUND", "Infrastructure step not found.");
    return step;
  }
  private resolve(plan: Plan, value: unknown): unknown {
    if (Array.isArray(value)) return value.map((v) => this.resolve(plan, v));
    if (!value || typeof value !== "object") return value;
    const v = value as Record<string, unknown>;
    if (typeof v.$operation === "string") {
      const source = this.step(plan, v.$operation);
      if (source.status !== "succeeded" || !source.legacyOperationId) throw new AppError("DEPENDENCY_PENDING", "The source operation has not succeeded.");
      return source.legacyOperationId;
    }
    if (typeof v.$resource === "string") {
      const source = this.step(plan, v.$resource);
      const resources = source.resources.filter((r) => r.kind === v.kind);
      if (source.status !== "succeeded" || resources.length !== 1) throw new AppError("DEPENDENCY_PENDING", "A unique completed dependency resource is required.");
      return resources[0]!.id;
    }
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, this.resolve(plan, x)]));
  }
  private async source(plan: Plan): Promise<void> {
    await this.root(plan.projectPath);
    if (plan.intent === "deploy" && plan.workload.sourceDigest && (await collectDeploymentManifest(plan.projectPath)).digest !== plan.workload.sourceDigest) throw new AppError("SOURCE_CHANGED", "Project source changed since planning. Propose a new plan before execution.");
  }
  private async adapterPrepare(plan: Plan, step: Step, signal?: AbortSignal) {
    const adapter = this.registry.adapters.get(step.provider);
    if (!adapter || !adapter.manifest.operations.includes(step.operation)) throw new AppError("ADAPTER_UNAVAILABLE", "Install an executable adapter supporting this operation.");
    if (this.registry.missing(step.provider).length) throw new AppError("SETUP_REQUIRED", "Configure the provider's required credentials and account settings.");
    const parameters = this.resolve(plan, step.parameters) as Record<string, unknown>;
    const raw = await adapter.invoke({ protocolVersion: 2, method: "prepare", operationId: `${plan.id}:${step.id}`, operation: step.operation, parameters, resources: step.resources }, signal);
    const parsed = preparedSchema.safeParse(raw);
    if (!parsed.success) throw new AppError("INVALID_ADAPTER_RESPONSE", "The adapter did not return a valid prepared operation.");
    const prepared = parsed.data;
    if (Date.parse(prepared.expiresAt) <= Date.now() || Date.parse(prepared.expiresAt) > Date.now() + 10 * 60_000) throw new AppError("INVALID_ADAPTER_RESPONSE", "Prepared operations must expire within ten minutes.");
    if (prepared.estimate.upfrontCents > 0 || prepared.estimate.recurring.some((i) => i.cents > 0)) {
      if (!pricingFresh(prepared.estimate.reviewedAt)) throw new AppError("PRICING_STALE", "Paid execution requires fresh reviewed pricing.");
    }
    if (prepared.mutations.some((m) => m.action === "purchase")) {
      const quote = prepared.quote;
      if (!quote || quote.registrar !== step.provider || !quote.available || !quote.eligible || quote.registrationCents === null || quote.renewalCents === null || quote.tax !== "included") throw new AppError("INCOMPLETE_QUOTE", "Purchases require an eligible, tax-inclusive registration and renewal quote.");
      if (Date.now() - Date.parse(quote.quotedAt) > 60_000 || Date.parse(quote.quotedAt) > Date.now()) throw new AppError("QUOTE_EXPIRED", "Requote the domain immediately before preparing purchase.");
      if ((typeof parameters.domain === "string" && parameters.domain !== quote.domain) || (typeof parameters.years === "number" && parameters.years !== quote.years) || quote.registrationCents !== prepared.estimate.upfrontCents) throw new AppError("INCOMPLETE_QUOTE", "The purchase quote must match the exact domain, term and upfront charge.");
      if (plan.intent === "teardown") throw new AppError("DOMAIN_PROTECTED", "Domain purchases and cancellations are excluded from teardown.");
    }
    if (plan.intent === "teardown" && (step.resources.some((r) => /domain|registrar/i.test(r.kind)) || prepared.mutations.some((m) => /domain|registrar/i.test(m.target)))) throw new AppError("DOMAIN_PROTECTED", "Domains are never removed automatically.");
    return prepared;
  }
  async propose(projectPath: string, constraints: Constraints, overrides: Overrides = {}): Promise<Plan> {
    await this.init(); assertPublic(overrides, this.registry.privateValues());
    const root = await this.root(projectPath);
    const plan = newPlan(root, await analyzeWorkload(root, this.config, overrides), constraints, overrides, this.registry);
    await this.store.save(plan); return plan;
  }
  async get(id: string, refresh = false, server?: McpServer): Promise<Plan> {
    let plan = await this.load(id);
    if (refresh && server) for (const step of plan.steps) {
      if (["pending", "unknown", "running", "approving"].includes(step.status) && !this.leaseAlive(step)) {
        try { await this.reconcile(id, step.id, undefined, server); } catch (err) { if (!(err instanceof AppError)) throw err; }
      }
    }
    plan = await this.load(id); return plan;
  }
  private leaseAlive(step: Step): boolean {
      const lease = step.lease; if (!lease || Date.parse(lease.until) <= Date.now()) return false;
    if (lease.hostname !== hostname()) return Date.parse(lease.until) > Date.now();
    try { process.kill(lease.pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code !== "ESRCH"; }
  }
  async prepare(id: string): Promise<Plan> {
    const plan = await this.load(id); await this.source(plan);
    for (const snapshot of plan.steps) {
      if (!["draft", "blocked"].includes(snapshot.status)) continue;
      const current = await this.load(id); const step = this.step(current, snapshot.id);
      if (!step.dependsOn.every((dep) => this.step(current, dep).status === "succeeded")) continue;
      try {
        await this.registry.validate(step.provider, step.adapterChecksum);
        if (this.registry.get(step.provider).tier !== "executable") throw new AppError("ADAPTER_UNAVAILABLE", "This provider is recommendation-only until an adapter is explicitly installed.");
        let legacyId: string | undefined;
        const prepared = this.registry.adapters.has(step.provider) ? await this.adapterPrepare(current, step) : await (async () => {
          const op = await this.native.prepare(current, step, this.resolve(current, step.parameters) as Record<string, unknown>);
          legacyId = op.id; return this.native.prepared(op);
        })();
        try {
          await this.store.transaction(id, async (fresh) => {
            const target = this.step(fresh, step.id);
            if (target.revision !== step.revision || !["draft", "blocked"].includes(target.status)) throw new AppError("STALE_PLAN", "The step changed during preparation.");
            target.prepared = prepared; target.legacyOperationId = legacyId; target.status = "prepared"; target.error = undefined; target.revision++; target.digest = approvalDigest(target);
            await this.store.reserve(fresh);
          });
        } catch (err) { if (legacyId) await this.native.service.cancel(legacyId).catch(() => {}); throw err; }
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
        await this.store.transaction(id, (fresh) => { const target = this.step(fresh, step.id); if (["draft", "blocked"].includes(target.status)) { target.status = "blocked"; target.error = err.code; target.setupRequirements = [err.message]; target.revision++; } });
      }
    }
    return this.load(id);
  }
  async execute(id: string, stepId: string, server: McpServer, signal?: AbortSignal): Promise<Plan> {
    const snapshot = await this.load(id); const step = this.step(snapshot, stepId);
    if (step.status === "succeeded") return snapshot;
    if (step.status !== "prepared" || !step.prepared || step.digest !== approvalDigest(step)) throw new AppError("INVALID_STATE", "Prepare this step first; uncertain or running mutations must be reconciled.");
    if (!step.dependsOn.every((dep) => this.step(snapshot, dep).status === "succeeded")) throw new AppError("DEPENDENCY_PENDING", "Complete the preceding steps first.");
    if (Date.parse(step.prepared.expiresAt) <= Date.now()) throw new AppError("OPERATION_EXPIRED", "Cancel the expired step and propose a fresh plan.");
    await this.source(snapshot); await this.registry.validate(step.provider, step.adapterChecksum);
    const nonce = randomUUID();
    await this.store.transaction(id, async (plan) => {
      const target = this.step(plan, stepId);
      if (target.revision !== step.revision || target.status !== "prepared") throw new AppError("STALE_PLAN", "The step changed before approval.");
      target.status = "approving"; target.revision++; target.lease = { nonce, pid: process.pid, hostname: hostname(), until: new Date(Date.now() + 5 * 60_000).toISOString() };
      await this.store.reserve(plan);
    });
    let mutationStarted = false;
    try {
      if (step.legacyOperationId) {
        if (step.operation === "configure_vercel_dns") {
          const op = await this.native.store.load(step.legacyOperationId);
          const action = await this.native.action(step, this.resolve(snapshot, step.parameters) as Record<string, unknown>);
          if (JSON.stringify(action) !== JSON.stringify(op.action)) throw new AppError("PRECONDITION_CHANGED", "The recommended DNS configuration changed. Prepare a new plan.");
        }
        // The native journal owns the exact approval, final account/price/source
        // revalidation and durable running transition for bundled providers.
        const op = await this.native.execute(step, server, signal);
        await this.store.transaction(id, (plan) => { const target = this.step(plan, stepId); if (target.lease?.nonce !== nonce) throw new AppError("STALE_PLAN", "The execution lease changed."); target.status = op.status; target.resources = this.native.resources(op); target.committed = op.costCommitted; target.lease = undefined; target.revision++; });
      } else {
        const first = await this.adapterPrepare(snapshot, step, signal);
        if (approvalDigest({ ...step, prepared: first }) !== step.digest) throw new AppError("PRECONDITION_CHANGED", "The account, price or resource changes differ from preparation.");
        await requireApproval(server, `Approve this exact infrastructure step for ${snapshot.projectPath}?\nProvider: ${step.provider}; account: ${first.account}; region: ${first.region ?? "unspecified"}.\nMutations: ${JSON.stringify(first.mutations)}\nEstimate: ${JSON.stringify(first.estimate)}\nDomain terms: ${JSON.stringify(first.quote ?? null)}\nApproval digest: ${step.digest}. Estimates are not billing caps.`, signal);
        await this.source(snapshot); await this.registry.validate(step.provider, step.adapterChecksum);
        const final = await this.adapterPrepare(snapshot, step, signal);
        if (approvalDigest({ ...step, prepared: final }) !== step.digest) throw new AppError("PRECONDITION_CHANGED", "Provider state or pricing changed during approval. No mutation was sent.");
        if (signal?.aborted) throw new AppError("CANCELLED", "The request was cancelled before execution.");
        await this.store.transaction(id, async (plan) => {
          const target = this.step(plan, stepId);
          if (target.lease?.nonce !== nonce || target.status !== "approving" || target.digest !== step.digest) throw new AppError("STALE_PLAN", "The approval no longer matches the step.");
          target.status = "running"; target.revision++; target.prepared = final; await this.store.reserve(plan);
        });
        mutationStarted = true;
        const parameters = this.resolve(snapshot, step.parameters) as Record<string, unknown>;
        const raw = await this.registry.adapters.get(step.provider)!.invoke({ protocolVersion: 2, method: "execute", operationId: `${id}:${stepId}`, operation: step.operation, parameters, prepared: final, resources: step.resources }, signal);
        const parsed = outcomeSchema.safeParse(raw);
        if (!parsed.success || parsed.data.resources.some((r) => r.provider !== step.provider || r.account !== final.account)) throw new AppError("INVALID_ADAPTER_RESPONSE", "Adapter resource identities were invalid; reconciliation is required.");
        await this.store.transaction(id, (plan) => { const target = this.step(plan, stepId); if (target.lease?.nonce !== nonce) throw new AppError("STALE_PLAN", "The execution lease changed."); target.status = parsed.data.status; target.resources = parsed.data.resources; target.committed = true; target.lease = undefined; target.revision++; });
      }
    } catch (err) {
      const op = step.legacyOperationId ? await this.native.store.load(step.legacyOperationId) : undefined;
      await this.store.transaction(id, (plan) => {
        const target = this.step(plan, stepId); if (target.lease?.nonce !== nonce) return;
        target.status = op?.status ?? (mutationStarted ? "unknown" : err instanceof AppError && ["APPROVAL_DECLINED", "CANCELLED"].includes(err.code) ? "cancelled" : "prepared");
        target.committed ||= op?.costCommitted ?? mutationStarted; target.error = err instanceof AppError ? err.code : "INTERNAL_ERROR";
        if (op) target.resources = this.native.resources(op);
        target.lease = undefined; target.revision++;
      });
      throw err;
    }
    await this.retireTeardownResources(id);
    return this.load(id);
  }
  async cancel(id: string, stepId: string): Promise<Plan> {
    const plan = await this.load(id); const step = this.step(plan, stepId);
    if (!["draft", "blocked", "prepared", "approving", "cancelled"].includes(step.status)) throw new AppError("RECONCILIATION_REQUIRED", "Running or uncertain resources cannot be cancelled; reconcile them first.");
    if (step.legacyOperationId && step.status !== "cancelled") await this.native.service.cancel(step.legacyOperationId);
    await this.store.transaction(id, (fresh) => { const target = this.step(fresh, stepId); if (target.revision !== step.revision) throw new AppError("STALE_PLAN", "The step changed before cancellation."); target.status = "cancelled"; target.lease = undefined; target.revision++; });
    return this.load(id);
  }
  async reconcile(id: string, stepId: string, resourceIdentity: string | undefined, server: McpServer): Promise<Plan> {
    const plan = await this.load(id); const step = this.step(plan, stepId);
    if (!["running", "pending", "unknown", "approving"].includes(step.status)) return plan;
    if (this.leaseAlive(step)) throw new AppError("STEP_BUSY", "The step is still active; local status remains readable.");
    await this.registry.validate(step.provider, step.adapterChecksum);
    let status: Step["status"]; let resources = step.resources; let committed = step.committed;
    if (step.legacyOperationId) {
      await this.native.service.reconcile(step.legacyOperationId, resourceIdentity, server);
      const op = await this.native.store.load(step.legacyOperationId); status = op.status; resources = this.native.resources(op); committed = op.costCommitted;
    } else if (step.status === "approving") {
      status = "prepared"; // Durable running must precede every external mutation.
    } else {
      const raw = await this.registry.adapters.get(step.provider)?.invoke({ protocolVersion: 2, method: "reconcile", operationId: `${id}:${stepId}`, operation: step.operation, parameters: { ...this.resolve(plan, step.parameters) as Record<string, unknown>, ...(resourceIdentity ? { resourceIdentity } : {}) }, prepared: step.prepared, resources: step.resources });
      const parsed = outcomeSchema.safeParse(raw);
      if (!parsed.success || parsed.data.resources.some((r) => r.provider !== step.provider || r.account !== step.prepared?.account)) throw new AppError("INVALID_ADAPTER_RESPONSE", "Reconciliation did not prove valid resource identities.");
      status = parsed.data.status; resources = parsed.data.resources; committed ||= status !== "failed";
    }
    await this.store.transaction(id, (fresh) => { const target = this.step(fresh, stepId); if (target.revision !== step.revision) throw new AppError("STALE_PLAN", "The step changed during reconciliation."); target.status = status; target.resources = resources; target.committed = committed; target.lease = undefined; target.revision++; });
    await this.retireTeardownResources(id);
    return this.load(id);
  }
  async teardown(id: string, resourceIds?: string[]): Promise<Plan> {
    const source = await this.load(id);
    if (source.steps.some((s) => ["running", "unknown", "pending", "approving"].includes(s.status))) throw new AppError("RECONCILIATION_REQUIRED", "Resolve uncertain resources before planning teardown.");
    const selected = new Set(resourceIds ?? source.steps.flatMap((s) => s.resources.map((r) => r.id)));
    const known = new Set(source.steps.flatMap((s) => s.resources.map((r) => r.id)));
    if ([...selected].some((r) => !known.has(r))) throw new AppError("UNKNOWN_RESOURCE", "Teardown can target only recorded resource identities.");
    const steps: Step[] = [];
    for (const original of [...source.steps].reverse()) {
      if (original.retired) continue;
      const manifest = this.registry.get(original.provider);
      const resources = original.resources.filter((r) => selected.has(r.id) && !/domain|registrar/i.test(r.kind) && (!manifest.teardownKinds || manifest.teardownKinds.includes(r.kind)));
      if (!resources.length) continue;
      steps.push({ id: `remove-${original.id}`, provider: original.provider, operation: "teardown", parameters: { resources, sourcePlanId: source.id }, dependsOn: [], revision: 0, status: manifest.teardown && manifest.operations.includes("teardown") ? "draft" : "blocked", adapterChecksum: this.registry.checksum(original.provider), adapterVersion: manifest.version, resources, committed: false, retired: false, setupRequirements: [], ...(!manifest.teardown ? { error: "TEARDOWN_UNSUPPORTED" } : {}) });
    }
    for (let i = 1; i < steps.length; i++) steps[i]!.dependsOn = [steps[i - 1]!.id];
    const plan: Plan = { ...source, id: randomUUID(), revision: 0, createdAt: new Date().toISOString(), intent: "teardown", sourcePlanId: source.id, steps, verification: { status: "not_checked", checks: [] }, events: [{ at: new Date().toISOString(), event: "teardown_proposed_domains_preserved" }] };
    await this.store.save(plan); return plan;
  }
  private async retireTeardownResources(id: string): Promise<void> {
    const plan = await this.store.load(id);
    if (plan.intent !== "teardown" || !plan.sourcePlanId) return;
    const removed = new Set(plan.steps.filter((s) => s.status === "succeeded").flatMap((s) => s.resources.map((r) => `${r.provider}:${r.account}:${r.kind}:${r.id}`)));
    if (!removed.size) return;
    await this.store.transaction(plan.sourcePlanId, (source) => {
      for (const step of source.steps) if (step.resources.length && step.resources.every((r) => removed.has(`${r.provider}:${r.account}:${r.kind}:${r.id}`))) step.retired = true;
    });
  }
  async verify(id: string): Promise<Plan> {
    const plan = await this.load(id);
    const checks: Plan["verification"]["checks"] = [];
    for (const step of plan.steps) {
      checks.push({ kind: `step:${step.id}`, status: step.status === "succeeded" ? "passed" : step.status === "failed" ? "failed" : "unverified", detail: step.status === "succeeded" ? "The provider operation completed." : "The operation has not completed successfully." });
      if (step.status !== "succeeded" || !this.registry.adapters.has(step.provider)) continue;
      const raw = await this.registry.adapters.get(step.provider)!.invoke({ protocolVersion: 2, method: "verify", operationId: `${id}:${step.id}`, operation: step.operation, parameters: this.resolve(plan, step.parameters) as Record<string, unknown>, resources: step.resources });
      // Semantic probes must be explicit, bounded and contain no provider bodies.
      const parsed = z.object({ checks: z.array(z.object({ kind: z.string().max(100), status: z.enum(["passed", "failed", "unverified"]), detail: z.string().max(1000) }).strict()).max(32) }).strict().safeParse(raw);
      if (parsed.success) checks.push(...parsed.data.checks);
    }
    const urls = [...new Set(plan.steps.filter((s) => s.status === "succeeded").flatMap((s) => s.resources.flatMap((r) => r.url ? [r.url] : [])))];
    for (const url of urls.slice(0, 8)) {
      const result = await (this.deps.healthProbe ?? probeHttps)(url);
      checks.push({ kind: "http", ...result });
      if (result.status === "passed" && plan.workload.capabilities.includes("static") && !checks.some((c) => c.kind === "static")) checks.push({ kind: "static", status: "passed", detail: "The completed static deployment serves a successful HTTPS response." });
    }
    if (plan.workload.capabilities.some((c) => ["static", "edge", "serverless", "server", "container", "websocket"].includes(c)) && !checks.some((c) => c.kind === "http")) checks.push({ kind: "http", status: "unverified", detail: "An application HTTPS probe is required." });
    const required = plan.workload.capabilities.filter((c) => !["network", "dns", "registrar"].includes(c));
    for (const capability of required) if (!checks.some((c) => c.kind === capability)) checks.push({ kind: capability, status: "unverified", detail: "An application-level probe is required; provider acceptance alone does not prove the application works." });
    await this.store.transaction(id, (fresh) => { if (fresh.revision !== plan.revision) throw new AppError("STALE_PLAN", "Resources changed while verification ran."); fresh.verification = { checkedAt: new Date().toISOString(), status: checks.length > 0 && checks.every((c) => c.status === "passed") ? "verified" : "incomplete", checks }; });
    return this.load(id);
  }
  private async migrate(): Promise<void> {
    await this.store.journal.withLock(async () => {
      const referenced = new Set((await this.store.list()).flatMap((p) => p.steps.map((s) => s.legacyOperationId).filter(Boolean)));
      for (const op of await this.native.store.listAll()) {
        if (referenced.has(op.id)) continue;
        if (await this.store.journal.readRecord(`plan-${op.id}.json`) !== undefined) continue;
        const step: Step = { id: "legacy", provider: op.account.provider, operation: op.action.kind, parameters: op.action, dependsOn: [], revision: 0, status: op.status, adapterChecksum: this.registry.checksum(op.account.provider), adapterVersion: "2.0.0", legacyOperationId: op.id, resources: this.native.resources(op), prepared: this.native.prepared(op), committed: op.costCommitted, retired: false, setupRequirements: [] };
        step.digest = approvalDigest(step);
        const plan: Plan = { version: 2, id: op.id, revision: 0, projectPath: op.projectPath, createdAt: op.createdAt, intent: "legacy", workload: { blueprint: "full_stack_web", capabilities: [], frameworks: [], runtime: "unknown", ports: [], envKeys: [], privilegedEnvKeys: [], evidence: [], questions: ["Migrated legacy operation; original journal retained unchanged."], truncated: false }, constraints: constraintsSchema.parse({ maxMonthlyBudgetUsd: op.maxMonthlyBudgetUsd, maxUpfrontBudgetUsd: op.maxUpfrontBudgetUsd, commercialUse: op.commercialUse }), overrides: {}, recommended: null, alternatives: [], rejected: [], steps: [step], verification: { status: "not_checked", checks: [] }, events: [{ at: new Date().toISOString(), event: "migrated_v1_original_retained" }] };
        await this.store.save(plan);
      }
    }, "migration-v2");
  }
}
