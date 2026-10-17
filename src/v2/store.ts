import { OperationStore, aggregateCosts } from "../operations/store.js";
import { AppError } from "../errors.js";
import { planSchema, type Plan } from "./schema.js";

export class PlanStore {
  readonly journal: OperationStore;
  constructor(stateDir: string) { this.journal = new OperationStore(stateDir); }
  async load(id: string): Promise<Plan> {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new AppError("NOT_FOUND", "Plan not found.");
    const raw = await this.journal.readRecord(`plan-${id}.json`);
    if (raw === undefined) throw new AppError("NOT_FOUND", "Plan not found.");
    const parsed = planSchema.safeParse(raw);
    if (!parsed.success || parsed.data.id !== id) throw new AppError("CORRUPT_STATE", "The stored infrastructure plan is invalid.");
    return parsed.data;
  }
  async save(plan: Plan): Promise<void> {
    const parsed = planSchema.safeParse(plan);
    if (!parsed.success) throw new AppError("CORRUPT_STATE", "Refusing to save an invalid infrastructure plan.");
    await this.journal.writeRecord(`plan-${plan.id}.json`, parsed.data);
  }
  async list(): Promise<Plan[]> {
    return Promise.all((await this.journal.listRecords()).map((name) => this.load(name.slice(5, -5))));
  }
  async transaction<T>(id: string, update: (plan: Plan) => T | Promise<T>): Promise<T> {
    return this.journal.withLock(async () => {
      const plan = await this.load(id);
      const statuses = new Map(plan.steps.map((s) => [s.id, s.status]));
      const result = await update(plan);
      for (const step of plan.steps) if (statuses.get(step.id) !== step.status) plan.events.push({ at: new Date().toISOString(), event: `${step.id}:${step.status}`.slice(0, 128) });
      plan.events = plan.events.slice(-512);
      plan.revision++;
      await this.save(plan);
      return result;
    }, `plan-${id}`);
  }
  async reserve(plan: Plan): Promise<void> {
    // This lock is shared with v1 budget reservations, and is never held across
    // a provider call or an approval prompt.
    await this.journal.withLock(async () => {
      const all = (await this.list()).filter((p) => p.projectPath === plan.projectPath && p.id !== plan.id);
      const globalPlans = await this.list();
      const active = (s: Plan["steps"][number]) => !["draft", "blocked", "cancelled"].includes(s.status) && !(s.status === "failed" && !s.committed) && !(s.status === "prepared" && s.prepared && Date.parse(s.prepared.expiresAt) < Date.now());
      const domainOf = (s: Plan["steps"][number]) => s.prepared?.quote?.domain ?? (s.operation === "register_domain" && typeof s.parameters.domain === "string" ? s.parameters.domain : undefined);
      for (const step of plan.steps) {
        const domain = domainOf(step);
        if (!domain || !active(step)) continue;
        if (globalPlans.some((other) => other.id !== plan.id && other.steps.some((s) => active(s) && domainOf(s) === domain && !(step.legacyOperationId && s.legacyOperationId === step.legacyOperationId)))) throw new AppError("DOMAIN_PURCHASE_EXISTS", "An active or completed purchase for this domain is already recorded. Reconcile it before another purchase attempt.");
      }
      const legacy = aggregateCosts(await this.journal.listForProject(plan.projectPath), new Date());
      const recurring = new Map<string, number>();
      let upfront = legacy.upfrontCents;
      for (const p of [...all, plan]) for (const step of p.steps) {
        if (step.legacyOperationId || !step.prepared || ["draft", "blocked", "cancelled"].includes(step.status) || (step.status === "failed" && !step.committed)) continue;
        if (["prepared", "approving"].includes(step.status) && Date.parse(step.prepared.expiresAt) < Date.now()) continue;
        if (!step.retired) for (const item of step.prepared.estimate.recurring) {
          const key = `${step.provider}:${step.prepared.account}:${item.key}`;
          recurring.set(key, Math.max(recurring.get(key) ?? 0, item.cents));
        }
        upfront += step.prepared.estimate.upfrontCents;
      }
      const monthly = legacy.monthlyCents + [...recurring.values()].reduce((a, b) => a + b, 0);
      if (!Number.isSafeInteger(monthly) || !Number.isSafeInteger(upfront) || monthly > Math.round(plan.constraints.maxMonthlyBudgetUsd * 100) || upfront > Math.round(plan.constraints.maxUpfrontBudgetUsd * 100)) throw new AppError("BUDGET_EXCEEDED", "Active reservations for this project exceed the declared budget.");
      await this.save(plan);
    });
  }
}
