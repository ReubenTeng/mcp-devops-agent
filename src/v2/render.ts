import { z } from "zod";
import type { AppConfig } from "../config.js";
import { AppError } from "../errors.js";
import { RENDER_PRICING } from "../planning.js";
import { renderMonthlyCents } from "../operations/service.js";
import { ProviderError, ProviderHttp } from "../providers/http.js";
import { credentialsFor, type Adapter, type AdapterRequest } from "./adapter.js";
import { digest, manifestSchema, pricingFresh, type Outcome, type Prepared, type Resource } from "./schema.js";

export const renderManifest = manifestSchema.parse({
  protocolVersion: 2, id: "render", name: "Render", version: "2.1.0", tier: "executable",
  capabilities: ["server", "container", "disk"], runtimes: ["node", "docker"], frameworks: [],
  regions: ["frankfurt", "oregon", "ohio", "singapore", "virginia"], compliance: [],
  commercialUse: "allowed", reliability: "production", credentials: ["RENDER_API_KEY", "RENDER_MCP_HTTP_TOKEN"], accountSettings: ["RENDER_OWNER_ID"],
  operations: ["provision"], teardown: false, reconciliation: "identity", artifactAccess: false, buildMode: "remote", maxStorageGb: 20,
  pricing: { monthlyCents: renderMonthlyCents("starter", 1), upfrontCents: 0, reviewedAt: RENDER_PRICING.reviewedAt, source: RENDER_PRICING.source, assumptions: [...RENDER_PRICING.assumptions, "Planner baseline: starter with 1 GB disk. Preparation uses the selected plan and disk size."] },
  documentation: ["https://api-docs.render.com/reference/create-service", "https://api-docs.render.com/reference/retrieve-service", "https://render.com/docs/deploying-an-image", "https://render.com/docs/disks", RENDER_PRICING.source],
  limits: [
    "Reviewed template: one remote mcp-devops-agent service from a public GHCR image pinned by SHA-256, with /healthz and a persistent disk at /var/data.",
    "Build and publish the image separately. No source upload, mutable tag, private registry credential, Git build, automatic update or automatic mutation retry.",
    "Provider credentials for the hosted server and project source access require private setup. The HTTP token is transferred from RENDER_MCP_HTTP_TOKEN and never returned.",
    "Deletion is manual. A failed initial deploy can leave a paid service and disk. Reconcile before any new provisioning attempt.",
  ],
});

const serviceId = z.string().regex(/^srv-[a-z0-9]{1,64}$/);
const diskId = z.string().regex(/^dsk-[a-z0-9]{1,64}$/);
const deployId = z.string().regex(/^dep-[a-z0-9]{1,64}$/);
const imageSchema = z.string().regex(/^ghcr\.io\/[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)+@sha256:[a-f0-9]{64}$/).max(500);
const parametersSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]{0,44}$/),
  image: imageSchema,
  region: z.enum(["frankfurt", "oregon", "ohio", "singapore", "virginia"]),
  plan: z.enum(["starter", "standard"]).default("starter"),
  diskGb: z.number().int().min(1).max(20).default(1),
}).strip();
const diskSchema = z.object({ id: diskId, name: z.string(), sizeGB: z.number().int(), mountPath: z.string() });
const serviceSchema = z.object({
  id: serviceId, ownerId: z.string(), name: z.string(), type: z.string(), imagePath: z.string(),
  autoDeploy: z.string().optional(), autoDeployTrigger: z.string().optional(),
  serviceDetails: z.object({
    runtime: z.string(), plan: z.string(), region: z.string(), numInstances: z.number().int(),
    healthCheckPath: z.string(), url: z.string(), disk: diskSchema,
    envSpecificDetails: z.object({ dockerCommand: z.string() }),
  }),
});
type Service = z.infer<typeof serviceSchema>;
const deploySchema = z.object({ id: deployId, status: z.string(), image: z.object({ ref: z.string(), sha: z.string() }).optional() });
function parse<T>(schema: z.ZodType<T>, value: unknown, ambiguous = false): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ProviderError("PROVIDER_RESPONSE_INVALID", "Render returned an invalid response.", undefined, ambiguous);
  return result.data;
}
function safeUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && /^[a-z0-9-]+\.onrender\.com$/.test(url.hostname) && !url.port && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/") return url.origin;
  } catch {}
  return undefined;
}

export function renderAdapter(config: AppConfig, checksum: string, fetchImpl: typeof fetch = fetch): Adapter {
  return {
    manifest: renderManifest, checksum, validate: async () => {},
    async invoke(request: AdapterRequest, signal?: AbortSignal): Promise<unknown> {
      if (request.operation !== "provision" || !["prepare", "execute", "reconcile", "verify"].includes(request.method)) {
        throw new AppError("UNSUPPORTED_OPERATION", "The Render adapter supports service provisioning, status recovery and verification only.");
      }
      const parsed = parametersSchema.safeParse(request.parameters);
      if (!parsed.success) throw new AppError("SETUP_REQUIRED", "Render requires a service name, public ghcr.io image pinned by SHA-256, and region. Optional plan: starter or standard; diskGb: 1 to 20.");
      const p = parsed.data;
      const env = credentialsFor(config);
      const owner = env.RENDER_OWNER_ID;
      if (!owner || !/^tea-[a-z0-9]{1,64}$/.test(owner)) throw new AppError("SETUP_REQUIRED", "Configure RENDER_OWNER_ID with an existing tea- workspace ID.");
      const httpToken = env.RENDER_MCP_HTTP_TOKEN ?? "";
      if (!/^[A-Za-z0-9_-]{43,256}$/.test(httpToken)) throw new AppError("SETUP_REQUIRED", "Configure RENDER_MCP_HTTP_TOKEN privately with at least 32 random bytes encoded as base64url.");
      const http = new ProviderHttp("https://api.render.com", env.RENDER_API_KEY, fetchImpl, undefined, signal);
      const get = (path: string, query?: Record<string, string>) => http.request("GET", path, { query });
      const optional = async (path: string) => {
        try { return await get(path); }
        catch (error) { if (error instanceof ProviderError && error.status === 404) return undefined; throw error; }
      };
      const account = parse(z.object({ id: z.string() }), await get(`/v1/owners/${owner}`));
      if (account.id !== owner) throw new AppError("ACCOUNT_MISMATCH", "Render did not confirm the configured workspace.");
      const suffix = digest(request.operationId).slice(0, 12);
      const name = `${p.name}-${suffix}`;
      const diskName = `state-${suffix}`;
      const plan = RENDER_PRICING.plans[p.plan].apiPlan;
      const matches = (s: Service) => s.ownerId === owner && s.name === name && s.type === "web_service" && s.imagePath === p.image &&
        s.serviceDetails.runtime === "image" && (s.serviceDetails.plan === plan || s.serviceDetails.plan === p.plan) && s.serviceDetails.region === p.region &&
        s.serviceDetails.numInstances === 1 && s.serviceDetails.healthCheckPath === "/healthz" &&
        s.serviceDetails.envSpecificDetails.dockerCommand === "node dist/index.js serve-http" &&
        (s.autoDeployTrigger === "off" || (s.autoDeployTrigger === undefined && s.autoDeploy === "no")) &&
        s.serviceDetails.disk.name === diskName && s.serviceDetails.disk.sizeGB === p.diskGb && s.serviceDetails.disk.mountPath === "/var/data";
      async function find(): Promise<Service | undefined> {
        const recorded = request.resources?.filter((r) => r.kind === "service");
        if (recorded?.length) {
          if (recorded.length !== 1 || recorded[0]!.provider !== "render" || recorded[0]!.account !== owner || !serviceId.safeParse(recorded[0]!.id).success) throw new AppError("INVALID_RESOURCE", "The recorded Render service identity is invalid.");
          const raw = await optional(`/v1/services/${recorded[0]!.id}`);
          if (raw === undefined) return undefined;
          const service = parse(serviceSchema, raw);
          if (service.id !== recorded[0]!.id || service.ownerId !== owner) throw new AppError("ACCOUNT_MISMATCH", "The recorded Render service no longer matches its account and identity.");
          const disks = request.resources?.filter((r) => r.kind === "disk") ?? [];
          if (disks.length !== 1 || disks[0]!.id !== service.serviceDetails.disk.id || disks[0]!.account !== owner || disks[0]!.provider !== "render") throw new AppError("RESOURCE_CHANGED", "The recorded Render disk identity changed.");
          return service;
        }
        const found: Service[] = [];
        const cursors = new Set<string>();
        let cursor: string | undefined;
        for (let page = 0; page < 10; page++) {
          const summary = z.object({ id: z.string(), ownerId: z.string(), name: z.string() }).passthrough();
          const rows = parse(z.array(z.object({ service: summary, cursor: z.string() })).max(100), await get("/v1/services", { ownerId: owner!, name, limit: "100", ...(cursor ? { cursor } : {}) }));
          found.push(...rows.filter((r) => r.service.ownerId === owner && r.service.name === name).map((r) => parse(serviceSchema, r.service)));
          if (rows.length < 100) {
            if (found.length > 1) throw new AppError("RECONCILIATION_REQUIRED", "Multiple Render services match the operation identity.");
            return found[0];
          }
          const next = rows.at(-1)!.cursor;
          if (!next || cursors.has(next)) break;
          cursors.add(next); cursor = next;
        }
        throw new AppError("RECONCILIATION_REQUIRED", "The bounded Render service lookup was incomplete.");
      }
      const resources = (service: Service, deployment?: string): Resource[] => {
        const url = safeUrl(service.serviceDetails.url);
        return [
          { id: service.id, provider: "render", kind: "service", account: owner, region: p.region, ...(url ? { url: `${url}/healthz` } : {}) },
          { id: service.serviceDetails.disk.id, provider: "render", kind: "disk", account: owner, region: p.region },
          ...(deployment ? [{ id: deployment, provider: "render", kind: "deploy", account: owner, region: p.region }] : []),
        ];
      };
      async function outcome(service: Service, deployment?: string): Promise<Outcome> {
        const known = resources(service, deployment);
        if (!matches(service)) return { status: "unknown", resources: known };
        let raw: unknown;
        if (deployment) raw = await optional(`/v1/services/${service.id}/deploys/${deployment}`);
        else {
          const rows = parse(z.array(z.object({ deploy: deploySchema, cursor: z.string() })).max(100), await get(`/v1/services/${service.id}/deploys`, { limit: "100" }));
          // Without a returned deploy ID, never guess between multiple attempts.
          if (rows.length !== 1) return { status: "unknown", resources: known };
          raw = rows[0]!.deploy;
        }
        if (!raw) return { status: "unknown", resources: known };
        const dep = parse(deploySchema, raw);
        if (deployment && dep.id !== deployment) throw new AppError("RESOURCE_CHANGED", "Render returned a different deployment identity.");
        const expectedSha = p.image.split("@")[1]!;
        if (!dep.image || dep.image.ref !== p.image || ![expectedSha, expectedSha.slice(7)].includes(dep.image.sha)) return { status: "unknown", resources: resources(service, dep.id) };
        const status = dep.status === "live" ? "succeeded" : ["build_failed", "update_failed", "pre_deploy_failed", "canceled", "deactivated"].includes(dep.status) ? "failed" : ["created", "queued", "build_in_progress", "update_in_progress", "pre_deploy_in_progress"].includes(dep.status) ? "pending" : "unknown";
        return { status, resources: resources(service, dep.id) };
      }
      const preconditions = { ownerId: owner, name, image: p.image, plan, diskName, diskGb: p.diskGb, region: p.region, httpTokenDigest: digest(httpToken), absent: true };
      const current = await find();
      if (request.method === "prepare") {
        if (!pricingFresh(RENDER_PRICING.reviewedAt)) throw new AppError("PRICING_STALE", "Render pricing needs a new review before paid preparation.");
        if (current) throw new AppError("RESOURCE_EXISTS", "The Render service already exists. Reconcile its original operation; do not create a replacement.");
        const monthlyCents = renderMonthlyCents(p.plan, p.diskGb);
        return {
          account: owner, region: p.region,
          mutations: [{ action: "create", target: `${owner}:${name}`, details: JSON.stringify({ image: p.image, compute: plan, instances: 1, disk: { name: diskName, sizeGB: p.diskGb, mountPath: "/var/data" }, initialDeploy: true, autoDeployTrigger: "off", command: "node dist/index.js serve-http", privateTransfer: "RENDER_MCP_HTTP_TOKEN to MCP_DEVOPS_HTTP_TOKEN", stateDirectory: "/var/data/mcp-state", publicUrl: "Provider HTTPS address; /healthz is public and /mcp requires the private token.", removal: "Manual service and disk removal. Failed deploys can remain billed." }) }],
          estimate: { recurring: [{ key: `service:${name}`, cents: monthlyCents }], upfrontCents: 0, reviewedAt: RENDER_PRICING.reviewedAt, source: RENDER_PRICING.source, assumptions: [...RENDER_PRICING.assumptions] },
          preconditions,
          expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        } satisfies Prepared;
      }
      if (request.method === "execute") {
        if (current) throw new AppError("RESOURCE_EXISTS", "A matching service exists. Reconcile the operation instead of retrying creation.");
        if (!request.prepared || request.prepared.account !== owner || digest(request.prepared.preconditions) !== digest(preconditions) || Date.parse(request.prepared.expiresAt) <= Date.now() || !pricingFresh(RENDER_PRICING.reviewedAt)) throw new AppError("PRECONDITION_CHANGED", "Render preparation expired or its image, account or private setup changed. Prepare again.");
        const raw = await http.request("POST", "/v1/services", { body: {
          type: "web_service", name, ownerId: owner, autoDeployTrigger: "off", image: { ownerId: owner, imagePath: p.image },
          envVars: [
            { key: "MCP_DEVOPS_HTTP_TOKEN", value: httpToken },
            { key: "MCP_DEVOPS_HTTP_HOST", value: "0.0.0.0" },
            { key: "MCP_DEVOPS_STATE_DIR", value: "/var/data/mcp-state" },
          ],
          serviceDetails: { runtime: "image", plan, region: p.region, numInstances: 1, healthCheckPath: "/healthz", disk: { name: diskName, sizeGB: p.diskGb, mountPath: "/var/data" }, envSpecificDetails: { dockerCommand: "node dist/index.js serve-http" } },
        } });
        const result = parse(z.object({ service: serviceSchema, deployId: deployId.optional() }), raw, true);
        if (result.service.ownerId !== owner || result.service.name !== name) throw new ProviderError("PROVIDER_RESPONSE_INVALID", "Render did not confirm the created service identity.", undefined, true);
        // A successful create response is not proof of application health.
        return { status: matches(result.service) ? "pending" : "unknown", resources: resources(result.service, result.deployId) } satisfies Outcome;
      }
      if (request.method === "verify") {
        const confirmed = !!current && matches(current);
        return { checks: [
          { kind: "provider-service", status: confirmed ? "passed" : "failed", detail: confirmed ? "Render reports the approved image, service and disk configuration." : "Render did not confirm the approved configuration." },
          { kind: "server", status: "unverified", detail: "Test authenticated MCP initialization and form approval with the remote client." },
          { kind: "disk", status: "unverified", detail: "Test journal recovery after a hosted service restart. The provider disk record alone does not prove durable application writes." },
        ] };
      }
      if (!current) return { status: "unknown", resources: request.resources ?? [] } satisfies Outcome;
      const deployments = request.resources?.filter((r) => r.kind === "deploy");
      if (deployments && (deployments.length > 1 || deployments.some((r) => r.provider !== "render" || r.account !== owner || !deployId.safeParse(r.id).success))) throw new AppError("INVALID_RESOURCE", "The recorded Render deployment identity is invalid.");
      return outcome(current, deployments?.[0]?.id);
    },
  };
}
