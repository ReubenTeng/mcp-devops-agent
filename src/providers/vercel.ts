import { z } from "zod";
import type { AppConfig } from "../config.js";
import { AppError } from "../errors.js";
import { ProviderError, ProviderHttp } from "./http.js";

const teamSchema = z.object({
  id: z.string(),
  billing: z.object({ plan: z.string() }),
});

const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  accountId: z.string().optional(),
  targets: z.record(z.string(), z.object({ id: z.string() }).nullable()).nullable().optional(),
});

const deploymentSchema = z.object({
  id: z.string(),
  url: z.string().nullable().optional(),
  readyState: z.string().optional(),
  status: z.string().optional(),
  projectId: z.string().optional(),
  target: z.string().optional(),
});

const deploymentListItemSchema = z.object({
  uid: z.string(),
  url: z.string().nullable().optional(),
  readyState: z.string().optional(),
  status: z.string().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

const deploymentListSchema = z.object({
  deployments: z.array(deploymentListItemSchema),
  pagination: z.object({ next: z.number().nullable().optional() }).optional(),
});

const envUpsertEntrySchema = z.object({ key: z.string() });

const envUpsertSchema = z.object({
  failed: z.array(z.unknown()),
  created: z.union([z.array(envUpsertEntrySchema), envUpsertEntrySchema]).optional(),
});

const projectDomainSchema = z.object({
  name: z.string(),
  projectId: z.string().optional(),
  verified: z.boolean(),
  verification: z
    .array(z.object({ type: z.string(), domain: z.string(), value: z.string(), reason: z.string().optional() }))
    .optional(),
});

const domainConfigSchema = z.object({
  recommendedCNAME: z.array(z.object({ rank: z.number(), value: z.string() })).optional(),
  recommendedIPv4: z.array(z.object({ rank: z.number(), value: z.array(z.string()) })).optional(),
  misconfigured: z.boolean(),
});

const verifySchema = z.object({ verified: z.boolean() });

const MAX_DEPLOYMENT_PAGES = 10;
const MAX_DEPLOYMENT_RECORDS = 1000;

export function safeVercelUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url.startsWith("http") ? url : `https://${url}`);
    if (
      parsed.protocol === "https:" &&
      (parsed.hostname === "vercel.app" || parsed.hostname.endsWith(".vercel.app")) &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.port === ""
    ) {
      return `https://${parsed.hostname}/`;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export class VercelProvider {
  private readonly http: ProviderHttp;

  constructor(credentials: AppConfig["credentials"], fetchImpl: typeof fetch = fetch, signal?: AbortSignal) {
    this.http = new ProviderHttp("https://api.vercel.com", credentials.vercelToken, fetchImpl, undefined, signal);
    this.teamId = credentials.vercelTeamId;
  }

  private readonly teamId: string | undefined;

  private requireTeamId(): string {
    if (!this.teamId) {
      throw new ProviderError("MISSING_CREDENTIAL", "Vercel credential is not configured.", undefined, false);
    }
    return this.teamId;
  }

  private scoped(options: { query?: Record<string, string> } = {}): { query: Record<string, string> } {
    return { query: { teamId: this.requireTeamId(), ...(options.query ?? {}) } };
  }

  private parse<T>(schema: z.ZodType<T>, data: unknown, mutation: boolean): T {
    const result = schema.safeParse(data);
    if (!result.success) {
      throw new ProviderError("PROVIDER_RESPONSE_INVALID", "Vercel returned an unexpected response.", undefined, mutation);
    }
    return result.data;
  }

  async team(): Promise<{ id: string; plan: string }> {
    const data = await this.http.request("GET", `/v2/teams/${encodeURIComponent(this.requireTeamId())}`, this.scoped());
    const team = this.parse(teamSchema, data, false);
    if (team.id !== this.requireTeamId()) {
      throw new ProviderError("PROVIDER_RESPONSE_INVALID", "Vercel returned an unexpected response.", undefined, false);
    }
    return { id: team.id, plan: team.billing.plan };
  }

  async getProject(idOrName: string): Promise<{ id: string; name: string; accountId?: string; targets?: Record<string, { id: string } | null> | null }> {
    const data = await this.http.request(
      "GET",
      `/v9/projects/${encodeURIComponent(idOrName)}`,
      this.scoped(),
    );
    const project = this.parse(projectSchema, data, false);
    if (project.id !== idOrName && project.name !== idOrName) {
      throw new ProviderError("PROVIDER_RESPONSE_INVALID", "Vercel returned an unexpected response.", undefined, false);
    }
    if (project.accountId !== undefined && project.accountId !== this.requireTeamId()) {
      throw new AppError("ACCOUNT_MISMATCH", "The Vercel project belongs to a different account.");
    }
    return project;
  }

  async findProject(idOrName: string): Promise<{ id: string; name: string; accountId?: string; targets?: Record<string, { id: string } | null> | null } | undefined> {
    try {
      return await this.getProject(idOrName);
    } catch (err) {
      if (err instanceof ProviderError && err.status === 404) return undefined;
      throw err;
    }
  }

  async createProject(input: { name: string; framework: string | null }): Promise<{ id: string; name: string }> {
    const body: Record<string, unknown> = { name: input.name };
    if (input.framework) body.framework = input.framework;
    const data = await this.http.request("POST", "/v11/projects", { ...this.scoped(), body });
    const project = this.parse(projectSchema, data, true);
    if (project.name !== input.name) {
      throw new ProviderError("PROVIDER_RESPONSE_INVALID", "Vercel returned an unexpected response.", undefined, true);
    }
    if (project.accountId !== undefined && project.accountId !== this.requireTeamId()) {
      throw new ProviderError("ACCOUNT_MISMATCH", "The Vercel project belongs to a different account.", undefined, true);
    }
    return project;
  }

  async uploadFile(bytes: Buffer, sha: string): Promise<void> {
    await this.http.request("POST", "/v2/files", {
      ...this.scoped(),
      bytes,
      headers: {
        "content-type": "application/octet-stream",
        "x-vercel-digest": sha,
        "content-length": String(bytes.byteLength),
      },
      allowEmpty: true,
    });
  }

  async deploy(input: {
    project?: string;
    name: string;
    target: "preview" | "production";
    files?: { file: string; sha: string; size: number }[];
    gitSource?: { org: string; repo: string; sha: string };
    operationId: string;
  }): Promise<{ id: string; url?: string; readyState?: string; projectId?: string }> {
    const body: Record<string, unknown> = {
      name: input.name,
      meta: { mcpDevopsOperationId: input.operationId },
    };
    if (input.project) body.project = input.project;
    if (input.target === "production") body.target = "production";
    if (input.gitSource) {
      body.gitSource = { type: "github", org: input.gitSource.org, repo: input.gitSource.repo, ref: input.gitSource.sha, sha: input.gitSource.sha };
    } else {
      body.files = input.files ?? [];
    }
    const data = await this.http.request("POST", "/v13/deployments", { ...this.scoped(), body });
    const deployment = this.parse(deploymentSchema, data, true);
    if (
      deployment.projectId !== undefined &&
      input.project !== undefined &&
      deployment.projectId !== input.project
    ) {
      throw new ProviderError("PROVIDER_RESPONSE_INVALID", "Vercel returned an unexpected response.", undefined, true);
    }
    const url = safeVercelUrl(deployment.url ?? undefined);
    return {
      id: deployment.id,
      url,
      readyState: deployment.readyState ?? deployment.status,
      projectId: deployment.projectId,
    };
  }

  async getDeployment(id: string): Promise<{
    id: string;
    url?: string;
    readyState?: string;
    target?: string;
    projectId?: string;
  }> {
    const data = await this.http.request("GET", `/v13/deployments/${encodeURIComponent(id)}`, this.scoped());
    const deployment = this.parse(deploymentSchema, data, false);
    if (deployment.id !== id) {
      throw new ProviderError("PROVIDER_RESPONSE_INVALID", "Vercel returned an unexpected response.", undefined, false);
    }
    return {
      id: deployment.id,
      url: safeVercelUrl(deployment.url ?? undefined),
      readyState: deployment.readyState ?? deployment.status,
      target: deployment.target,
      projectId: deployment.projectId,
    };
  }

  async listDeployments(projectId: string): Promise<{ id: string; operationId?: string; readyState?: string }[]> {
    const out: { id: string; operationId?: string; readyState?: string }[] = [];
    let until: number | undefined;
    for (let page = 0; page < MAX_DEPLOYMENT_PAGES && out.length < MAX_DEPLOYMENT_RECORDS; page += 1) {
      const query: Record<string, string> = { projectId, limit: "100" };
      if (until !== undefined) query.until = String(until);
      const data = await this.http.request("GET", "/v7/deployments", this.scoped({ query }));
      const parsed = this.parse(deploymentListSchema, data, false);
      const next = parsed.pagination?.next;
      if (parsed.deployments.length === 0 && next != null) {
        throw new ProviderError(
          "PAGINATION_LIMIT",
          "Vercel deployment listing did not progress; reconciliation is incomplete.",
          undefined,
          false,
        );
      }
      for (const deployment of parsed.deployments) {
        out.push({
          id: deployment.uid,
          operationId:
            typeof deployment.meta?.mcpDevopsOperationId === "string"
              ? deployment.meta.mcpDevopsOperationId
              : undefined,
          readyState: deployment.readyState ?? deployment.status,
        });
        if (out.length >= MAX_DEPLOYMENT_RECORDS) break;
      }
      if (next == null) return out;
      if (next === until) {
        throw new ProviderError(
          "PAGINATION_LIMIT",
          "Vercel deployment listing did not progress; reconciliation is incomplete.",
          undefined,
          false,
        );
      }
      until = next;
    }
    throw new ProviderError(
      "PAGINATION_LIMIT",
      "Vercel deployment listing exceeded the supported pagination limit; reconciliation is incomplete.",
      undefined,
      false,
    );
  }

  async upsertEnv(
    projectId: string,
    values: Record<string, string>,
    targets: readonly string[],
  ): Promise<string[]> {
    const body = Object.entries(values).map(([key, value]) => ({
      key,
      value,
      type: "encrypted",
      target: [...targets],
    }));
    const data = await this.http.request("POST", `/v10/projects/${encodeURIComponent(projectId)}/env`, {
      ...this.scoped({ query: { upsert: "true" } }),
      body,
    });
    const parsed = this.parse(envUpsertSchema, data, true);
    if (parsed.failed.length > 0) {
      throw new ProviderError(
        "PARTIAL_PROVIDER_FAILURE",
        "Vercel rejected some environment variables; the project may be partially updated.",
        undefined,
        true,
      );
    }
    const requested = Object.keys(values);
    if (parsed.created === undefined) {
      throw new ProviderError(
        "PROVIDER_RESPONSE_INVALID",
        "Vercel did not confirm which environment variables were written.",
        undefined,
        true,
      );
    }
    const created = Array.isArray(parsed.created) ? parsed.created : [parsed.created];
    const createdKeys = new Set(created.map((entry) => entry.key));
    if (!requested.every((key) => createdKeys.has(key))) {
      throw new ProviderError(
        "PROVIDER_RESPONSE_INVALID",
        "Vercel did not confirm which environment variables were written.",
        undefined,
        true,
      );
    }
    return requested.sort();
  }

  async addDomain(
    projectId: string,
    domain: string,
  ): Promise<{ name: string; verified: boolean; projectId?: string; verification?: { type: string; domain: string; value: string; reason?: string }[] }> {
    const data = await this.http.request("POST", `/v10/projects/${encodeURIComponent(projectId)}/domains`, {
      ...this.scoped(),
      body: { name: domain },
    });
    const parsed = this.parse(projectDomainSchema, data, true);
    if (parsed.name !== domain) {
      throw new ProviderError("PROVIDER_RESPONSE_INVALID", "Vercel returned an unexpected response.", undefined, true);
    }
    if (parsed.projectId !== undefined && parsed.projectId !== projectId) {
      throw new ProviderError("ACCOUNT_MISMATCH", "The Vercel domain belongs to a different project.", undefined, true);
    }
    return parsed;
  }

  async getProjectDomain(
    projectId: string,
    domain: string,
  ): Promise<{ name: string; projectId?: string; verified: boolean; verification?: { type: string; domain: string; value: string; reason?: string }[] }> {
    const data = await this.http.request(
      "GET",
      `/v9/projects/${encodeURIComponent(projectId)}/domains/${encodeURIComponent(domain)}`,
      this.scoped(),
    );
    const parsed = this.parse(projectDomainSchema, data, false);
    if (parsed.name !== domain) {
      throw new ProviderError("PROVIDER_RESPONSE_INVALID", "Vercel returned an unexpected response.", undefined, false);
    }
    if (parsed.projectId !== undefined && parsed.projectId !== projectId) {
      throw new AppError("ACCOUNT_MISMATCH", "The Vercel domain belongs to a different project.");
    }
    return parsed;
  }

  async domainConfig(
    projectId: string,
    domain: string,
  ): Promise<{ recommendedCNAME?: { rank: number; value: string }[]; recommendedIPv4?: { rank: number; value: string[] }[]; misconfigured: boolean }> {
    const data = await this.http.request(
      "GET",
      `/v6/domains/${encodeURIComponent(domain)}/config`,
      this.scoped({ query: { projectIdOrName: projectId } }),
    );
    return this.parse(domainConfigSchema, data, false);
  }

  async verifyDomain(projectId: string, domain: string): Promise<{ verified: boolean }> {
    const data = await this.http.request(
      "POST",
      `/v9/projects/${encodeURIComponent(projectId)}/domains/${encodeURIComponent(domain)}/verify`,
      this.scoped(),
    );
    const parsed = this.parse(verifySchema, data, true);
    return { verified: parsed.verified };
  }

  async rollback(projectId: string, deploymentId: string): Promise<void> {
    await this.http.request(
      "POST",
      `/v1/projects/${encodeURIComponent(projectId)}/rollback/${encodeURIComponent(deploymentId)}`,
      { ...this.scoped(), allowEmpty: true },
    );
  }
}
