import { AppError } from "./errors.js";
import { usdToCents } from "./utils/budget.js";

export const PRICING_REVIEWED_AT = "2026-10-10";

const PRICING_STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const BASELINE_SCOPE = "baseline_subscription_estimate";
const ESTIMATE_WARNING =
  "Excludes usage overages, taxes, add-ons and existing unrelated account spend. This is not a billing cap.";

export const PLAN_CATALOG = [
  {
    id: "vercel-hobby",
    provider: "vercel",
    monthlyCents: 0,
    commercial: false,
    requirements: ["hosting", "static-hosting", "serverless-functions"],
    credentials: ["VERCEL_TOKEN", "VERCEL_TEAM_ID"],
    pros: ["Managed builds, HTTPS and preview deployments", "No subscription fee"],
    cons: ["Personal non-commercial use only", "Free quotas and platform restrictions apply"],
    source: "https://vercel.com/pricing",
  },
  {
    id: "vercel-pro",
    provider: "vercel",
    monthlyCents: 2000,
    commercial: true,
    requirements: ["hosting", "static-hosting", "serverless-functions"],
    credentials: ["VERCEL_TOKEN", "VERCEL_TEAM_ID"],
    pros: ["Commercial use permitted", "Managed builds and deployments"],
    cons: [
      "Baseline assumes one paid developer seat",
      "Usage, extra seats, taxes and add-ons can increase the bill",
      "Spend Management is not an absolute cap",
    ],
    source: "https://vercel.com/pricing",
  },
  {
    id: "supabase-free",
    provider: "supabase",
    monthlyCents: 0,
    commercial: true,
    requirements: ["sql", "auth", "storage"],
    credentials: ["SUPABASE_ACCESS_TOKEN"],
    pros: ["Postgres, authentication and storage in one service", "No subscription fee"],
    cons: [
      "Two active free projects limit",
      "Free projects may pause after one week of inactivity",
      "No automatic production backups on Free",
    ],
    source: "https://supabase.com/pricing",
  },
  {
    id: "supabase-pro",
    provider: "supabase",
    monthlyCents: 2500,
    commercial: true,
    requirements: ["sql", "auth", "storage"],
    credentials: ["SUPABASE_ACCESS_TOKEN"],
    pros: ["Projects do not pause for inactivity", "Daily backups"],
    cons: [
      "Baseline assumes one Micro project and available included compute credit",
      "Additional Micro projects add $10/month each",
      "Usage, taxes and add-ons can increase the bill; spend cap is partial",
    ],
    source: "https://supabase.com/pricing",
  },
  {
    id: "cloudflare-dns",
    provider: "cloudflare",
    monthlyCents: 0,
    commercial: true,
    requirements: ["dns"],
    credentials: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"],
    pros: ["DNS management and zone setup"],
    cons: [
      "Domain registration and renewal are separate costs",
      "Registrar changes may require manual nameserver updates",
    ],
    source: "https://developers.cloudflare.com/dns/",
  },
] as const;

export type PlanCandidate = (typeof PLAN_CATALOG)[number];

const REQUIREMENT_ALIASES: Record<string, string> = {
  postgres: "sql",
  postgresql: "sql",
  database: "sql",
  "sql-db": "sql",
  hosting: "hosting",
  "web-hosting": "hosting",
  static: "static-hosting",
  "static hosting": "static-hosting",
  serverless: "serverless-functions",
  functions: "serverless-functions",
  authentication: "auth",
  "object-storage": "storage",
  domain: "domain-registration",
  domains: "domain-registration",
  dns: "dns",
};

const HOSTING_FAMILY = new Set(["hosting", "static-hosting", "serverless-functions"]);
const DATABASE_FAMILY = new Set(["sql", "auth", "storage"]);
const DOMAIN_REGISTRATION = "domain-registration";

export interface PlanComponentView {
  id: string;
  provider: string;
  estimatedMonthlyCostUsd: number;
  estimatedUpfrontCostUsd: number;
  scope: string;
  requirements: string[];
  credentials: string[];
  pros: string[];
  cons: string[];
  source: string;
}

export interface UnmetRequirement {
  requirement: string;
  reason: string;
}

export interface PlanCombinationView {
  components: PlanComponentView[];
  estimatedMonthlyCostUsd: number;
  estimatedUpfrontCostUsd: number | null;
  coveredRequirements: string[];
  unmetRequirements: UnmetRequirement[];
  withinBudget: boolean;
  commercialUseOk: boolean;
  viable: boolean;
}

export interface InfraPlanInput {
  stackRequirements: string[];
  maxMonthlyBudgetUsd: number;
  commercialUse: boolean;
  preferProductionReliability: boolean;
}

export interface InfraPlanResult {
  budgetPolicy: "approved_estimates";
  currency: "USD";
  maxMonthlyBudgetUsd: number;
  pricingReviewedAt: string;
  pricingStale: boolean;
  estimatesAreHardCaps: false;
  recommended: PlanCombinationView | null;
  alternatives: PlanCombinationView[];
  unmetRequirements: UnmetRequirement[];
  warnings: string[];
}

function normalizeRequirement(raw: string): string {
  const key = raw.trim().toLowerCase();
  return Object.hasOwn(REQUIREMENT_ALIASES, key) ? (REQUIREMENT_ALIASES[key] as string) : key;
}

function componentView(candidate: PlanCandidate): PlanComponentView {
  return {
    id: candidate.id,
    provider: candidate.provider,
    estimatedMonthlyCostUsd: candidate.monthlyCents / 100,
    estimatedUpfrontCostUsd: 0,
    scope: BASELINE_SCOPE,
    requirements: [...candidate.requirements],
    credentials: [...candidate.credentials],
    pros: [...candidate.pros],
    cons: [...candidate.cons],
    source: candidate.source,
  };
}

export function proposeInfraPlan(input: InfraPlanInput, now: Date = new Date()): InfraPlanResult {
  const budgetCents = usdToCents(input.maxMonthlyBudgetUsd);
  const needed = new Set<string>();
  for (const raw of input.stackRequirements) {
    needed.add(normalizeRequirement(raw));
  }

  const hostingNeeded = [...HOSTING_FAMILY].some((req) => needed.has(req));
  const databaseNeeded = [...DATABASE_FAMILY].some((req) => needed.has(req));
  const dnsNeeded = needed.has("dns");
  const domainRequested = needed.has(DOMAIN_REGISTRATION);

  const hostingOptions = hostingNeeded
    ? PLAN_CATALOG.filter((candidate) => candidate.provider === "vercel")
    : [];
  const databaseOptions = databaseNeeded
    ? PLAN_CATALOG.filter((candidate) => candidate.provider === "supabase")
    : [];
  const dnsOptions = dnsNeeded ? PLAN_CATALOG.filter((candidate) => candidate.provider === "cloudflare") : [];

  const groups: readonly (readonly PlanCandidate[])[] = [hostingOptions, databaseOptions, dnsOptions].filter(
    (group) => group.length > 0,
  );

  const combinations: PlanCandidate[][] = [[]];
  for (const group of groups) {
    const base = combinations.splice(0, combinations.length);
    for (const combo of base) {
      for (const candidate of group) {
        combinations.push([...combo, candidate]);
      }
    }
  }

  const views: PlanCombinationView[] = combinations.map((combo) => {
    const covered = new Set<string>();
    for (const candidate of combo) {
      for (const req of candidate.requirements) {
        if (needed.has(req)) covered.add(req);
      }
    }
    const unmet: UnmetRequirement[] = [];
    for (const req of needed) {
      if (covered.has(req)) continue;
      unmet.push({
        requirement: req,
        reason:
          req === DOMAIN_REGISTRATION
            ? "Requires live registrar quote and a separate upfront budget"
            : "No supported provider plan covers this requirement",
      });
    }
    unmet.sort((a, b) => a.requirement.localeCompare(b.requirement));
    const totalCents = combo.reduce((sum, candidate) => sum + candidate.monthlyCents, 0);
    const withinBudget = totalCents <= budgetCents;
    const commercialUseOk = !input.commercialUse || combo.every((candidate) => candidate.commercial);
    return {
      components: combo.map(componentView),
      estimatedMonthlyCostUsd: totalCents / 100,
      estimatedUpfrontCostUsd: domainRequested ? null : 0,
      coveredRequirements: [...covered].sort(),
      unmetRequirements: unmet,
      withinBudget,
      commercialUseOk,
      viable: unmet.length === 0 && withinBudget && commercialUseOk,
    };
  });

  const pricingStale =
    now.getTime() - Date.parse(`${PRICING_REVIEWED_AT}T00:00:00Z`) > PRICING_STALE_AFTER_MS;

  const viable = views.filter((view) => view.viable);
  let recommended: PlanCombinationView | null = null;
  if (!pricingStale && viable.length > 0) {
    let pool = viable;
    if (input.preferProductionReliability) {
      const reliable = viable.filter((view) =>
        view.components.some((component) => component.id === "supabase-pro"),
      );
      if (reliable.length > 0) pool = reliable;
    }
    recommended = pool.reduce((best, view) =>
      view.estimatedMonthlyCostUsd < best.estimatedMonthlyCostUsd ? view : best,
    );
  }

  const unmetUnion = new Map<string, UnmetRequirement>();
  for (const view of views) {
    for (const unmet of view.unmetRequirements) {
      unmetUnion.set(unmet.requirement, unmet);
    }
  }

  const warnings = [ESTIMATE_WARNING];
  if (pricingStale) {
    warnings.push("Pricing information is stale and must be reviewed before any recommendation can be made.");
  }

  return {
    budgetPolicy: "approved_estimates",
    currency: "USD",
    maxMonthlyBudgetUsd: input.maxMonthlyBudgetUsd,
    pricingReviewedAt: PRICING_REVIEWED_AT,
    pricingStale,
    estimatesAreHardCaps: false,
    recommended,
    alternatives: views.filter((view) => view !== recommended),
    unmetRequirements: [...unmetUnion.values()].sort((a, b) => a.requirement.localeCompare(b.requirement)),
    warnings,
  };
}
