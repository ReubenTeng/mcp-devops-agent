import { randomUUID } from "node:crypto";
import { AppError } from "../errors.js";
import { decimalUsdToCents } from "../utils/budget.js";
import { quoteSchema, type DomainQuote } from "./schema.js";
import type { Registry } from "./registry.js";
import type { NativeBridge } from "./native.js";

export class DomainMarketplace {
  constructor(readonly registry: Registry, readonly native: NativeBridge) {}
  async query(query: string, registrars: string[] | undefined, years: number, search: boolean): Promise<object> {
    const selected = registrars ?? [...this.registry.manifests.values()].filter((m) => m.tier === "executable" && m.capabilities.includes("registrar")).map((m) => m.id);
    if (selected.length > 16 || new Set(selected).size !== selected.length) throw new AppError("INVALID_REGISTRARS", "Select at most sixteen distinct registrars.");
    const results = await Promise.allSettled(selected.map(async (id): Promise<DomainQuote[]> => {
      const m = this.registry.get(id);
      if (m.tier !== "executable" || !m.capabilities.includes("registrar")) throw new AppError("ADAPTER_UNAVAILABLE", "Install an executable registrar adapter first.");
      if (this.registry.missing(id).length) throw new AppError("SETUP_REQUIRED", "The registrar requires credentials and account setup.");
      if (id === "cloudflare") {
        const raw = search ? await this.native.service.searchDomains(query, 10) as { offers: { name: string; registrable: boolean; pricing?: { currency: string; registrationCost: string; renewalCost: string } }[] } : await this.native.service.checkDomainAvailability(query) as { domain: string; registrable: boolean; pricing?: { currency: string; registrationCost: string; renewalCost: string } };
        const offers = "offers" in raw ? raw.offers : [{ ...raw, name: raw.domain }];
        return offers.map((o) => ({ registrar: id, domain: o.name, years, available: o.registrable, eligible: o.registrable, currency: "USD", registrationCents: o.pricing?.currency === "USD" ? decimalUsdToCents(o.pricing.registrationCost) + decimalUsdToCents(o.pricing.renewalCost) * (years - 1) : null, renewalCents: o.pricing?.currency === "USD" ? decimalUsdToCents(o.pricing.renewalCost) : null, premiumCents: null, privacyCents: null, tax: "unknown", autoRenew: false, priceEnforced: false, idempotency: false, requirements: ["Cloudflare billing, contact information and agreements must already be configured.", "Tax, premium and privacy components are not separately quoted by this adapter."], quotedAt: new Date().toISOString() }));
      }
      const raw = await this.registry.adapters.get(id)?.invoke({ protocolVersion: 2, method: search ? "search" : "quote", operationId: randomUUID(), operation: search ? "search_domains" : "quote_domain", parameters: { [search ? "query" : "domain"]: query, years } });
      const parsed = quoteSchema.array().max(64).safeParse(raw);
      if (!parsed.success || parsed.data.some((q) => q.registrar !== id || q.years !== years || (!search && q.domain !== query))) throw new AppError("INVALID_ADAPTER_RESPONSE", "The registrar quote did not match the requested domain and term.");
      return parsed.data;
    }));
    const quotes: DomainQuote[] = []; const errors: { registrar: string; code: string }[] = [];
    results.forEach((r, i) => r.status === "fulfilled" ? quotes.push(...r.value) : errors.push({ registrar: selected[i]!, code: r.reason instanceof AppError ? r.reason.code : "INTERNAL_ERROR" }));
    const certain = (q: DomainQuote) => q.registrationCents !== null && q.renewalCents !== null && q.tax === "included" && q.premiumCents !== null && q.privacyCents !== null;
    const cost = (q: DomainQuote) => q.registrationCents === null || q.renewalCents === null ? Infinity : q.registrationCents + q.renewalCents + (q.privacyCents ?? 0) + (q.premiumCents ?? 0);
    quotes.sort((a, b) => Number(b.available && b.eligible) - Number(a.available && a.eligible) || Number(certain(b)) - Number(certain(a)) || Number(b.idempotency && b.priceEnforced) - Number(a.idempotency && a.priceEnforced) || cost(a) - cost(b) || a.registrar.localeCompare(b.registrar) || a.domain.localeCompare(b.domain));
    return { quotes, errors, ranking: "Eligibility, price certainty, mutation safety, then requested-term registration plus one renewal.", warning: "Quotes are estimates, not reservations. Purchase requires separate preparation and approval." };
  }
}
