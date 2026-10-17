import { createHash } from "node:crypto";
import { z } from "zod";

export const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/);
export const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const blueprintSchema = z.enum(["static_site", "edge_application", "serverless_api", "web_service", "container_service", "background_worker", "scheduled_job", "full_stack_web"]);
export const capabilitySchema = z.enum(["static", "edge", "serverless", "server", "container", "worker", "cron", "websocket", "disk", "postgres", "mysql", "sqlite", "document-db", "redis", "storage", "auth", "dns", "registrar", "network"]);
const cents = z.number().int().nonnegative().safe();
export const pricingSchema = z.object({
  monthlyCents: cents.nullable(), upfrontCents: cents.nullable(),
  reviewedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  source: z.string().url(), assumptions: z.array(z.string().max(1000)).max(32),
}).strict();
export const manifestSchema = z.object({
  protocolVersion: z.literal(2), id: identifier, version: z.string().regex(/^\d+\.\d+\.\d+$/),
  name: z.string().min(1).max(100), tier: z.enum(["executable", "catalog", "advisory"]),
  capabilities: z.array(capabilitySchema).min(1).max(32),
  runtimes: z.array(z.string().max(50)).max(32), frameworks: z.array(z.string().max(50)).max(32),
  regions: z.array(z.string().max(80)).max(256), compliance: z.array(z.string().max(100)).max(32),
  commercialUse: z.enum(["allowed", "restricted", "unverified"]),
  reliability: z.enum(["production", "development", "unverified"]),
  credentials: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).max(32),
  accountSettings: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).max(16),
  operations: z.array(identifier).max(64), teardown: z.boolean(),
  reconciliation: z.enum(["identity", "idempotency", "manual"]),
  artifactAccess: z.boolean().default(false),
  pricing: pricingSchema, documentation: z.array(z.string().url()).min(1).max(16),
  limits: z.array(z.string().max(1000)).max(32),
  latencyMs: z.number().positive().optional(),
  maxMonthlyRequests: cents.optional(), maxStorageGb: z.number().nonnegative().finite().optional(),
  buildMode: z.enum(["prebuilt", "remote"]).optional(),
  teardownKinds: z.array(identifier).max(32).optional(),
  forbiddenCapabilities: z.array(capabilitySchema).max(32).optional(),
}).strict();
export type Manifest = z.infer<typeof manifestSchema>;
export type Capability = z.infer<typeof capabilitySchema>;
export type Blueprint = z.infer<typeof blueprintSchema>;

export const constraintsSchema = z.object({
  maxMonthlyBudgetUsd: z.number().finite().nonnegative().max(1e9),
  maxUpfrontBudgetUsd: z.number().finite().nonnegative().max(1e9).default(0),
  commercialUse: z.boolean().default(true), reliability: z.enum(["production", "development"]).default("production"),
  region: z.string().max(80).optional(), compliance: z.array(z.string().max(100)).max(16).default([]),
  latencyMs: z.number().positive().max(1e6).optional(),
  monthlyRequests: z.number().int().nonnegative().safe().optional(), storageGb: z.number().nonnegative().finite().optional(),
  environment: z.enum(["development", "preview", "production"]).default("production"),
}).strict();
export type Constraints = z.infer<typeof constraintsSchema>;
export const workloadSchema = z.object({
  blueprint: blueprintSchema, capabilities: z.array(capabilitySchema), frameworks: z.array(z.string()),
  runtime: z.string(), ports: z.array(z.number().int().min(1).max(65535)),
  buildCommand: z.string().max(2000).optional(), startCommand: z.string().max(2000).optional(),
  sourceRevision: z.string().regex(/^[a-f0-9]{40}$/).optional(),
  sourceDigest: hashSchema.optional(),
  envKeys: z.array(z.string()), privilegedEnvKeys: z.array(z.string()),
  evidence: z.array(z.object({ requirement: z.string(), file: z.string(), signal: z.string() })),
  questions: z.array(z.string()), truncated: z.boolean(),
}).strict();
export type Workload = z.infer<typeof workloadSchema>;
// Public options contain identifiers/configuration, never credential values.
export const publicValue: z.ZodType<unknown> = z.lazy(() => z.union([
  z.string().max(4000), z.number().finite(), z.boolean(), z.null(),
  z.array(publicValue).max(128), z.record(z.string().max(128), publicValue),
]));
export const optionsSchema = z.record(identifier, publicValue);
const journalValue: z.ZodType<unknown> = z.lazy(() => z.union([
  z.string().max(8192), z.number().finite(), z.boolean(), z.null(),
  z.array(journalValue).max(8192), z.record(z.string().max(256), journalValue),
]));
export const overridesSchema = z.object({
  blueprint: blueprintSchema.optional(), runtime: z.string().max(50).optional(),
  capabilities: z.array(capabilitySchema).max(32).optional(),
  providers: z.record(capabilitySchema, identifier).optional(),
  parameters: z.record(identifier, optionsSchema).optional(),
  sourceRevision: z.string().regex(/^[a-f0-9]{40}$/).optional(),
  domain: z.object({ name: z.string().toLowerCase().regex(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/), purchase: z.boolean().default(false), years: z.number().int().min(1).max(10).default(1), registrar: identifier.optional(), profileId: identifier.optional() }).strict().optional(),
}).strict();
export type Overrides = z.infer<typeof overridesSchema>;
export const quoteSchema = z.object({
  registrar: identifier, domain: z.string().min(1).max(253), years: z.number().int().min(1).max(10),
  available: z.boolean(), eligible: z.boolean(), currency: z.literal("USD"),
  registrationCents: cents.nullable(), renewalCents: cents.nullable(), premiumCents: cents.nullable(), privacyCents: cents.nullable(),
  tax: z.enum(["included", "excluded", "unknown"]), autoRenew: z.boolean(),
  priceEnforced: z.boolean(), idempotency: z.boolean(),
  requirements: z.array(z.string().max(1000)).max(32), quotedAt: z.string().datetime(),
}).strict();
export type DomainQuote = z.infer<typeof quoteSchema>;
export const resourceSchema = z.object({
  id: identifier, provider: identifier, kind: identifier, account: z.string().min(1).max(256),
  url: z.string().url().optional(), region: z.string().optional(),
}).strict();
export type Resource = z.infer<typeof resourceSchema>;
export const estimateSchema = z.object({
  recurring: z.array(z.object({ key: z.string().min(1).max(256), cents }).strict()).max(64),
  upfrontCents: cents, reviewedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  source: z.string().url(), assumptions: z.array(z.string()).max(32),
}).strict();
export const preparedSchema = z.object({
  account: z.string().min(1).max(256), region: z.string().optional(),
  mutations: z.array(z.object({ action: z.enum(["create", "update", "delete", "purchase", "deploy", "write"]), target: z.string().min(1).max(1000), details: z.string().max(4000) }).strict()).min(1).max(256),
  estimate: estimateSchema, preconditions: z.record(identifier, journalValue), expiresAt: z.string().datetime(),
  quote: quoteSchema.optional(),
}).strict();
export type Prepared = z.infer<typeof preparedSchema>;
export const outcomeSchema = z.object({
  status: z.enum(["succeeded", "pending", "failed", "unknown"]), resources: z.array(resourceSchema).max(64),
}).strict();
export type Outcome = z.infer<typeof outcomeSchema>;
export const stepSchema = z.object({
  id: identifier, provider: identifier, operation: identifier, parameters: optionsSchema,
  dependsOn: z.array(identifier).max(64), revision: z.number().int().nonnegative(),
  status: z.enum(["draft", "blocked", "prepared", "approving", "running", "pending", "succeeded", "failed", "unknown", "cancelled"]),
  adapterChecksum: hashSchema, adapterVersion: z.string(), prepared: preparedSchema.optional(), digest: hashSchema.optional(),
  legacyOperationId: z.string().uuid().optional(),
  lease: z.object({ nonce: z.string().uuid(), pid: z.number().int(), hostname: z.string(), until: z.string().datetime() }).optional(),
  resources: z.array(resourceSchema), error: z.string().max(128).optional(),
  setupRequirements: z.array(z.string().max(2000)).max(32).default([]),
  committed: z.boolean(), retired: z.boolean().default(false),
}).strict();
export type Step = z.infer<typeof stepSchema>;
export const candidateSchema = z.object({
  providers: z.array(identifier), assignments: z.record(capabilitySchema, identifier),
  score: z.number(), scores: z.object({ fit: z.number(), reliability: z.number(), simplicity: z.number(), cost: z.number() }),
  monthlyCents: cents.nullable(), upfrontCents: cents.nullable(),
  status: z.enum(["ready", "setup_required", "catalog_only", "pricing_required"]),
  prerequisites: z.array(z.string()), reasons: z.array(z.string()), confidence: z.enum(["low", "medium", "high"]),
  pricing: z.array(pricingSchema),
}).strict();
export type Candidate = z.infer<typeof candidateSchema>;
export const planSchema = z.object({
  version: z.literal(2), id: z.string().uuid(), revision: z.number().int().nonnegative(),
  projectPath: z.string(), createdAt: z.string().datetime(), intent: z.enum(["deploy", "teardown", "legacy"]),
  workload: workloadSchema, constraints: constraintsSchema, overrides: overridesSchema,
  recommended: candidateSchema.nullable(), alternatives: z.array(candidateSchema),
  rejected: z.array(z.object({ provider: identifier, reasons: z.array(z.string()) })),
  steps: z.array(stepSchema).max(128),
  verification: z.object({ status: z.enum(["not_checked", "incomplete", "verified"]), checkedAt: z.string().datetime().optional(), checks: z.array(z.object({ kind: z.string(), status: z.enum(["passed", "failed", "unverified"]), detail: z.string() })) }),
  events: z.array(z.object({ at: z.string().datetime(), event: z.string().max(128) })).max(512),
  sourcePlanId: z.string().uuid().optional(),
}).strict();
export type Plan = z.infer<typeof planSchema>;

export function digest(value: unknown): string {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : v && typeof v === "object"
    ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canonical(x)])) : v;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
export function approvalDigest(step: Step): string {
  // Freshness timestamps may change on a read-only re-quote; commercial terms may not.
  const prepared = step.prepared;
  return digest({ provider: step.provider, operation: step.operation, parameters: step.parameters,
    adapterChecksum: step.adapterChecksum, adapterVersion: step.adapterVersion,
    prepared: prepared && { ...prepared, expiresAt: undefined, quote: prepared.quote && { ...prepared.quote, quotedAt: undefined } } });
}
export function pricingFresh(reviewedAt: string | null, now = Date.now()): boolean {
  if (!reviewedAt) return false;
  const timestamp = Date.parse(`${reviewedAt}T00:00:00Z`);
  return Number.isFinite(timestamp) && timestamp <= now && now - timestamp <= 30 * 86400000;
}
