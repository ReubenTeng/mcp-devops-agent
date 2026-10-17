import { randomUUID } from "node:crypto";
import path from "node:path";
import { AppError } from "../errors.js";
import { Registry } from "./registry.js";
import { pricingFresh, type Candidate, type Capability, type Constraints, type Manifest, type Overrides, type Plan, type Step, type Workload } from "./schema.js";

const compute = new Set<Capability>(["static", "edge", "serverless", "server", "container", "worker", "cron", "websocket", "disk"]);
export function rankCandidates(workload: Workload, constraints: Constraints, overrides: Overrides, registry: Registry): Pick<Plan, "recommended" | "alternatives" | "rejected"> {
  const rejected: Plan["rejected"] = [];
  const eligible: Manifest[] = [];
  for (const m of [...registry.manifests.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    const reasons: string[] = [];
    if (!m.capabilities.some((c) => workload.capabilities.includes(c))) continue;
    if (constraints.commercialUse && m.commercialUse === "restricted") reasons.push("Commercial use is restricted.");
    if (constraints.reliability === "production" && m.reliability === "development") reasons.push("Production reliability is required.");
    if (constraints.region && m.capabilities.some((c) => c !== "dns" && c !== "registrar") && !m.regions.includes(constraints.region)) reasons.push("The required region is not verified by this manifest.");
    if (constraints.compliance.some((c) => !m.compliance.includes(c))) reasons.push("The required compliance evidence is absent.");
    if (constraints.latencyMs && (!m.latencyMs || m.latencyMs > constraints.latencyMs)) reasons.push("The latency requirement is not verified by this manifest.");
    if (constraints.monthlyRequests && m.maxMonthlyRequests !== undefined && constraints.monthlyRequests > m.maxMonthlyRequests) reasons.push("The declared request volume exceeds the adapter's tested limit.");
    if (constraints.storageGb && m.maxStorageGb !== undefined && constraints.storageGb > m.maxStorageGb) reasons.push("The declared storage exceeds the adapter's tested limit.");
    if (workload.buildCommand && m.buildMode === "prebuilt") reasons.push("This adapter requires prebuilt static output; this project declares a build command.");
    if (m.capabilities.some((c) => compute.has(c) && workload.capabilities.includes(c)) && m.runtimes.length && !m.runtimes.includes(workload.runtime)) reasons.push("The application runtime is unsupported.");
    if (reasons.length) rejected.push({ provider: m.id, reasons }); else eligible.push(m);
  }
  const requirements = [...new Set(workload.capabilities)].sort((a, b) => {
    const count = (c: Capability) => eligible.filter((m) => m.capabilities.includes(c) && (!overrides.providers?.[c] || overrides.providers[c] === m.id)).length;
    return count(a) - count(b) || a.localeCompare(b);
  });
  if (!requirements.length) return { recommended: null, alternatives: [], rejected };
  // Bounded beam search prevents exponential provider combinations. Group all compute
  // requirements on one provider; database and DNS roles may use separate providers.
  let partials: { assignments: Candidate["assignments"]; providers: string[] }[] = [{ assignments: {}, providers: [] }];
  for (const capability of requirements) {
    const next: typeof partials = [];
    for (const partial of partials) for (const m of eligible) {
      if (!m.capabilities.includes(capability) || (overrides.providers?.[capability] && overrides.providers[capability] !== m.id)) continue;
      const existingCompute = Object.entries(partial.assignments).find(([c]) => compute.has(c as Capability))?.[1];
      if (compute.has(capability) && existingCompute && existingCompute !== m.id) continue;
      next.push({ assignments: { ...partial.assignments, [capability]: m.id }, providers: [...new Set([...partial.providers, m.id])].sort() });
    }
    partials = next.sort((a, b) => a.providers.length - b.providers.length || a.providers.join().localeCompare(b.providers.join())).slice(0, 256);
  }
  const candidates: Candidate[] = [];
  for (const p of partials) {
    const manifests = p.providers.map((id) => registry.get(id));
    const known = !workload.capabilities.includes("registrar") && manifests.every((m) => m.pricing.monthlyCents !== null && m.pricing.upfrontCents !== null && pricingFresh(m.pricing.reviewedAt));
    const monthlyCents = known ? manifests.reduce((n, m) => n + m.pricing.monthlyCents!, 0) : null;
    const upfrontCents = known ? manifests.reduce((n, m) => n + m.pricing.upfrontCents!, 0) : null;
    if ((monthlyCents !== null && monthlyCents > Math.round(constraints.maxMonthlyBudgetUsd * 100)) || (upfrontCents !== null && upfrontCents > Math.round(constraints.maxUpfrontBudgetUsd * 100))) {
      rejected.push({ provider: p.providers.join(":"), reasons: ["The architecture exceeds the declared budget."] }); continue;
    }
    const prerequisites = manifests.flatMap((m) => registry.missing(m.id).map((key) => `Configure ${key} for ${m.name}.`));
    const catalogOnly = manifests.some((m) => m.tier !== "executable");
    for (const m of manifests) if (m.tier !== "executable") prerequisites.push(`Install a checksum-pinned executable adapter for ${m.name}.`);
    const unverified = manifests.some((m) => m.commercialUse === "unverified" || m.reliability === "unverified");
    const scores = {
      fit: unverified ? 70 : 100,
      reliability: manifests.reduce((n, m) => n + (m.reliability === "production" ? 100 : m.reliability === "development" ? 30 : 50), 0) / manifests.length,
      simplicity: Math.max(0, 100 - (p.providers.length - 1) * 20),
      cost: monthlyCents === null ? 0 : Math.max(0, 100 - monthlyCents / Math.max(1, constraints.maxMonthlyBudgetUsd)),
    };
    candidates.push({ ...p, scores, score: scores.fit * .4 + scores.reliability * .25 + scores.simplicity * .2 + scores.cost * .15,
      monthlyCents, upfrontCents, status: catalogOnly ? "catalog_only" : !known ? "pricing_required" : prerequisites.length ? "setup_required" : "ready",
      prerequisites, reasons: [`Blueprint ${workload.blueprint} covers ${requirements.join(", ")}.`, "Ranked by technical fit (40%), reliability (25%), simplicity (20%) and cost (15%).", ...(unverified ? ["Commercial terms or reliability require verification before execution."] : []), ...(known ? [] : ["Pricing is incomplete or stale; paid execution remains blocked."])], confidence: catalogOnly || !known || workload.truncated ? "low" : workload.questions.length ? "medium" : "high", pricing: manifests.map((m) => m.pricing) });
  }
  candidates.sort((a, b) => b.score - a.score || a.providers.length - b.providers.length || (a.monthlyCents ?? Infinity) - (b.monthlyCents ?? Infinity) || JSON.stringify(a.assignments).localeCompare(JSON.stringify(b.assignments)));
  const recommended = candidates[0] ?? null;
  const dominates = (a: Candidate, b: Candidate) => Object.keys(a.scores).every((k) => a.scores[k as keyof typeof a.scores] >= b.scores[k as keyof typeof b.scores]) && Object.keys(a.scores).some((k) => a.scores[k as keyof typeof a.scores] > b.scores[k as keyof typeof b.scores]);
  return { recommended, alternatives: candidates.slice(1).filter((b) => !candidates.some((a) => dominates(a, b))).slice(0, 12), rejected: rejected.slice(0, 128) };
}

export function composeSteps(plan: Plan, registry: Registry): Step[] {
  if (!plan.recommended) return [];
  const result: Step[] = [];
  const name = path.basename(plan.projectPath).toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 45).replace(/^-+|-+$/g, "") || "application";
  const add = (id: string, provider: string, operation: string, parameters: Record<string, unknown>, dependsOn: string[] = []) => {
    const m = registry.get(provider);
    result.push({ id, provider, operation, parameters, dependsOn, revision: 0, status: m.tier === "executable" ? "draft" : "blocked", adapterChecksum: registry.checksum(provider), adapterVersion: m.version, resources: [], committed: false, retired: false, setupRequirements: [] });
  };
  const assigned = plan.recommended.assignments;
  const domain = plan.overrides.domain;
  if (domain?.purchase && assigned.registrar) add("domain-purchase", assigned.registrar, "register_domain", { domain: domain.name, years: domain.years, ...(domain.profileId ? { profileId: domain.profileId } : {}) });
  if (domain && assigned.dns === "cloudflare") add("dns-zone", "cloudflare", "create_cloudflare_zone", { domain: domain.name }, domain.purchase ? ["domain-purchase"] : []);
  if (plan.recommended.providers.includes("supabase")) {
    const params = plan.overrides.parameters?.supabase ?? {};
    add("database", "supabase", "create_supabase_project", { name, plan: "pro", ...params });
    const publicEnvAliases = Object.fromEntries(plan.workload.envKeys.flatMap((key) => /^(?:(?:NEXT_PUBLIC|VITE|PUBLIC)_)?SUPABASE_URL$/.test(key) ? [[key, "SUPABASE_URL"]] : /^(?:(?:NEXT_PUBLIC|VITE|PUBLIC)_)?SUPABASE_(?:ANON|PUBLISHABLE)_KEY$/.test(key) ? [[key, "SUPABASE_PUBLIC_KEY"]] : []));
    add("database-env", "supabase", "sync_supabase_env", { projectRef: { $resource: "database", kind: "project" }, sourceOperationId: { $operation: "database" }, includeServiceRole: false, ...(Object.keys(publicEnvAliases).length ? { publicEnvAliases } : {}) }, ["database"]);
  }
  for (const provider of plan.recommended.providers) {
    if (["vercel", "supabase"].includes(provider)) continue;
    if (provider === assigned.registrar && domain?.purchase || provider === "cloudflare" && domain) continue;
    if (provider === "github-pages") {
      const params = plan.overrides.parameters?.[provider] ?? {};
      const sha = params.sha ?? plan.workload.sourceRevision;
      add("pages-source", provider, "create_source_ref", { ...params, sha: sha ?? null, branch: `mcp-pages-${plan.id.slice(0, 12)}` });
      add("pages-settings", provider, "configure_pages", { ...params, sha: sha ?? null, branch: `mcp-pages-${plan.id.slice(0, 12)}`, path: params.path ?? "/" }, ["pages-source"]);
      add("pages-deploy", provider, "build_pages", { ...params, sha: sha ?? null, branch: `mcp-pages-${plan.id.slice(0, 12)}` }, ["pages-settings"]);
      continue;
    }
    const manifest = registry.get(provider);
    const operation = manifest.operations.includes("provision") ? "provision" : manifest.operations.find((op) => op === `provision_${plan.workload.blueprint}`) ?? "provision";
    const capabilities = Object.entries(assigned).filter(([, p]) => p === provider).map(([c]) => c);
    add(`provider-${provider}`, provider, operation, { name, blueprint: plan.workload.blueprint, capabilities, runtime: plan.workload.runtime, sourceRevision: plan.workload.sourceRevision ?? null, region: plan.constraints.region ?? null, monthlyRequests: plan.constraints.monthlyRequests ?? null, storageGb: plan.constraints.storageGb ?? null, buildCommand: plan.workload.buildCommand ?? null, startCommand: plan.workload.startCommand ?? null, ports: plan.workload.ports, ...(plan.overrides.parameters?.[provider] ?? {}) });
  }
  if (plan.recommended.providers.includes("vercel")) {
    const params = plan.overrides.parameters?.vercel ?? {};
    add("hosting", "vercel", "create_vercel_project", { name, framework: plan.workload.frameworks.find((f) => ["nextjs", "vite", "astro", "sveltekit", "nuxtjs"].includes(f)) ?? null, ...(typeof params.name === "string" ? { name: params.name } : {}) });
    const keys = [...new Set(plan.workload.envKeys)];
    const dataSteps = result.filter((s) => s.id !== "hosting" && !["domain-purchase", "dns-zone"].includes(s.id)).map((s) => s.id);
    if (keys.length) add("hosting-env", "vercel", "sync_env_to_vercel", { projectId: { $resource: "hosting", kind: "project" }, keys, target: [plan.constraints.environment === "production" ? "production" : "preview"] }, ["hosting", ...dataSteps]);
    add("deploy", "vercel", "deploy_vercel", { projectId: { $resource: "hosting", kind: "project" }, name: params.name ?? name, target: plan.constraints.environment === "production" ? "production" : "preview", source: params.source ?? { type: "local" } }, [keys.length ? "hosting-env" : "hosting", ...dataSteps]);
    if (domain && assigned.dns === "cloudflare") {
      add("domain-connect", "vercel", "connect_vercel_domain", { projectId: { $resource: "hosting", kind: "project" }, domain: domain.name }, ["deploy", "dns-zone"]);
      add("domain-dns", "cloudflare", "configure_vercel_dns", { projectId: { $resource: "hosting", kind: "project" }, zoneId: { $resource: "dns-zone", kind: "zone" }, domain: domain.name }, ["domain-connect"]);
      add("domain-verify", "vercel", "verify_vercel_domain", { projectId: { $resource: "hosting", kind: "project" }, domain: domain.name }, ["domain-dns"]);
    }
  }
  return result;
}

export function newPlan(projectPath: string, workload: Workload, constraints: Constraints, overrides: Overrides, registry: Registry): Plan {
  if (overrides.domain?.registrar) overrides = { ...overrides, providers: { ...overrides.providers, registrar: overrides.domain.registrar } };
  if (workload.capabilities.length > 16) throw new AppError("UNSUPPORTED_REQUIREMENTS", "Split this workload into smaller architectures with at most sixteen capabilities.");
  const plan: Plan = { version: 2, id: randomUUID(), revision: 0, projectPath, createdAt: new Date().toISOString(), intent: "deploy", workload, constraints, overrides, ...rankCandidates(workload, constraints, overrides, registry), steps: [], verification: { status: "not_checked", checks: [] }, events: [{ at: new Date().toISOString(), event: "proposed" }] };
  plan.steps = composeSteps(plan, registry);
  return plan;
}
