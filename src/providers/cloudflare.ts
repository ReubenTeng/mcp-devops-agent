import { z } from "zod";
import type { AppConfig } from "../config.js";
import { ProviderError, ProviderHttp } from "./http.js";

const envelope = <T extends z.ZodTypeAny>(result: T) =>
  z.object({
    success: z.boolean(),
    result: result.optional().nullable(),
    result_info: z.object({ total_pages: z.number().int().positive().optional() }).optional(),
    errors: z.array(z.unknown()).optional(),
  });

const accountSchema = z.object({ id: z.string(), name: z.string().optional() });

const domainReasons = new Set([
  "domain_unavailable",
  "extension_not_supported_via_api",
  "extension_not_supported",
  "extension_disallows_registration",
  "domain_premium",
]);

const domainOfferSchema = z.object({
  name: z.string(),
  registrable: z.boolean().optional(),
  tier: z.string().optional(),
  pricing: z
    .object({
      currency: z.string(),
      registration_cost: z.string(),
      renewal_cost: z.string(),
    })
    .optional(),
  reason: z.string().optional(),
});

export interface DomainOffer {
  name: string;
  registrable?: boolean;
  tier?: string;
  pricing?: { currency: string; registration_cost: string; renewal_cost: string };
  reason?: string;
}

const registrationResultSchema = z.object({
  domain_name: z.string(),
  state: z.string(),
  completed: z.boolean().optional(),
});

const registrationWorkflowSchema = z.object({
  domain_name: z.string().optional(),
  state: z.string(),
  completed: z.boolean().optional(),
});

const registrationSchema = z.object({
  domain_name: z.string(),
  status: z.string().optional(),
  expires_at: z.string().nullable().optional(),
  auto_renew: z.boolean().optional(),
});

const zoneSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string().optional(),
  name_servers: z.array(z.string()).optional(),
  account: z.object({ id: z.string() }),
});

const dnsRecordSchema = z.object({
  id: z.string(),
  type: z.string(),
  name: z.string(),
  content: z.string(),
  ttl: z.number().optional(),
  proxied: z.boolean().optional(),
});

export type DnsRecord = z.infer<typeof dnsRecordSchema>;

export interface DomainRegistration {
  domainName: string;
  status?: string;
  expiresAt?: string | null;
  autoRenew?: boolean;
}

export class CloudflareProvider {
  private readonly http: ProviderHttp;
  private readonly accountId: string | undefined;

  constructor(credentials: AppConfig["credentials"], fetchImpl: typeof fetch = fetch, signal?: AbortSignal) {
    this.http = new ProviderHttp("https://api.cloudflare.com", credentials.cloudflareToken, fetchImpl, undefined, signal);
    this.accountId = credentials.cloudflareAccountId;
  }

  private requireAccountId(): string {
    if (!this.accountId) {
      throw new ProviderError("MISSING_CREDENTIAL", "Cloudflare credential is not configured.", undefined, false);
    }
    return this.accountId;
  }

  private parse<T extends z.ZodTypeAny>(
    schema: T,
    data: unknown,
    mutation: boolean,
  ): z.infer<T> extends null | undefined ? unknown : NonNullable<z.infer<T>> {
    const result = envelope(schema).safeParse(data);
    if (!result.success) {
      throw new ProviderError("PROVIDER_RESPONSE_INVALID", "Cloudflare returned an unexpected response.", undefined, mutation);
    }
    if (!result.data.success) {
      throw new ProviderError("PROVIDER_REQUEST_FAILED", "Cloudflare rejected the request.", undefined, mutation);
    }
    if (result.data.result === undefined || result.data.result === null) {
      throw new ProviderError("PROVIDER_RESPONSE_INVALID", "Cloudflare returned an unexpected response.", undefined, mutation);
    }
    return result.data.result as NonNullable<z.infer<T>>;
  }

  private normalizeOffer(offer: z.infer<typeof domainOfferSchema>): DomainOffer {
    return {
      name: offer.name,
      registrable: offer.registrable,
      tier: offer.tier,
      pricing: offer.pricing,
      reason:
        offer.reason !== undefined
          ? domainReasons.has(offer.reason)
            ? offer.reason
            : "unknown"
          : undefined,
    };
  }

  async account(): Promise<{ id: string; name?: string }> {
    const data = await this.http.request(
      "GET",
      `/client/v4/accounts/${encodeURIComponent(this.requireAccountId())}`,
    );
    const account = this.parse(accountSchema, data, false);
    if (account.id !== this.requireAccountId()) {
      throw new ProviderError("PROVIDER_RESPONSE_INVALID", "Cloudflare returned an unexpected response.", undefined, false);
    }
    return account;
  }

  async searchDomains(query: string, limit: number): Promise<DomainOffer[]> {
    const data = await this.http.request(
      "GET",
      `/client/v4/accounts/${encodeURIComponent(this.requireAccountId())}/registrar/domain-search`,
      { query: { q: query, limit: String(limit) } },
    );
    const parsed = this.parse(z.object({ domains: z.array(domainOfferSchema) }), data, false);
    return parsed.domains.map((offer) => this.normalizeOffer(offer));
  }

  async checkDomain(domain: string): Promise<DomainOffer | undefined> {
    const data = await this.http.request(
      "POST",
      `/client/v4/accounts/${encodeURIComponent(this.requireAccountId())}/registrar/domain-check`,
      { body: { domains: [domain] }, readOnly: true },
    );
    const parsed = this.parse(z.union([z.object({ domains: z.array(domainOfferSchema) }), z.array(domainOfferSchema)]), data, false);
    const offers = Array.isArray(parsed) ? parsed : parsed.domains;
    const offer = offers.find((entry) => entry.name === domain);
    return offer === undefined ? undefined : this.normalizeOffer(offer);
  }

  async registerDomain(domain: string, years: number): Promise<{ domainName?: string; state: string; completed?: boolean }> {
    const data = await this.http.request(
      "POST",
      `/client/v4/accounts/${encodeURIComponent(this.requireAccountId())}/registrar/registrations`,
      { body: { domain_name: domain, years, auto_renew: false } },
    );
    const parsed = this.parse(registrationResultSchema, data, true);
    if (parsed.domain_name !== domain) {
      throw new ProviderError("PROVIDER_RESPONSE_INVALID", "Cloudflare returned an unexpected response.", undefined, true);
    }
    return { domainName: parsed.domain_name, state: parsed.state, completed: parsed.completed };
  }

  async registrationStatus(domain: string): Promise<{ state: string; completed?: boolean }> {
    const data = await this.http.request(
      "GET",
      `/client/v4/accounts/${encodeURIComponent(this.requireAccountId())}/registrar/registrations/${encodeURIComponent(domain)}/registration-status`,
    );
    const parsed = this.parse(registrationWorkflowSchema, data, false);
    if (parsed.domain_name !== undefined && parsed.domain_name !== domain) {
      throw new ProviderError("PROVIDER_RESPONSE_INVALID", "Cloudflare returned an unexpected response.", undefined, false);
    }
    return { state: parsed.state, completed: parsed.completed };
  }

  async getRegistration(domain: string): Promise<DomainRegistration> {
    const data = await this.http.request(
      "GET",
      `/client/v4/accounts/${encodeURIComponent(this.requireAccountId())}/registrar/registrations/${encodeURIComponent(domain)}`,
    );
    const parsed = this.parse(registrationSchema, data, false);
    if (parsed.domain_name !== domain) {
      throw new ProviderError("PROVIDER_RESPONSE_INVALID", "Cloudflare returned an unexpected response.", undefined, false);
    }
    return {
      domainName: parsed.domain_name,
      status: parsed.status,
      expiresAt: parsed.expires_at,
      autoRenew: parsed.auto_renew,
    };
  }

  private async listPaginated<T extends z.ZodTypeAny>(
    schema: T,
    path: string,
    queryBase: Record<string, string>,
    perPage: number,
  ): Promise<z.infer<T>> {
    const out: unknown[] = [];
    for (let page = 1; page <= 20; page += 1) {
      const data = await this.http.request("GET", path, {
        query: { ...queryBase, page: String(page), per_page: String(perPage) },
      });
      const parsed = envelope(schema).safeParse(data);
      const resultValue: unknown = parsed.success ? parsed.data.result : undefined;
      if (!parsed.success || !parsed.data.success || !Array.isArray(resultValue)) {
        throw new ProviderError("PROVIDER_RESPONSE_INVALID", "Cloudflare returned an unexpected response.", undefined, false);
      }
      out.push(...resultValue);
      const totalPages = parsed.data.result_info?.total_pages;
      if (totalPages !== undefined) {
        if (page >= totalPages) return out as z.infer<T>;
      } else if (resultValue.length < perPage) {
        return out as z.infer<T>;
      } else {
        throw new ProviderError(
          "PAGINATION_LIMIT",
          "Cloudflare listing returned a full page without pagination metadata; results are incomplete.",
          undefined,
          false,
        );
      }
      if (page === 20) break;
    }
    throw new ProviderError(
      "PAGINATION_LIMIT",
      "Cloudflare listing exceeded the pagination limit; results are incomplete.",
      undefined,
      false,
    );
  }

  async listZones(domain?: string): Promise<z.infer<typeof zoneSchema>[]> {
    const query: Record<string, string> = { "account.id": this.requireAccountId() };
    if (domain) query.name = domain;
    return this.listPaginated(z.array(zoneSchema), "/client/v4/zones", query, 50);
  }

  async getZone(id: string): Promise<z.infer<typeof zoneSchema>> {
    const data = await this.http.request("GET", `/client/v4/zones/${encodeURIComponent(id)}`);
    const zone = this.parse(zoneSchema, data, false);
    if (zone.id !== id) {
      throw new ProviderError("PROVIDER_RESPONSE_INVALID", "Cloudflare returned an unexpected response.", undefined, false);
    }
    if (zone.account.id !== this.requireAccountId()) {
      throw new ProviderError("ACCOUNT_MISMATCH", "The Cloudflare zone belongs to a different account.", undefined, false);
    }
    return zone;
  }

  async createZone(domain: string): Promise<z.infer<typeof zoneSchema>> {
    const data = await this.http.request("POST", "/client/v4/zones", {
      body: { account: { id: this.requireAccountId() }, name: domain, type: "full" },
    });
    return this.parse(zoneSchema, data, true);
  }

  async listDns(zoneId: string, name?: string): Promise<DnsRecord[]> {
    const query: Record<string, string> = {};
    if (name) query.name = name;
    return this.listPaginated(z.array(dnsRecordSchema), `/client/v4/zones/${encodeURIComponent(zoneId)}/dns_records`, query, 100);
  }

  async getDns(zoneId: string, recordId: string): Promise<DnsRecord> {
    const data = await this.http.request(
      "GET",
      `/client/v4/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`,
    );
    const record = this.parse(dnsRecordSchema, data, false);
    if (record.id !== recordId) {
      throw new ProviderError("PROVIDER_RESPONSE_INVALID", "Cloudflare returned an unexpected response.", undefined, false);
    }
    return record;
  }

  async createDns(
    zoneId: string,
    record: { type: string; name: string; content: string; ttl: number; proxied: boolean },
  ): Promise<DnsRecord> {
    const data = await this.http.request("POST", `/client/v4/zones/${encodeURIComponent(zoneId)}/dns_records`, {
      body: { type: record.type, name: record.name, content: record.content, ttl: record.ttl, proxied: record.proxied },
    });
    return this.parse(dnsRecordSchema, data, true);
  }

  async updateDns(
    zoneId: string,
    recordId: string,
    record: { type: string; name: string; content: string; ttl: number; proxied: boolean },
  ): Promise<DnsRecord> {
    const data = await this.http.request(
      "PUT",
      `/client/v4/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`,
      { body: { type: record.type, name: record.name, content: record.content, ttl: record.ttl, proxied: record.proxied } },
    );
    return this.parse(dnsRecordSchema, data, true);
  }
}
