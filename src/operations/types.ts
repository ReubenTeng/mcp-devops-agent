import { isAbsolute } from "node:path";
import { z } from "zod";
import { monthlyBudgetSchema, projectPathSchema } from "../types/index.js";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const name = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
export const domainSchema = z
  .string()
  .toLowerCase()
  .regex(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/);
const envKey = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
  .refine((key) => !["__proto__", "constructor", "prototype"].includes(key));

export const actionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("create_vercel_project"),
      name,
      framework: z.enum(["nextjs", "vite", "astro", "sveltekit", "nuxtjs"]).nullable().default(null),
    })
    .strict(),
  z
    .object({
      kind: z.literal("create_supabase_project"),
      name,
      organizationSlug: id,
      region: z.string().regex(/^[a-z0-9-]{2,40}$/),
      plan: z.enum(["free", "pro"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("deploy_vercel"),
      projectId: id,
      name,
      target: z.enum(["preview", "production"]).default("preview"),
      source: z.discriminatedUnion("type", [
        z.object({ type: z.literal("local") }).strict(),
        z
          .object({ type: z.literal("github"), org: id, repo: id, sha: z.string().regex(/^[a-f0-9]{40}$/) })
          .strict(),
      ]),
    })
    .strict(),
  z
    .object({ kind: z.literal("register_domain"), domain: domainSchema, years: z.number().int().min(1).max(10).default(1) })
    .strict(),
  z.object({ kind: z.literal("create_cloudflare_zone"), domain: domainSchema }).strict(),
  z
    .object({
      kind: z.literal("upsert_dns_record"),
      zoneId: id,
      type: z.enum(["A", "AAAA", "CNAME", "TXT"]),
      name: z.string().min(1).max(253),
      content: z.string().min(1).max(2048),
      ttl: z.number().int().min(1).max(86400).default(1),
      proxied: z.boolean().default(false),
      recordId: id.optional(),
      vercelSource: z.object({ projectId: id, domain: domainSchema }).strict().optional(),
    })
    .strict(),
  z
    .object({ kind: z.literal("connect_vercel_domain"), projectId: id, domain: domainSchema })
    .strict(),
  z
    .object({ kind: z.literal("verify_vercel_domain"), projectId: id, domain: domainSchema })
    .strict(),
  z
    .object({
      kind: z.literal("sync_env_to_vercel"),
      projectId: id,
      keys: z.array(envKey).min(1).max(100),
      target: z.array(z.enum(["production", "preview", "development"])).min(1).max(3),
    })
    .strict(),
  z
    .object({
      kind: z.literal("sync_supabase_env"),
      projectRef: z.string().regex(/^[a-z0-9]{20}$/),
      includeServiceRole: z.boolean().default(false),
      sourceOperationId: z.string().uuid().optional(),
      publicEnvAliases: z.record(envKey, z.enum(["SUPABASE_URL", "SUPABASE_PUBLIC_KEY"])).optional(),
    })
    .strict(),
  z
    .object({ kind: z.literal("rollback_vercel"), projectId: id, deploymentId: id })
    .strict(),
]);

export type Action = z.infer<typeof actionSchema>;

export const prepareOperationInput = {
  projectPath: projectPathSchema,
  action: actionSchema,
  maxMonthlyBudgetUsd: monthlyBudgetSchema,
  maxUpfrontBudgetUsd: monthlyBudgetSchema.default(0),
  estimatedMonthlyUsageUsd: monthlyBudgetSchema.default(0),
  commercialUse: z.boolean().default(true),
};

const statusSchema = z.enum(["prepared", "running", "pending", "succeeded", "failed", "unknown", "cancelled"]);

const centsSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const usdSchema = z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER);
const timestampSchema = z.string().datetime();

const estimateSchema = z
  .object({
    currency: z.literal("USD"),
    recurringItems: z
      .array(z.object({ key: z.string().min(1).max(256), cents: centsSchema }).strict())
      .max(64),
    upfrontCents: centsSchema,
    estimatedMonthlyCostUsd: usdSchema,
    estimatedUpfrontCostUsd: usdSchema,
    scope: z.literal("managed_project_baseline"),
    hardCap: z.literal(false),
    warnings: z.array(z.string().max(2000)).max(64),
  })
  .strict();

const safeValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string().max(8192),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(safeValue).max(8192),
    z.record(z.string().max(256), safeValue),
  ]),
);

const deploymentFileSchema = z
  .object({
    file: z.string().min(1).max(1024),
    sha: z.string().regex(/^[a-f0-9]{40}$/),
    size: z.number().int().min(0).max(20 * 1024 * 1024),
  })
  .strict();

const manifestSchema = z
  .object({
    files: z.array(deploymentFileSchema).max(5000),
    totalBytes: z.number().int().min(0).max(50 * 1024 * 1024),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

const dnsRecordStateSchema = z
  .object({
    id: z.string().max(128).optional(),
    type: z.enum(["A", "AAAA", "CNAME", "TXT"]),
    name: z.string().min(1).max(253),
    content: z.string().min(1).max(2048),
    ttl: z.number().int().min(1).max(86400).optional(),
    proxied: z.boolean().optional(),
  })
  .strict();

const preconditionShape = z.record(z.string().max(64), safeValue.optional());

function preconditionIssues(action: Action, preconditions: Record<string, unknown>): string[] {
  const issues: string[] = [];
  switch (action.kind) {
    case "deploy_vercel": {
      if (action.source.type === "local") {
        const parsed = manifestSchema.safeParse(preconditions.manifest);
        if (!parsed.success) issues.push("manifest");
      }
      break;
    }
    case "register_domain": {
      const parsed = z
        .object({
          domain: z.string().min(1),
          years: z.number().int().min(1).max(10),
          registrationCost: z.string().regex(/^\d{1,9}(\.\d{1,2})?$/),
          renewalCost: z.string().regex(/^\d{1,9}(\.\d{1,2})?$/),
        })
        .strict()
        .safeParse(preconditions);
      if (!parsed.success) issues.push("quote");
      break;
    }
    case "upsert_dns_record": {
      const parsed = z
        .object({
          zoneId: z.string().min(1),
          zoneName: z.string().min(1),
          desired: dnsRecordStateSchema,
          original: dnsRecordStateSchema.optional(),
        })
        .strip()
        .safeParse(preconditions);
      if (!parsed.success) issues.push("dns");
      break;
    }
    default:
      break;
  }
  return issues;
}

export const operationSchema = z
  .object({
    version: z.literal(1),
    id: z.string().uuid(),
    projectPath: z.string().min(1).max(4096).refine((value) => isAbsolute(value)),
    action: actionSchema,
    account: z
      .object({
        provider: z.enum(["vercel", "supabase", "cloudflare"]),
        id: z.string().min(1).max(256),
        plan: z.string().max(64).optional(),
      })
      .strict(),
    createdAt: timestampSchema,
    expiresAt: timestampSchema,
    status: statusSchema,
    costCommitted: z.boolean(),
    executionLease: z.object({ nonce: z.string().uuid(), pid: z.number().int().positive(), hostname: z.string(), expiresAt: timestampSchema }).strict().optional(),
    maxMonthlyBudgetUsd: usdSchema,
    maxUpfrontBudgetUsd: usdSchema,
    estimatedMonthlyUsageUsd: usdSchema,
    commercialUse: z.boolean(),
    estimate: estimateSchema,
    preconditions: preconditionShape,
    result: preconditionShape.optional(),
    error: z.object({ code: z.string().max(128), message: z.string().max(2000) }).strict().optional(),
    events: z.array(z.object({ at: timestampSchema, event: z.string().max(128) }).strict()).max(512),
  })
  .strict()
  .superRefine((op, ctx) => {
    for (const issue of preconditionIssues(op.action as Action, op.preconditions)) {
      ctx.addIssue({ code: "custom", message: `invalid preconditions:${issue}` });
    }
  });

export type Status = z.infer<typeof statusSchema>;
export type RecurringItem = z.infer<typeof estimateSchema>["recurringItems"][number];
export type CostEstimate = z.infer<typeof estimateSchema>;
export type Operation = z.infer<typeof operationSchema>;
