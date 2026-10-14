import assert from "node:assert/strict";
import test from "node:test";

const { ProviderHttp, ProviderError } = await import("../dist/providers/http.js");
const { VercelProvider } = await import("../dist/providers/vercel.js");
const { SupabaseProvider } = await import("../dist/providers/supabase.js");
const { CloudflareProvider } = await import("../dist/providers/cloudflare.js");

const TOKEN = "synthetic-token-sentinel";

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, init });
    return handler(url, init, calls.length);
  };
  return { impl, calls };
}

function errCode(err) {
  return err && err.code;
}

test("ProviderHttp applies auth, redirect and timeout policy", async () => {
  const { impl, calls } = fakeFetch(() => json({ ok: true }));
  const http = new ProviderHttp("https://api.vercel.com", TOKEN, impl);
  const result = await http.request("GET", "/v9/projects/abc", { query: { teamId: "team_1" } });
  assert.deepStrictEqual(result, { ok: true });
  const call = calls[0];
  assert.strictEqual(call.url, "https://api.vercel.com/v9/projects/abc?teamId=team_1");
  assert.strictEqual(call.init.headers.authorization, `Bearer ${TOKEN}`);
  assert.strictEqual(call.init.redirect, "error");

  const noToken = new ProviderHttp("https://api.vercel.com", undefined, impl);
  await assert.rejects(() => noToken.request("GET", "/x"), (e) => errCode(e) === "MISSING_CREDENTIAL");

  await assert.rejects(
    () => http.request("GET", "//evil.example.com/x"),
    (e) => errCode(e) === "INTERNAL_ERROR",
  );
});

test("ProviderHttp retries only read requests and bounds failures", async () => {
  let getCalls = 0;
  const retrying = fakeFetch(() => {
    getCalls += 1;
    return getCalls < 3 ? json({ err: true }, 503) : json({ ok: true });
  });
  const http = new ProviderHttp("https://api.vercel.com", TOKEN, retrying.impl);
  assert.deepStrictEqual(await http.request("GET", "/x"), { ok: true });
  assert.strictEqual(getCalls, 3);

  let postCalls = 0;
  const posting = fakeFetch(() => {
    postCalls += 1;
    return json({ err: true }, 503);
  });
  const mutating = new ProviderHttp("https://api.vercel.com", TOKEN, posting.impl);
  await assert.rejects(
    () => mutating.request("POST", "/x", { body: {} }),
    (e) => errCode(e) === "PROVIDER_REQUEST_FAILED" && e.ambiguous === true,
  );
  assert.strictEqual(postCalls, 1);

  const authFail = fakeFetch(() => json({ token: TOKEN, leaked: "raw-body-secret" }, 401));
  await assert.rejects(
    () => new ProviderHttp("https://api.vercel.com", TOKEN, authFail.impl).request("GET", "/x"),
    (e) =>
      errCode(e) === "AUTH_REQUIRED" &&
      !e.message.includes(TOKEN) &&
      !e.message.includes("raw-body-secret"),
  );

  let rateCalls = 0;
  const rateLimited = fakeFetch(() => {
    rateCalls += 1;
    return json({}, 429, { "retry-after": "0" });
  });
  await assert.rejects(
    () => new ProviderHttp("https://api.vercel.com", TOKEN, rateLimited.impl).request("GET", "/x"),
    (e) => errCode(e) === "RATE_LIMITED",
  );
  assert.strictEqual(rateCalls, 3);
});

test("ProviderHttp validates responses and honors timeouts", async () => {
  const badJson = new ProviderHttp("https://api.vercel.com", TOKEN, fakeFetch(() => new Response("not json", { status: 200 })).impl);
  await assert.rejects(() => badJson.request("GET", "/x"), (e) => errCode(e) === "PROVIDER_RESPONSE_INVALID");

  const huge = new ProviderHttp(
    "https://api.vercel.com",
    TOKEN,
    fakeFetch(() => new Response(Buffer.alloc(2 * 1024 * 1024 + 1), { status: 200 })).impl,
  );
  await assert.rejects(() => huge.request("GET", "/x"), (e) => errCode(e) === "PROVIDER_RESPONSE_INVALID");

  const empty = new ProviderHttp("https://api.vercel.com", TOKEN, fakeFetch(() => new Response(null, { status: 204 })).impl);
  await assert.rejects(() => empty.request("GET", "/x"), (e) => errCode(e) === "PROVIDER_RESPONSE_INVALID");
  assert.strictEqual(await empty.request("POST", "/x", { allowEmpty: true }), undefined);

  const hanging = new ProviderHttp(
    "https://api.vercel.com",
    TOKEN,
    ((_url, init) =>
      new Promise((_, reject) => {
        init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })),
    30,
  );
  await assert.rejects(
    () => hanging.request("POST", "/x", { body: {} }),
    (e) => errCode(e) === "PROVIDER_REQUEST_FAILED" && e.ambiguous === true,
  );

  const redirecting = new ProviderHttp(
    "https://api.vercel.com",
    TOKEN,
    fakeFetch(() => {
      throw new TypeError("unexpected redirect");
    }).impl,
  );
  await assert.rejects(
    () => redirecting.request("POST", "/x", { body: {} }),
    (e) => errCode(e) === "PROVIDER_REQUEST_FAILED" && e.ambiguous === true,
  );
});

test("VercelProvider routes, scoping and safe responses", async () => {
  const routes = {
    "GET /v2/teams/team_1": () => json({ id: "team_1", billing: { plan: "pro" } }),
    "GET /v9/projects/my-app": () => json({ id: "prj_1", name: "my-app", accountId: "team_1" }),
  };
  const { impl, calls } = fakeFetch((url, init) => {
    const key = `${init.method ?? "GET"} ${new URL(url).pathname}`;
    return routes[key] ? routes[key]() : json({ error: "not found" }, 404);
  });
  const provider = new VercelProvider({ vercelToken: TOKEN, vercelTeamId: "team_1" }, impl);
  assert.deepStrictEqual(await provider.team(), { id: "team_1", plan: "pro" });
  assert.deepStrictEqual(await provider.findProject("nope"), undefined);
  const project = await provider.getProject("my-app");
  assert.strictEqual(project.id, "prj_1");
  assert.ok(calls.every((call) => new URL(call.url).searchParams.get("teamId") === "team_1"));

  const wrongAccount = new VercelProvider(
    { vercelToken: TOKEN, vercelTeamId: "team_1" },
    fakeFetch((url) => {
      const p = new URL(url).pathname;
      if (p === "/v9/projects/other") return json({ id: "prj_2", name: "other", accountId: "team_other" });
      return json({ id: "team_1", billing: { plan: "pro" } });
    }).impl,
  );
  await assert.rejects(() => wrongAccount.getProject("other"), (e) => errCode(e) === "ACCOUNT_MISMATCH");

  const envFail = new VercelProvider(
    { vercelToken: TOKEN, vercelTeamId: "team_1" },
    fakeFetch(() => json({ failed: [{ key: "API_KEY", error: { code: "x" } }] }, 200)).impl,
  );
  await assert.rejects(
    () => envFail.upsertEnv("prj_1", { API_KEY: "v" }, ["production"]),
    (e) => errCode(e) === "PARTIAL_PROVIDER_FAILURE" && e.ambiguous === true,
  );

  const deployCalls = fakeFetch((url, init) => {
    const p = new URL(url).pathname;
    if (p === "/v13/deployments") {
      const body = JSON.parse(init.body);
      return json({ id: "dpl_1", url: "evil.example.com", readyState: "BUILDING", _sentinel: TOKEN });
    }
    return json({});
  });
  const deployProvider = new VercelProvider({ vercelToken: TOKEN, vercelTeamId: "team_1" }, deployCalls.impl);
  const deployment = await deployProvider.deploy({
    name: "my-app",
    project: "prj_1",
    target: "preview",
    files: [{ file: "index.html", sha: "abc", size: 3 }],
    operationId: "op-1",
  });
  assert.strictEqual(deployment.url, undefined);
  const body = JSON.parse(deployCalls.calls[0].init.body);
  assert.strictEqual(body.target, undefined);
  assert.strictEqual(body.meta.mcpDevopsOperationId, "op-1");
  assert.ok(!JSON.stringify(deployment).includes(TOKEN));
});

test("SupabaseProvider create body and api keys", async () => {
  const { impl, calls } = fakeFetch((url, init) => {
    const p = new URL(url).pathname;
    if (p === "/v1/organizations/org-slug") return json({ id: "org_1", name: "Org", plan: "pro" });
    if (p === "/v1/projects/available-regions") return json({ all: { specific: [{ code: "us-east-1" }] } });
    if (p === "/v1/projects" && init.method === "GET") return json([]);
    if (p === "/v1/projects" && init.method === "POST") {
      const body = JSON.parse(init.body);
      return json({ id: "abcdefghijklmnopqrst", name: body.name, status: "COMING_UP" });
    }
    if (p.endsWith("/api-keys")) return json([{ name: "anon", api_key: "anon-key" }]);
    return json({ error: "not found" }, 404);
  });
  const provider = new SupabaseProvider({ supabaseToken: TOKEN }, impl);
  assert.deepStrictEqual(await provider.regions("org-slug"), ["us-east-1"]);
  const created = await provider.createProject({
    name: "db-proj",
    organizationSlug: "org-slug",
    region: "us-east-1",
    plan: "pro",
    password: "synthetic-db-pass",
  });
  const posted = JSON.parse(calls.find((call) => call.init.method === "POST").init.body);
  assert.deepStrictEqual(posted.region_selection, { type: "specific", code: "us-east-1" });
  assert.strictEqual(posted.db_pass, "synthetic-db-pass");
  assert.strictEqual(posted.desired_instance_size, "micro");
  assert.strictEqual(posted.plan, undefined);
  assert.strictEqual(created.ref, "abcdefghijklmnopqrst");
  const keys = await provider.getApiKeys("abcdefghijklmnopqrst");
  assert.strictEqual(keys[0].apiKey, "anon-key");
});

test("CloudflareProvider envelope handling, pagination and registrar routes", async () => {
  const pages = { zonePages: 2 };
  const { impl, calls } = fakeFetch((url, init) => {
    const u = new URL(url);
    const p = u.pathname;
    if (p === "/client/v4/accounts/acc_1") return json({ success: true, result: { id: "acc_1", name: "Acct" } });
    if (p === "/client/v4/zones") {
      const page = Number(u.searchParams.get("page"));
      return json({
        success: true,
        result: page === 1 ? [{ id: "z1", name: "example.com", status: "pending", account: { id: "acc_1" } }] : [{ id: "z2", name: "other.com", status: "active", account: { id: "acc_1" } }],
        result_info: { total_pages: pages.zonePages },
      });
    }
    if (p.endsWith("/registrar/domain-check")) {
      const body = JSON.parse(init.body);
      return json({ success: true, result: { domains: [{ name: body.domains[0], registrable: true, tier: "standard", pricing: { currency: "USD", registration_cost: "8.57", renewal_cost: "10.11" } }] } });
    }
    if (p.endsWith("/registrar/registrations")) {
      return json({ success: true, result: { domain_name: "example.com", state: "running", completed: false } }, 202);
    }
    return json({ success: false, errors: [{ code: 1000 }] }, 200);
  });
  const provider = new CloudflareProvider({ cloudflareToken: TOKEN, cloudflareAccountId: "acc_1" }, impl);
  const account = await provider.account();
  assert.strictEqual(account.id, "acc_1");
  const zones = await provider.listZones();
  assert.strictEqual(zones.length, 2);
  assert.strictEqual(calls.filter((call) => new URL(call.url).pathname === "/client/v4/zones").length, 2);

  const offer = await provider.checkDomain("example.com");
  assert.strictEqual(offer.registrable, true);
  assert.strictEqual(offer.pricing.currency, "USD");

  const registration = await provider.registerDomain("example.com", 2);
  assert.strictEqual(registration.state, "running");
  assert.strictEqual(registration.completed, false);
  const registerBody = JSON.parse(calls.at(-1).init.body);
  assert.strictEqual(registerBody.auto_renew, false);
  assert.strictEqual(registerBody.years, 2);

  const failEnvelope = new CloudflareProvider(
    { cloudflareToken: TOKEN, cloudflareAccountId: "acc_1" },
    fakeFetch(() => json({ success: false, errors: [{ message: `leaked ${TOKEN}` }] })).impl,
  );
  await assert.rejects(
    () => failEnvelope.account(),
    (e) => errCode(e) === "PROVIDER_REQUEST_FAILED" && !e.message.includes(TOKEN),
  );
});

test("upsertEnv requires confirmed coverage of every requested key", async () => {
  const body = (result, status = 200) =>
    fakeFetch((url, init) => {
      if (url.includes("/env")) return json(result, status);
      return json({}, 404);
    }).impl;
  const make = (impl) => new VercelProvider({ vercelToken: TOKEN, vercelTeamId: "team_1" }, impl);
  const values = { API_KEY: "x", OTHER_KEY: "y" };

  await assert.rejects(
    () => make(body({ failed: [{ key: "API_KEY" }] }, 201)).upsertEnv("prj_1", values, ["production"]),
    (e) => errCode(e) === "PARTIAL_PROVIDER_FAILURE" && e.ambiguous === true,
  );
  await assert.rejects(
    () => make(body({}, 201)).upsertEnv("prj_1", values, ["production"]),
    (e) => errCode(e) === "PROVIDER_RESPONSE_INVALID" && e.ambiguous === true,
  );
  await assert.rejects(
    () => make(body({ failed: [], created: [{ key: "API_KEY" }] }, 201)).upsertEnv("prj_1", values, ["production"]),
    (e) => errCode(e) === "PROVIDER_RESPONSE_INVALID" && e.ambiguous === true,
  );
  const keys = await make(body({ failed: [], created: [{ key: "OTHER_KEY" }, { key: "API_KEY" }] }, 201)).upsertEnv(
    "prj_1",
    values,
    ["production"],
  );
  assert.deepStrictEqual(keys, ["API_KEY", "OTHER_KEY"]);
});

test("listDeployments normalizes uid and stops on stuck pagination", async () => {
  const { impl } = fakeFetch((url) => {
    const u = new URL(url);
    if (u.pathname === "/v7/deployments") {
      const until = u.searchParams.get("until");
      return json({
        deployments:
          until === null
            ? [{ uid: "dpl_a", url: null, readyState: "READY", meta: { mcpDevopsOperationId: "op-1" } }]
            : [{ uid: "dpl_b", readyState: "BUILDING" }],
        pagination: { next: until === null ? 42 : null },
      });
    }
    return json({}, 404);
  });
  const provider = new VercelProvider({ vercelToken: TOKEN, vercelTeamId: "team_1" }, impl);
  const deployments = await provider.listDeployments("prj_1");
  assert.deepStrictEqual(deployments, [
    { id: "dpl_a", operationId: "op-1", readyState: "READY" },
    { id: "dpl_b", operationId: undefined, readyState: "BUILDING" },
  ]);

  const stuck = new VercelProvider(
    { vercelToken: TOKEN, vercelTeamId: "team_1" },
    fakeFetch(() =>
      json({ deployments: [{ uid: "dpl_x", readyState: "READY" }], pagination: { next: 100 } }),
    ).impl,
  );
  await assert.rejects(() => stuck.listDeployments("prj_1"), (e) => errCode(e) === "PAGINATION_LIMIT");

  const emptyWithNext = new VercelProvider(
    { vercelToken: TOKEN, vercelTeamId: "team_1" },
    fakeFetch(() => json({ deployments: [], pagination: { next: 100 } })).impl,
  );
  await assert.rejects(() => emptyWithNext.listDeployments("prj_1"), (e) => errCode(e) === "PAGINATION_LIMIT");
});

test("ProviderHttp rejects redirects and oversized streamed bodies", async () => {
  const redirect = new ProviderHttp(
    "https://api.vercel.com",
    TOKEN,
    fakeFetch(() => new Response("", { status: 302, headers: { location: "https://evil.example" } })).impl,
  );
  await assert.rejects(() => redirect.request("GET", "/x"), (e) => errCode(e) === "PROVIDER_REQUEST_FAILED" && e.status === 302);

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(2 * 1024 * 1024));
      controller.enqueue(new Uint8Array(16));
      controller.close();
    },
  });
  const large = new ProviderHttp(
    "https://api.vercel.com",
    TOKEN,
    fakeFetch(() => new Response(stream, { status: 200 })).impl,
  );
  await assert.rejects(() => large.request("GET", "/x"), (e) => errCode(e) === "PROVIDER_RESPONSE_INVALID");
});

test("SupabaseProvider normalizes ref over id and validates identity", async () => {
  const refOnly = new SupabaseProvider(
    { supabaseToken: TOKEN },
    fakeFetch(() => json({ ref: "abcdefghijklmnopqrst", name: "db", status: "ACTIVE_HEALTHY" })).impl,
  );
  const project = await refOnly.getProject("abcdefghijklmnopqrst");
  assert.strictEqual(project.ref, "abcdefghijklmnopqrst");

  const differentId = new SupabaseProvider(
    { supabaseToken: TOKEN },
    fakeFetch(() => json({ id: "lorem", ref: "abcdefghijklmnopqrst", name: "db" })).impl,
  );
  assert.strictEqual((await differentId.getProject("abcdefghijklmnopqrst")).ref, "abcdefghijklmnopqrst");

  const mismatched = new SupabaseProvider(
    { supabaseToken: TOKEN },
    fakeFetch(() => json({ ref: "zzzzzzzzzzzzzzzzzzzz", name: "db" })).impl,
  );
  await assert.rejects(() => mismatched.getProject("abcdefghijklmnopqrst"), (e) => errCode(e) === "PROVIDER_RESPONSE_INVALID");

  const { impl, calls } = fakeFetch((url, init) => {
    const sent = JSON.parse(init.body);
    return json({ ref: "abcdefghijklmnopqrst", name: "other-name", organization_slug: sent.organization_slug }, 201);
  });
  const create = new SupabaseProvider({ supabaseToken: TOKEN }, impl);
  await assert.rejects(
    () => create.createProject({ name: "db", organizationSlug: "org", region: "us-east-1", plan: "free", password: "x" }),
    (e) => errCode(e) === "PROVIDER_RESPONSE_INVALID" && e.ambiguous === true,
  );
  assert.strictEqual(calls.length, 1);
});

test("CloudflareProvider validates zone ownership and registration shapes", async () => {
  const creds = { cloudflareToken: TOKEN, cloudflareAccountId: "acc_1" };
  const noAccount = new CloudflareProvider(
    creds,
    fakeFetch(() => json({ success: true, result: { id: "z1", name: "example.com" } })).impl,
  );
  await assert.rejects(() => noAccount.getZone("z1"), (e) => errCode(e) === "PROVIDER_RESPONSE_INVALID");

  const wrongAccount = new CloudflareProvider(
    creds,
    fakeFetch(() => json({ success: true, result: { id: "z1", name: "example.com", account: { id: "acc_2" } } })).impl,
  );
  await assert.rejects(() => wrongAccount.getZone("z1"), (e) => errCode(e) === "ACCOUNT_MISMATCH");

  const provider = new CloudflareProvider(
    creds,
    fakeFetch((url) => {
      if (url.endsWith("/registration-status")) return json({ success: true, result: { state: "succeeded", completed: true } });
      return json({ success: true, result: { domain_name: "example.com", status: "active", expires_at: null, auto_renew: false } });
    }).impl,
  );
  const registration = await provider.getRegistration("example.com");
  assert.strictEqual(registration.status, "active");
  assert.strictEqual(registration.expiresAt, null);
  const workflow = await provider.registrationStatus("example.com");
  assert.strictEqual(workflow.state, "succeeded");
  await assert.rejects(
    () =>
      new CloudflareProvider(
        creds,
        fakeFetch(() => json({ success: true, result: { domain_name: "other.com", status: "active" } })).impl,
      ).getRegistration("example.com"),
    (e) => errCode(e) === "PROVIDER_RESPONSE_INVALID",
  );
});

test("getDeployment strips unsafe urls", async () => {
  for (const bad of ["https://user:secret@app.vercel.app", "https://app.vercel.app:8443/x", "http://app.vercel.app"]) {
    const provider = new VercelProvider(
      { vercelToken: TOKEN, vercelTeamId: "team_1" },
      fakeFetch(() => json({ id: "dpl_1", url: bad, readyState: "READY" })).impl,
    );
    const deployment = await provider.getDeployment("dpl_1");
    assert.strictEqual(deployment.url, undefined, bad);
  }
  const good = new VercelProvider(
    { vercelToken: TOKEN, vercelTeamId: "team_1" },
    fakeFetch(() => json({ id: "dpl_1", url: "https://app.vercel.app", readyState: "READY" })).impl,
  );
  assert.ok((await good.getDeployment("dpl_1")).url.startsWith("https://app.vercel.app"));
});

test("ProviderHttp honors precancelled signals and times out during body streaming", async () => {
  let fetchCalls = 0;
  const counting = fakeFetch(() => {
    fetchCalls += 1;
    return json({ ok: true });
  });
  const aborted = new AbortController();
  aborted.abort();
  const precancelled = new ProviderHttp("https://api.vercel.com", TOKEN, counting.impl, 15000, aborted.signal);
  await assert.rejects(() => precancelled.request("GET", "/x"), (e) => errCode(e) === "CANCELLED");
  assert.strictEqual(fetchCalls, 0);

  const stalledBody = fakeFetch(
    () =>
      new Response(
        new ReadableStream({
          start() {},
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );
  const slow = new ProviderHttp("https://api.vercel.com", TOKEN, stalledBody.impl, 30);
  const started = Date.now();
  await assert.rejects(() => slow.request("GET", "/x"), (e) => errCode(e) === "PROVIDER_RESPONSE_INVALID");
  assert.ok(Date.now() - started < 5000, "delayed body did not time out");

  const caller = new AbortController();
  const delayed = fakeFetch(() => {
    caller.abort();
    return json({ ok: true });
  });
  const cancellable = new ProviderHttp("https://api.vercel.com", TOKEN, delayed.impl, 15000, caller.signal);
  await assert.rejects(() => cancellable.request("POST", "/x", { body: {} }), (e) => errCode(e) === "CANCELLED");
});

test("cloudflare domain reasons use the documented enum and unknown values map safely", async () => {
  const offers = [];
  const impl = fakeFetch(() =>
    json({ success: true, result: { domains: offers } }),
  );
  const provider = new CloudflareProvider({ cloudflareToken: TOKEN, cloudflareAccountId: "acc_1" }, impl.impl);

  offers.length = 0;
  offers.push({ name: "taken.com", registrable: false, reason: "domain_unavailable" });
  offers.push({ name: "premium.example", registrable: false, reason: "domain_premium" });
  offers.push({ name: "weird.example", registrable: false, reason: "something_new" });
  const result = await provider.searchDomains("example", 5);
  assert.deepStrictEqual(
    result.map((offer) => offer.reason),
    ["domain_unavailable", "domain_premium", "unknown"],
  );
});

test("cloudflare listings fail closed when a full page lacks pagination metadata", async () => {
  const records = Array.from({ length: 100 }, (_, i) => ({
    id: `rec_${i}`,
    type: "A",
    name: "www.example.com",
    content: "192.0.2.1",
    ttl: 300,
    proxied: false,
  }));
  const impl = fakeFetch(() => json({ success: true, result: records }));
  const provider = new CloudflareProvider({ cloudflareToken: TOKEN, cloudflareAccountId: "acc_1" }, impl.impl);
  await assert.rejects(() => provider.listDns("zone_1", "www.example.com"), (e) => errCode(e) === "PAGINATION_LIMIT");
});
