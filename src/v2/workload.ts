import type { AppConfig } from "../config.js";
import { AppError } from "../errors.js";
import { analyzeProject } from "../tools/scan.js";
import { readProjectFile } from "../utils/files.js";
import { collectDeploymentManifest } from "../utils/deployment.js";
import type { Capability, Overrides, Workload } from "./schema.js";

export async function analyzeWorkload(projectPath: string, config: AppConfig, overrides: Overrides = {}): Promise<Workload> {
  const analysis = await analyzeProject(projectPath, config);
  let sourceDigest: string | undefined;
  const sourceWarnings: string[] = [];
  try { sourceDigest = (await collectDeploymentManifest(analysis.projectPath)).digest; }
  catch (err) {
    if (!(err instanceof AppError) || !["DEPLOYMENT_EMPTY", "DEPLOYMENT_TOO_LARGE", "FILE_TOO_LARGE"].includes(err.code)) throw err;
    sourceWarnings.push("A complete local deployment fingerprint is unavailable. Use a bounded deployable artifact or an immutable remote source revision.");
  }
  const map: Record<string, Capability> = { hosting: "static", "static-hosting": "static", "serverless-functions": "serverless", "node-server": "server", sql: "postgres", mysql: "mysql", sqlite: "sqlite", mongodb: "document-db", redis: "redis", auth: "auth", storage: "storage" };
  const capabilities = new Set<Capability>(analysis.stackRequirements.flatMap((r) => map[r] ? [map[r]!] : []));
  const packageText = await readProjectFile(analysis.projectPath, "package.json");
  const manifest = packageText ? JSON.parse(packageText) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; scripts?: Record<string, unknown> } : {};
  const deps = { ...manifest.dependencies, ...manifest.devDependencies };
  const docker = await readProjectFile(analysis.projectPath, "Dockerfile", 256 * 1024);
  const wrangler = await readProjectFile(analysis.projectPath, "wrangler.toml", 256 * 1024) ?? await readProjectFile(analysis.projectPath, "wrangler.jsonc", 256 * 1024);
  if (docker !== undefined) capabilities.add("container");
  if (wrangler !== undefined || deps.hono) capabilities.add("edge");
  if (deps.ws || deps["socket.io"]) capabilities.add("websocket");
  if (deps.bullmq || deps.bull) { capabilities.add("worker"); capabilities.add("redis"); }
  if (deps["node-cron"]) capabilities.add("cron");
  if (capabilities.has("sqlite")) capabilities.add("disk");
  if (capabilities.has("server") || capabilities.has("serverless") || capabilities.has("edge") || capabilities.has("container")) capabilities.delete("static");
  if (overrides.capabilities) { capabilities.clear(); overrides.capabilities.forEach((c) => capabilities.add(c)); }
  if (overrides.domain) { capabilities.add("dns"); if (overrides.domain.purchase) capabilities.add("registrar"); }
  const blueprint = overrides.blueprint ?? (capabilities.has("container") ? "container_service" : capabilities.has("server") ? "web_service" : capabilities.has("edge") ? "edge_application" : capabilities.has("serverless") ? "full_stack_web" : capabilities.has("worker") ? "background_worker" : capabilities.has("cron") ? "scheduled_job" : "static_site");
  const required: Record<Workload["blueprint"], Capability> = { static_site: "static", edge_application: "edge", serverless_api: "serverless", web_service: "server", container_service: "container", background_worker: "worker", scheduled_job: "cron", full_stack_web: "serverless" };
  if (overrides.blueprint) for (const c of ["static", "edge", "serverless", "server", "container", "worker", "cron"] as Capability[]) capabilities.delete(c);
  if (capabilities.size || overrides.blueprint) capabilities.add(required[blueprint]);
  const ports = [...new Set([...(docker ?? "").matchAll(/^\s*EXPOSE\s+(\d{1,5})/gm)].map((m) => Number(m[1])).filter((p) => p > 0 && p < 65536))];
  const questions = [...analysis.warnings, ...sourceWarnings];
  if (!capabilities.size) questions.push("Choose a workload blueprint; no deployable workload was established.");
  if (analysis.truncated) questions.push("Confirm capabilities because the bounded scan was incomplete.");
  if (capabilities.has("edge") && capabilities.has("server")) questions.push("Confirm whether this server has an edge-compatible build.");
  return { blueprint, capabilities: [...capabilities].sort(), frameworks: analysis.frameworks,
    runtime: overrides.runtime ?? (docker !== undefined ? "container" : wrangler !== undefined || deps.hono ? "worker" : packageText ? "node" : "static"), ports,
    buildCommand: manifest.scripts?.build ? `${analysis.packageManager === "unknown" ? "npm" : analysis.packageManager} run build` : undefined,
    startCommand: manifest.scripts?.start ? `${analysis.packageManager === "unknown" ? "npm" : analysis.packageManager} run start` : undefined,
    sourceRevision: overrides.sourceRevision, sourceDigest, envKeys: analysis.envKeys,
    privilegedEnvKeys: analysis.envKeys.filter((k) => /SECRET|PASSWORD|SERVICE_ROLE|PRIVATE|ADMIN/.test(k)),
    evidence: analysis.evidence, questions, truncated: analysis.truncated };
}
