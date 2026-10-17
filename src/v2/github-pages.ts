import { z } from "zod";
import type { AppConfig } from "../config.js";
import { AppError } from "../errors.js";
import { ProviderError, ProviderHttp } from "../providers/http.js";
import { credentialsFor, type Adapter, type AdapterRequest } from "./adapter.js";
import { manifestSchema, type Outcome, type Prepared, type Resource } from "./schema.js";

export const githubPagesManifest = manifestSchema.parse({
  protocolVersion: 2, id: "github-pages", name: "GitHub Pages", version: "2.0.0", tier: "executable",
  capabilities: ["static"], runtimes: ["static", "node"], frameworks: [], regions: [], compliance: [],
  forbiddenCapabilities: ["auth"],
  commercialUse: "restricted", reliability: "production", credentials: ["GITHUB_TOKEN"], accountSettings: [],
  operations: ["create_source_ref", "configure_pages", "build_pages", "teardown"], teardown: true, teardownKinds: ["pages"], reconciliation: "identity", artifactAccess: false, buildMode: "prebuilt", maxStorageGb: 1,
  pricing: { monthlyCents: 0, upfrontCents: 0, reviewedAt: "2026-10-14", source: "https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits", assumptions: ["Public repository and prebuilt static content only. GitHub Pages business/e-commerce/SaaS restrictions apply. Published site limit 1 GB, soft bandwidth limit 100 GB/month. No private repository or paid Actions usage is included."] },
  documentation: ["https://docs.github.com/en/rest/pages/pages", "https://docs.github.com/en/rest/git/refs", "https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits"],
  limits: ["Existing public repository with Pages write and repository administration permissions.", "Source must be an explicit immutable commit containing ready-to-publish HTML/Jekyll output. Each repository mutation is separately approved.", "Source branches are preserved during teardown; only the Pages site is removed."],
});
const label = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/);
const parametersSchema = z.object({ owner: label, repo: label, sha: z.string().regex(/^[a-f0-9]{40}$/), branch: z.string().regex(/^mcp-pages-[a-z0-9-]{1,60}$/), path: z.enum(["/", "/docs"]).default("/") }).strip();
const repoSchema = z.object({ id: z.number().int().positive(), name: z.string(), owner: z.object({ id: z.number().int().positive(), login: z.string() }), private: z.boolean(), permissions: z.object({ admin: z.boolean().optional(), maintain: z.boolean().optional(), push: z.boolean().optional() }).optional() });
const pageSchema = z.object({ status: z.string().optional(), source: z.object({ branch: z.string(), path: z.string() }).optional(), html_url: z.string().optional(), build_type: z.string().optional() });
const refSchema = z.object({ ref: z.string(), object: z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/) }) });
const buildSchema = z.object({ status: z.string(), commit: z.string().optional() });
const configuration = (page: z.infer<typeof pageSchema>) => ({ build_type: page.build_type ?? "legacy", source: page.source ?? null });
function parse<T>(schema: z.ZodType<T>, data: unknown, ambiguous = false): T {
  const result = schema.safeParse(data);
  if (!result.success) throw new ProviderError("PROVIDER_RESPONSE_INVALID", "GitHub returned an invalid Pages response.", undefined, ambiguous);
  return result.data;
}
function publicUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try { const u = new URL(value); if (u.protocol === "https:" && u.hostname.endsWith(".github.io") && !u.username && !u.password && !u.port && !u.search && !u.hash) return u.toString(); } catch {}
  return undefined;
}
export function githubPagesAdapter(config: AppConfig, checksum: string, fetchImpl: typeof fetch = fetch): Adapter {
  return {
    manifest: githubPagesManifest, checksum, validate: async () => {},
    async invoke(request: AdapterRequest, signal?: AbortSignal): Promise<unknown> {
      const http = new ProviderHttp("https://api.github.com", credentialsFor(config).GITHUB_TOKEN, fetchImpl, undefined, signal);
      const headers = { accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
      const get = (p: string) => http.request("GET", p, { headers });
      const optional = async (p: string) => { try { return await get(p); } catch (err) { if (err instanceof ProviderError && err.status === 404) return undefined; throw err; } };
      if (request.operation === "teardown") {
        const parsed = z.object({ resources: z.array(z.object({ id: z.string(), provider: z.literal("github-pages"), kind: z.literal("pages"), account: z.string() }).passthrough()).min(1).max(1) }).passthrough().safeParse(request.parameters);
        if (!parsed.success) throw new AppError("TEARDOWN_UNSUPPORTED", "Only the recorded Pages site can be removed; repository source branches are preserved.");
        const resource = parsed.data.resources[0]!;
        const match = /^([a-zA-Z0-9_.-]+):([a-zA-Z0-9_.-]+)$/.exec(resource.id);
        if (!match) throw new AppError("INVALID_RESOURCE", "Invalid recorded repository identity.");
        const base = `/repos/${encodeURIComponent(match[1]!)}/${encodeURIComponent(match[2]!)}`;
        const repo = parse(repoSchema, await get(base));
        if (String(repo.owner.id) !== resource.account) throw new AppError("ACCOUNT_MISMATCH", "The repository owner changed.");
        const current = await optional(`${base}/pages`);
        if (request.method === "prepare") {
          if (!current) throw new AppError("RESOURCE_ABSENT", "The Pages site is already absent. Reconcile the teardown.");
          return { account: resource.account, mutations: [{ action: "delete", target: resource.id, details: "Remove the GitHub Pages site; repository, files and source branches are preserved." }], estimate: { recurring: [], upfrontCents: 0, reviewedAt: "2026-10-14", source: githubPagesManifest.pricing.source, assumptions: [] }, preconditions: { repositoryId: repo.id, pages: configuration(parse(pageSchema, current)) }, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() } satisfies Prepared;
        }
        if (request.method === "execute") await http.request("DELETE", `${base}/pages`, { headers, allowEmpty: true });
        return { status: request.method === "execute" || !current ? "succeeded" : "unknown", resources: [resource] } satisfies Outcome;
      }
      const parsed = parametersSchema.safeParse(request.parameters);
      if (!parsed.success) throw new AppError("SETUP_REQUIRED", "GitHub Pages requires owner, repo and a 40-character immutable source sha. It deploys prebuilt committed content.");
      const p = parsed.data;
      const base = `/repos/${encodeURIComponent(p.owner)}/${encodeURIComponent(p.repo)}`;
      const repository = parse(repoSchema, await get(base));
      if (repository.private || repository.owner.login.toLowerCase() !== p.owner.toLowerCase() || repository.name.toLowerCase() !== p.repo.toLowerCase()) throw new AppError("UNSUPPORTED_REPOSITORY", "This reviewed Pages blueprint supports matching public repositories only.");
      const account = String(repository.owner.id);
      const identity = `${p.owner}:${p.repo}`;
      const refPath = `${base}/git/ref/heads/${encodeURIComponent(p.branch)}`;
      const currentRef = await optional(refPath);
      const ref = currentRef === undefined ? undefined : parse(refSchema, currentRef);
      if (ref && ref.object.sha !== p.sha) throw new AppError("SOURCE_CHANGED", "The deployment source branch no longer matches the approved commit.");
      const resource = (kind: string, url?: string): Resource => ({ id: kind === "source-ref" ? p.branch : identity, provider: "github-pages", kind, account, ...(url ? { url } : {}) });
      let page: z.infer<typeof pageSchema> | undefined;
      if (request.operation !== "create_source_ref") { const raw = await optional(`${base}/pages`); if (raw !== undefined) page = parse(pageSchema, raw); }
      if (request.method === "prepare") {
        if (request.operation === "create_source_ref") {
          const commit = parse(z.object({ sha: z.string() }), await get(`${base}/commits/${p.sha}`));
          if (commit.sha !== p.sha) throw new AppError("SOURCE_CHANGED", "GitHub did not confirm the exact source commit.");
          if (ref) throw new AppError("RESOURCE_EXISTS", "The source branch already exists; reconcile its original creation.");
        } else if (!ref) throw new AppError("DEPENDENCY_PENDING", "Create the immutable source branch first.");
        const mutation = request.operation === "create_source_ref" ? { action: "create" as const, target: `${identity}:refs/heads/${p.branch}`, details: `Create a source branch at immutable commit ${p.sha}. No files are changed.` }
          : request.operation === "configure_pages" ? { action: page ? "update" as const : "create" as const, target: `${identity}:pages`, details: JSON.stringify({ before: page ? configuration(page) : null, after: { build_type: "legacy", source: { branch: p.branch, path: p.path } }, sideEffects: "GitHub may queue an initial Pages build after configuration." }) }
          : { action: "deploy" as const, target: `${identity}:pages`, details: `Request a Pages build of ${p.branch} at ${p.sha}.` };
        if (request.operation === "build_pages" && (!page || page.source?.branch !== p.branch || page.source.path !== p.path)) throw new AppError("PRECONDITION_CHANGED", "Configure the approved Pages source before requesting a build.");
        return { account, mutations: [mutation], estimate: { recurring: [], upfrontCents: 0, reviewedAt: "2026-10-14", source: githubPagesManifest.pricing.source, assumptions: githubPagesManifest.pricing.assumptions }, preconditions: { repositoryId: repository.id, sourceSha: p.sha, branch: p.branch, ...(request.operation === "configure_pages" ? { previous: page ? configuration(page) : null } : {}) }, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() } satisfies Prepared;
      }
      if (request.method === "verify") {
        const build = await optional(`${base}/pages/builds/latest`);
        const b = build ? parse(buildSchema, build) : undefined;
        return { checks: [{ kind: "static", status: b?.status === "built" && b.commit === p.sha ? "passed" : b?.status === "errored" ? "failed" : "unverified", detail: "Checks the GitHub Pages build against the approved immutable source commit. HTTP/application behavior requires a separate health probe." }] };
      }
      if (request.method === "execute") {
        if (request.operation === "create_source_ref") {
          const created = parse(refSchema, await http.request("POST", `${base}/git/refs`, { headers, body: { ref: `refs/heads/${p.branch}`, sha: p.sha } }), true);
          if (created.ref !== `refs/heads/${p.branch}` || created.object.sha !== p.sha) throw new ProviderError("PROVIDER_RESPONSE_INVALID", "GitHub did not confirm the approved source branch.", undefined, true);
          return { status: "succeeded", resources: [resource("source-ref")] } satisfies Outcome;
        }
        if (request.operation === "configure_pages") {
          const body = { build_type: "legacy", source: { branch: p.branch, path: p.path } };
          await http.request(page ? "PUT" : "POST", `${base}/pages`, { headers, body, allowEmpty: !!page });
          const configured = parse(pageSchema, await get(`${base}/pages`));
          if (configured.source?.branch !== p.branch || configured.source.path !== p.path) throw new ProviderError("PROVIDER_RESPONSE_INVALID", "GitHub did not confirm the approved Pages source.", undefined, true);
          return { status: "succeeded", resources: [resource("pages", publicUrl(configured.html_url))] } satisfies Outcome;
        }
        const build = parse(buildSchema, await http.request("POST", `${base}/pages/builds`, { headers, body: {} }), true);
        return { status: build.status === "errored" ? "failed" : "pending", resources: [resource("pages-build", publicUrl(page?.html_url))] } satisfies Outcome;
      }
      if (request.operation === "create_source_ref") return { status: ref?.object.sha === p.sha ? "succeeded" : "unknown", resources: ref ? [resource("source-ref")] : [] } satisfies Outcome;
      if (request.operation === "configure_pages") return { status: page?.source?.branch === p.branch && page.source.path === p.path ? "succeeded" : "unknown", resources: page ? [resource("pages", publicUrl(page.html_url))] : [] } satisfies Outcome;
      const raw = await optional(`${base}/pages/builds/latest`); const build = raw ? parse(buildSchema, raw) : undefined;
      return { status: !build || build.commit !== p.sha ? "unknown" : build.status === "built" ? "succeeded" : build.status === "errored" ? "failed" : "pending", resources: [resource("pages-build", publicUrl(page?.html_url))] } satisfies Outcome;
    },
  };
}
