import assert from "node:assert/strict";
import { test } from "node:test";
import { DomainMarketplace } from "../dist/v2/domains.js";
import { discover } from "../dist/v2/discovery.js";
import { manifestSchema, preparedSchema } from "../dist/v2/schema.js";
import { probeHttps } from "../dist/v2/health.js";

const manifest = (id) => manifestSchema.parse({ protocolVersion: 2, id, name: id, version: "2.0.0", tier: "executable", capabilities: ["registrar"], runtimes: [], frameworks: [], regions: [], compliance: [], commercialUse: "allowed", reliability: "production", credentials: [], accountSettings: [], operations: ["register_domain"], teardown: false, reconciliation: "idempotency", pricing: { monthlyCents: 0, upfrontCents: 100, reviewedAt: "2026-10-14", source: "https://example.com/prices", assumptions: [] }, documentation: ["https://example.com/docs"], limits: [] });
const quote = (registrar, overrides = {}) => ({ registrar, domain: "example.test", years: 2, available: true, eligible: true, currency: "USD", registrationCents: 2000, renewalCents: 1200, premiumCents: 0, privacyCents: 0, tax: "included", autoRenew: false, priceEnforced: true, idempotency: true, requirements: [], quotedAt: new Date().toISOString(), ...overrides });
test("registrar queries run concurrently and rank eligibility, certainty, safety and term plus renewal", async () => {
  const ids = ["uncertain", "safe", "ineligible"];
  let started = 0; let release; const gate = new Promise((r) => { release = r; });
  const registry = {
    manifests: new Map(ids.map((id) => [id, manifest(id)])), missing: () => [],
    get(id) { return this.manifests.get(id); },
    adapters: new Map(ids.map((id) => [id, { invoke: async () => { started++; if (started === 3) release(); await gate; return [quote(id, id === "uncertain" ? { tax: "unknown", registrationCents: 100 } : id === "ineligible" ? { eligible: false } : {})]; } }])),
  };
  const result = await new DomainMarketplace(registry, {}).query("example.test", undefined, 2, false);
  assert.equal(started, 3); assert.deepEqual(result.quotes.map((q) => q.registrar), ["safe", "uncertain", "ineligible"]);
});
test("mismatched registrar terms are rejected without suppressing other quotes", async () => {
  const ids = ["good", "wrong-term"];
  const registry = { manifests: new Map(ids.map((id) => [id, manifest(id)])), missing: () => [], get(id) { return this.manifests.get(id); }, adapters: new Map(ids.map((id) => [id, { invoke: async () => [quote(id, id === "wrong-term" ? { years: 1 } : {})] }])) };
  const result = await new DomainMarketplace(registry, {}).query("example.test", ids, 2, false);
  assert.equal(result.quotes.length, 1); assert.deepEqual(result.errors, [{ registrar: "wrong-term", code: "INVALID_ADAPTER_RESPONSE" }]);
});
test("live discovery is opt-in, GET-only and never promotes discovered code", async () => {
  const registry = { manifests: new Map([["known", manifest("known")]]) };
  const config = { discoverySources: ["https://example.com/catalog.json"] }; let calls = 0;
  const fetchImpl = async (url, init) => { calls++; assert.equal(init.method, "GET"); assert.equal(init.credentials, "omit"); assert.equal(init.redirect, "error"); assert.equal(init.body, undefined); assert.equal(init.headers.authorization, undefined); return new Response(JSON.stringify([manifest("new-provider")])); };
  await discover(registry, config, ["registrar"], false, fetchImpl); assert.equal(calls, 0);
  const result = await discover(registry, config, ["registrar"], true, fetchImpl);
  assert.equal(calls, 1); const found = result.providers.find((m) => m.id === "new-provider"); assert.equal(found.tier, "advisory"); assert.deepEqual(found.operations, []); assert.equal(registry.manifests.has("new-provider"), false);
});
test("discovery rejects off-origin catalogs and HTTPS probes reject private or credentialed URLs", async () => {
  const registry = { manifests: new Map([["known", manifest("known")]]) };
  const result = await discover(registry, { discoverySources: ["https://untrusted.invalid/catalog.json"] }, [], true, () => { throw new Error("must not request untrusted source"); });
  assert.equal(result.errors[0].code, "UNTRUSTED_DISCOVERY_SOURCE");
  for (const url of ["https://127.0.0.1/", "https://169.254.169.254/", "http://example.test/", "https://user:secret@example.test/", "https://example.test/?token=private"]) assert.equal((await probeHttps(url)).status, "unverified");
});
test("native preparations can preserve bounded deployment manifests exceeding 128 files", () => {
  const p = preparedSchema.safeParse({ account: "team_1", mutations: [{ action: "deploy", target: "application", details: "Bounded source manifest" }], estimate: { recurring: [], upfrontCents: 0, reviewedAt: "2026-10-14", source: "https://example.com", assumptions: [] }, preconditions: { manifest: { files: Array.from({ length: 500 }, (_, i) => ({ file: `src/${i}.js`, sha: "a".repeat(40), size: 1 })) } }, expiresAt: new Date(Date.now() + 300_000).toISOString() });
  assert.equal(p.success, true);
});
