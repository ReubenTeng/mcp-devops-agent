import { z } from "zod";
import type { AppConfig } from "../config.js";
import { ProviderError, ProviderHttp } from "./http.js";

const REF_PATTERN = /^[a-z0-9]{20}$/;

const organizationSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  plan: z.string().optional(),
});

const regionsSchema = z.object({
  all: z.object({
    specific: z.array(z.object({ code: z.string() }).passthrough()).optional(),
  }).optional(),
});

const projectSchema = z.object({
  id: z.string().optional(),
  ref: z.string().optional(),
  name: z.string(),
  organization_id: z.string().optional(),
  organization_slug: z.string().optional(),
  status: z.string().optional(),
  created_at: z.string().optional(),
  region: z.string().optional(),
});

const apiKeySchema = z.object({
  name: z.string().optional(),
  type: z.string().optional(),
  api_key: z.string(),
});

export interface SupabaseApiKey {
  name?: string;
  type?: string;
  apiKey: string;
}

export interface SupabaseProject {
  ref: string;
  name: string;
  organization_id?: string;
  organization_slug?: string;
  status?: string;
  created_at?: string;
  region?: string;
}

export class SupabaseProvider {
  private readonly http: ProviderHttp;

  constructor(credentials: AppConfig["credentials"], fetchImpl: typeof fetch = fetch, signal?: AbortSignal) {
    this.http = new ProviderHttp("https://api.supabase.com", credentials.supabaseToken, fetchImpl, undefined, signal);
  }

  private parse<T>(schema: z.ZodType<T>, data: unknown, mutation: boolean): T {
    const result = schema.safeParse(data);
    if (!result.success) {
      throw new ProviderError("PROVIDER_RESPONSE_INVALID", "Supabase returned an unexpected response.", undefined, mutation);
    }
    return result.data;
  }

  private normalizeProject(parsed: z.infer<typeof projectSchema>, mutation: boolean): SupabaseProject {
    const ref = parsed.ref ?? parsed.id;
    if (ref === undefined || !REF_PATTERN.test(ref)) {
      throw new ProviderError("PROVIDER_RESPONSE_INVALID", "Supabase returned an unexpected response.", undefined, mutation);
    }
    return {
      ref,
      name: parsed.name,
      organization_id: parsed.organization_id,
      organization_slug: parsed.organization_slug,
      status: parsed.status,
      created_at: parsed.created_at,
      region: parsed.region,
    };
  }

  async organization(slug: string): Promise<{ id: string; name?: string; plan?: string }> {
    const data = await this.http.request("GET", `/v1/organizations/${encodeURIComponent(slug)}`);
    return this.parse(organizationSchema, data, false);
  }

  async regions(slug: string): Promise<string[]> {
    const data = await this.http.request("GET", "/v1/projects/available-regions", {
      query: { organization_slug: slug },
    });
    const parsed = this.parse(regionsSchema, data, false);
    return (parsed.all?.specific ?? []).map((region) => region.code);
  }

  async listProjects(): Promise<SupabaseProject[]> {
    const data = await this.http.request("GET", "/v1/projects");
    const parsed = this.parse(z.array(projectSchema), data, false);
    return parsed.map((project) => this.normalizeProject(project, false));
  }

  async getProject(ref: string): Promise<SupabaseProject> {
    const data = await this.http.request("GET", `/v1/projects/${encodeURIComponent(ref)}`);
    const project = this.normalizeProject(this.parse(projectSchema, data, false), false);
    if (project.ref !== ref) {
      throw new ProviderError("PROVIDER_RESPONSE_INVALID", "Supabase returned an unexpected response.", undefined, false);
    }
    return project;
  }

  async createProject(input: {
    name: string;
    organizationSlug: string;
    region: string;
    plan: "free" | "pro";
    password: string;
  }): Promise<SupabaseProject> {
    const body: Record<string, unknown> = {
      name: input.name,
      organization_slug: input.organizationSlug,
      db_pass: input.password,
      region_selection: { type: "specific", code: input.region },
    };
    if (input.plan === "pro") {
      body.desired_instance_size = "micro";
    }
    const data = await this.http.request("POST", "/v1/projects", { body });
    const project = this.normalizeProject(this.parse(projectSchema, data, true), true);
    if (project.name !== input.name) {
      throw new ProviderError(
        "PROVIDER_RESPONSE_INVALID",
        "Supabase returned an unexpected response.",
        undefined,
        true,
      );
    }
    if (project.organization_slug !== undefined && project.organization_slug !== input.organizationSlug) {
      throw new ProviderError("ACCOUNT_MISMATCH", "The Supabase project belongs to a different organization.", undefined, true);
    }
    return project;
  }

  async getApiKeys(ref: string): Promise<SupabaseApiKey[]> {
    const data = await this.http.request("GET", `/v1/projects/${encodeURIComponent(ref)}/api-keys`, {
      query: { reveal: "true" },
      readOnly: true,
    });
    const parsed = this.parse(z.array(apiKeySchema), data, false);
    return parsed.map((key) => ({ name: key.name, type: key.type, apiKey: key.api_key }));
  }
}
