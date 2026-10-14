import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, link, mkdtemp, mkdir, readFile, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after } from "node:test";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const { createServer } = await import("../dist/server.js");

const TOKEN = "synthetic-token-sentinel";
const SECRET_VALUE = "synthetic-test-secret";
const tempDirs = [];

after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function makeFetch(handlers) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    calls.push({ url: u.toString(), path: u.pathname, method, body: init.body ? String(init.body) : undefined, headers: init.headers });
    const handler = handlers[`${method} ${u.pathname}`];
    if (!handler) return json({ error: "unrouted" }, 404);
    return handler(u, init, calls.length);
  };
  return { impl, calls };
}

const CREDS = {
  vercelToken: TOKEN,
  vercelTeamId: "team_1",
  supabaseToken: TOKEN,
  cloudflareToken: TOKEN,
  cloudflareAccountId: "acc_1",
};

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), "mcp-ops-"));
  tempDirs.push(root);
  const project = join(root, "app");
  await mkdir(project, { recursive: true });
  await writeFile(join(project, "package.json"), JSON.stringify({ name: "app" }));
  await writeFile(join(project, "index.html"), "<html></html>");
  const stateDir = join(root, "state");
  return { root, project, stateDir };
}

async function withClient({ fixture, fetchImpl, approve, elicitation = true, roots, creds }, fn) {
  const config = { projectRoots: roots ?? [fixture.root], stateDir: fixture.stateDir, credentials: creds ?? CREDS };
  const server = createServer(config, { fetch: fetchImpl });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "ops-test", version: "0.1.0" },
    { capabilities: elicitation ? { elicitation: { form: {} } } : {} },
  );
  const approvalRequests = [];
  if (elicitation) {
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      approvalRequests.push(request.params);
      if (typeof approve === "function") {
        const outcome = await approve(request.params);
        if (outcome === "decline") return { action: "decline" };
        return { action: "accept", content: { approve: true } };
      }
      return approve ? { action: "accept", content: { approve: true } } : { action: "decline" };
    });
  }
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    await fn({ client, approvalRequests });
  } finally {
    await client.close();
    await server.close();
  }
}

const vercelRoutes = {
  "GET /v2/teams/team_1": () => json({ id: "team_1", billing: { plan: "pro" } }),
  "GET /v9/projects/my-app": () => json({ error: "not found" }, 404),
  "POST /v11/projects": (_u, init) => json({ id: "prj_new", name: JSON.parse(init.body).name }),
};

const supabaseRoutes = {
  "GET /v1/organizations/org-slug": () => json({ id: "org_1", name: "Org", plan: "pro" }),
  "GET /v1/projects/available-regions": () => json({ all: { specific: [{ code: "us-east-1" }] } }),
  "GET /v1/projects": () => json([]),
  "POST /v1/projects": (_u, init) =>
    json({ id: "lorem", ref: "abcdefghijklmnopqrst", name: JSON.parse(init.body).name, status: "ACTIVE_HEALTHY", organization_id: "org_1", created_at: new Date().toISOString() }),
};

function resultData(res) {
  return JSON.parse(res.content.find((b) => b.type === "text").text);
}

test("prepare then decline performs no remote mutation", async () => {
  const fixture = await makeFixture();
  const { impl, calls } = makeFetch(vercelRoutes);
  await withClient({ fixture, fetchImpl: impl, approve: false }, async ({ client }) => {
    const prep = await client.callTool({
      name: "prepare_infrastructure_change",
      arguments: {
        projectPath: fixture.project,
        action: { kind: "create_vercel_project", name: "my-app", framework: "nextjs" },
        maxMonthlyBudgetUsd: 50,
        commercialUse: true,
      },
    });
    const prepared = resultData(prep);
    assert.ok(prepared.operationId);
    assert.strictEqual(prepared.estimate.estimatedMonthlyCostUsd, 20);

    const exec = await client.callTool({ name: "execute_infrastructure_change", arguments: { operationId: prepared.operationId } });
    assert.strictEqual(exec.isError, true);
    assert.strictEqual(resultData(exec).error.code, "APPROVAL_DECLINED");
    assert.strictEqual(calls.filter((c) => c.method === "POST").length, 0);

    const status = await client.callTool({ name: "get_operation", arguments: { operationId: prepared.operationId } });
    assert.strictEqual(resultData(status).status, "cancelled");
  });
});

test("approved create_vercel_project performs exactly one POST and stores safe state", async () => {
  const fixture = await makeFixture();
  const { impl, calls } = makeFetch(vercelRoutes);
  await withClient({ fixture, fetchImpl: impl, approve: true }, async ({ client, approvalRequests }) => {
    const prep = resultData(
      await client.callTool({
        name: "prepare_infrastructure_change",
        arguments: {
          projectPath: fixture.project,
          action: { kind: "create_vercel_project", name: "my-app", framework: null },
          maxMonthlyBudgetUsd: 50,
          commercialUse: true,
        },
      }),
    );
    const exec = resultData(
      await client.callTool({ name: "execute_infrastructure_change", arguments: { operationId: prep.operationId } }),
    );
    assert.strictEqual(exec.status, "succeeded");
    assert.strictEqual(exec.result.projectId, "prj_new");
    const posts = calls.filter((c) => c.method === "POST" && c.path === "/v11/projects");
    assert.strictEqual(posts.length, 1);
    assert.deepStrictEqual(JSON.parse(posts[0].body), { name: "my-app" });
    assert.match(approvalRequests[0].message, /\$20\.00/);
    assert.ok(!approvalRequests[0].message.includes(TOKEN));

    const opFile = join(fixture.stateDir, "operations", `${prep.operationId}.json`);
    assert.strictEqual((await stat(opFile)).mode & 0o777, 0o600);
    const stored = await readFile(opFile, "utf8");
    assert.ok(!stored.includes(TOKEN));

    const { createServer: createAgain } = await import("../dist/server.js");
    const server2 = createAgain({ projectRoots: [fixture.root], stateDir: fixture.stateDir, credentials: CREDS }, { fetch: impl });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client2 = new Client({ name: "ops-restart", version: "0" }, { capabilities: {} });
    await Promise.all([server2.connect(st), client2.connect(ct)]);
    const again = resultData(await client2.callTool({ name: "get_operation", arguments: { operationId: prep.operationId } }));
    assert.strictEqual(again.status, "succeeded");
    assert.strictEqual(again.result.projectId, "prj_new");
    await client2.close();
    await server2.close();
  });
});

test("unknown and expired operations cannot execute", async () => {
  const fixture = await makeFixture();
  const { impl } = makeFetch(vercelRoutes);
  await withClient({ fixture, fetchImpl: impl, approve: true }, async ({ client }) => {
    const missing = await client.callTool({
      name: "execute_infrastructure_change",
      arguments: { operationId: "00000000-0000-4000-8000-000000000000" },
    });
    assert.strictEqual(resultData(missing).error.code, "NOT_FOUND");

    const prep = resultData(
      await client.callTool({
        name: "prepare_infrastructure_change",
        arguments: {
          projectPath: fixture.project,
          action: { kind: "create_vercel_project", name: "my-app" },
          maxMonthlyBudgetUsd: 50,
          commercialUse: true,
        },
      }),
    );
    const opFile = join(fixture.stateDir, "operations", `${prep.operationId}.json`);
    const stored = JSON.parse(await readFile(opFile, "utf8"));
    stored.expiresAt = new Date(Date.now() - 1000).toISOString();
    await writeFile(opFile, JSON.stringify(stored));
    const expired = await client.callTool({ name: "execute_infrastructure_change", arguments: { operationId: prep.operationId } });
    assert.strictEqual(resultData(expired).error.code, "OPERATION_EXPIRED");
  });
});

test("budget aggregation blocks overspend across prepared operations", async () => {
  const fixture = await makeFixture();
  const { impl } = makeFetch({ ...vercelRoutes, ...supabaseRoutes });
  await withClient({ fixture, fetchImpl: impl, approve: true }, async ({ client }) => {
    const first = resultData(
      await client.callTool({
        name: "prepare_infrastructure_change",
        arguments: {
          projectPath: fixture.project,
          action: { kind: "create_vercel_project", name: "my-app" },
          maxMonthlyBudgetUsd: 45,
          commercialUse: true,
        },
      }),
    );
    assert.ok(first.operationId);
    const second = await client.callTool({
      name: "prepare_infrastructure_change",
      arguments: {
        projectPath: fixture.project,
        action: { kind: "create_supabase_project", name: "db-proj", organizationSlug: "org-slug", region: "us-east-1", plan: "pro" },
        maxMonthlyBudgetUsd: 45,
        commercialUse: true,
      },
    });
    assert.strictEqual(resultData(second).error.code, "BUDGET_EXCEEDED");
  });
});

test("remote plan change after prepare blocks execution", async () => {
  const fixture = await makeFixture();
  let plan = "pro";
  const { impl, calls } = makeFetch({
    "GET /v2/teams/team_1": () => json({ id: "team_1", billing: { plan } }),
    "GET /v9/projects/my-app": () => json({ error: "not found" }, 404),
  });
  await withClient({ fixture, fetchImpl: impl, approve: true }, async ({ client }) => {
    const prep = resultData(
      await client.callTool({
        name: "prepare_infrastructure_change",
        arguments: {
          projectPath: fixture.project,
          action: { kind: "create_vercel_project", name: "my-app" },
          maxMonthlyBudgetUsd: 50,
          commercialUse: true,
        },
      }),
    );
    plan = "enterprise";
    const exec = await client.callTool({ name: "execute_infrastructure_change", arguments: { operationId: prep.operationId } });
    assert.strictEqual(exec.isError, true);
    assert.strictEqual(calls.filter((c) => c.method === "POST").length, 0);
  });
});

test("domain registration uses exact quote math and blocks on quote change", async () => {
  const fixture = await makeFixture();
  let price = { currency: "USD", registration_cost: "8.57", renewal_cost: "10.11" };
  const { impl, calls } = makeFetch({
    "GET /client/v4/accounts/acc_1": () => json({ success: true, result: { id: "acc_1" } }),
    "POST /client/v4/accounts/acc_1/registrar/domain-check": () =>
      json({ success: true, result: { domains: [{ name: "example.com", registrable: true, tier: "standard", pricing: price }] } }),
    "POST /client/v4/accounts/acc_1/registrar/registrations": () =>
      json({ success: true, result: { domain_name: "example.com", state: "succeeded", completed: true } }, 201),
  });
  await withClient({ fixture, fetchImpl: impl, approve: true }, async ({ client }) => {
    const prep = resultData(
      await client.callTool({
        name: "prepare_infrastructure_change",
        arguments: {
          projectPath: fixture.project,
          action: { kind: "register_domain", domain: "example.com", years: 2 },
          maxMonthlyBudgetUsd: 0,
          maxUpfrontBudgetUsd: 20,
          commercialUse: true,
        },
      }),
    );
    assert.strictEqual(prep.estimate.estimatedUpfrontCostUsd, 18.68);
    const exec = resultData(
      await client.callTool({ name: "execute_infrastructure_change", arguments: { operationId: prep.operationId } }),
    );
    assert.strictEqual(exec.status, "succeeded");
    const post = calls.find((c) => c.path.endsWith("/registrar/registrations"));
    const body = JSON.parse(post.body);
    assert.strictEqual(body.auto_renew, false);
    assert.strictEqual(body.years, 2);
  });

  const fixture2 = await makeFixture();
  let changed = false;
  const { impl: impl2, calls: calls2 } = makeFetch({
    "GET /client/v4/accounts/acc_1": () => json({ success: true, result: { id: "acc_1" } }),
    "POST /client/v4/accounts/acc_1/registrar/domain-check": () =>
      json({
        success: true,
        result: {
          domains: [
            {
              name: "example.com",
              registrable: true,
              tier: "standard",
              pricing: { currency: "USD", registration_cost: changed ? "9.99" : "8.57", renewal_cost: "10.11" },
            },
          ],
        },
      }),
    "POST /client/v4/accounts/acc_1/registrar/registrations": () =>
      json({ success: true, result: { domain_name: "example.com", state: "succeeded", completed: true } }),
  });
  await withClient({ fixture: fixture2, fetchImpl: impl2, approve: true }, async ({ client }) => {
    const prep = resultData(
      await client.callTool({
        name: "prepare_infrastructure_change",
        arguments: {
          projectPath: fixture2.project,
          action: { kind: "register_domain", domain: "example.com", years: 1 },
          maxMonthlyBudgetUsd: 0,
          maxUpfrontBudgetUsd: 20,
          commercialUse: true,
        },
      }),
    );
    changed = true;
    const exec = await client.callTool({ name: "execute_infrastructure_change", arguments: { operationId: prep.operationId } });
    assert.strictEqual(resultData(exec).error.code, "QUOTE_CHANGED");
    assert.strictEqual(calls2.filter((c) => c.path.endsWith("/registrations")).length, 0);
  });
});

test("hobby plan rejects commercial use", async () => {
  const fixture = await makeFixture();
  const { impl } = makeFetch({
    "GET /v2/teams/team_1": () => json({ id: "team_1", billing: { plan: "hobby" } }),
    "GET /v9/projects/my-app": () => json({ error: "not found" }, 404),
  });
  await withClient({ fixture, fetchImpl: impl, approve: true }, async ({ client }) => {
    const res = await client.callTool({
      name: "prepare_infrastructure_change",
      arguments: {
        projectPath: fixture.project,
        action: { kind: "create_vercel_project", name: "my-app" },
        maxMonthlyBudgetUsd: 50,
        commercialUse: true,
      },
    });
    assert.strictEqual(resultData(res).error.code, "COMMERCIAL_USE_RESTRICTED");
  });
});

test("DNS record validation, conflict detection and update precondition checks", async () => {
  const fixture = await makeFixture();
  const records = [
    { id: "rec_1", type: "A", name: "www.example.com", content: "192.0.2.1", ttl: 300, proxied: false },
  ];
  const { impl, calls } = makeFetch({
    "GET /client/v4/accounts/acc_1": () => json({ success: true, result: { id: "acc_1" } }),
    "GET /client/v4/zones/zone_1": () =>
      json({ success: true, result: { id: "zone_1", name: "example.com", status: "active", account: { id: "acc_1" } } }),
    "GET /client/v4/zones/zone_1/dns_records": (u) =>
      json({
        success: true,
        result: records.filter((r) => !u.searchParams.get("name") || r.name === u.searchParams.get("name")),
        result_info: { total_pages: 1 },
      }),
    "GET /client/v4/zones/zone_1/dns_records/rec_1": () => json({ success: true, result: records[0] }),
    "PUT /client/v4/zones/zone_1/dns_records/rec_1": (_u, init) => json({ success: true, result: { id: "rec_1", ...JSON.parse(init.body) } }),
    "POST /client/v4/zones/zone_1/dns_records": (_u, init) => json({ success: true, result: { id: "rec_new", ...JSON.parse(init.body) } }),
  });
  await withClient({ fixture, fetchImpl: impl, approve: true }, async ({ client }) => {
    const outside = await client.callTool({
      name: "prepare_infrastructure_change",
      arguments: {
        projectPath: fixture.project,
        action: { kind: "upsert_dns_record", zoneId: "zone_1", type: "A", name: "other.org", content: "192.0.2.5" },
        maxMonthlyBudgetUsd: 0,
        commercialUse: true,
      },
    });
    assert.strictEqual(resultData(outside).error.code, "DNS_OUTSIDE_ZONE");

    const conflict = await client.callTool({
      name: "prepare_infrastructure_change",
      arguments: {
        projectPath: fixture.project,
        action: { kind: "upsert_dns_record", zoneId: "zone_1", type: "A", name: "www.example.com", content: "192.0.2.9" },
        maxMonthlyBudgetUsd: 0,
        commercialUse: true,
      },
    });
    assert.strictEqual(resultData(conflict).error.code, "DNS_CONFLICT");

    const prep = resultData(
      await client.callTool({
        name: "prepare_infrastructure_change",
        arguments: {
          projectPath: fixture.project,
          action: { kind: "upsert_dns_record", zoneId: "zone_1", type: "A", name: "www.example.com", content: "192.0.2.9", recordId: "rec_1" },
          maxMonthlyBudgetUsd: 0,
          commercialUse: true,
        },
      }),
    );
    assert.ok(prep.operationId);
    const exec = resultData(
      await client.callTool({ name: "execute_infrastructure_change", arguments: { operationId: prep.operationId } }),
    );
    assert.strictEqual(exec.status, "succeeded");
    const put = calls.find((c) => c.method === "PUT");
    assert.deepStrictEqual(JSON.parse(put.body).content, "192.0.2.9");
  });
});

test("local deploy uploads only safe files with verified digests, then reports pending until READY", async () => {
  const fixture = await makeFixture();
  await writeFile(join(fixture.project, "secret.pem"), "KEY MATERIAL");
  await writeFile(join(fixture.project, ".env"), "SECRET=1\n");
  await writeFile(join(fixture.project, ".gitignore"), "ignored.js\n");
  await writeFile(join(fixture.project, "ignored.js"), "process.env.X;");
  await writeFile(join(fixture.project, "index.js"), "console.log('ok');");
  const realTarget = join(fixture.project, "index.js");
  await symlink(realTarget, join(fixture.project, "linked.js"));

  let deploymentReady = "BUILDING";
  const { impl, calls } = makeFetch({
    "GET /v2/teams/team_1": () => json({ id: "team_1", billing: { plan: "pro" } }),
    "GET /v9/projects/prj_1": () => json({ id: "prj_1", name: "app", accountId: "team_1" }),
    "POST /v2/files": () => new Response(null, { status: 200 }),
    "POST /v13/deployments": () => json({ id: "dpl_1", url: "https://app-1.vercel.app", readyState: deploymentReady, projectId: "prj_1" }),
    "GET /v13/deployments/dpl_1": () => json({ id: "dpl_1", readyState: deploymentReady, projectId: "prj_1", target: "preview" }),
  });
  await withClient({ fixture, fetchImpl: impl, approve: true }, async ({ client }) => {
    const prep = resultData(
      await client.callTool({
        name: "prepare_infrastructure_change",
        arguments: {
          projectPath: fixture.project,
          action: { kind: "deploy_vercel", projectId: "prj_1", name: "app", source: { type: "local" } },
          maxMonthlyBudgetUsd: 50,
          commercialUse: true,
        },
      }),
    );
    assert.ok(prep.operationId);
    const exec = resultData(
      await client.callTool({ name: "execute_infrastructure_change", arguments: { operationId: prep.operationId } }),
    );
    assert.strictEqual(exec.status, "pending");
    assert.strictEqual(exec.result.deploymentId, "dpl_1");

    const uploads = calls.filter((c) => c.path === "/v2/files");
    assert.strictEqual(uploads.length, 3);
    assert.ok(uploads.every((c) => c.headers["x-vercel-digest"]));
    const deployBody = JSON.parse(calls.find((c) => c.path === "/v13/deployments").body);
    assert.strictEqual(deployBody.target, undefined);
    const names = deployBody.files.map((f) => f.file).sort();
    assert.deepStrictEqual(names, ["index.html", "index.js", "package.json"]);

    deploymentReady = "READY";
    const status = resultData(
      await client.callTool({ name: "get_operation", arguments: { operationId: prep.operationId, refresh: true } }),
    );
    assert.strictEqual(status.status, "succeeded");
  });
});

test("supabase create stores password only in 0600 vault; sync writes public keys", async () => {
  const fixture = await makeFixture();
  const routes = {
    ...supabaseRoutes,
    "GET /v1/projects/abcdefghijklmnopqrst": () =>
      json({ id: "lorem", ref: "abcdefghijklmnopqrst", name: "db-proj", status: "ACTIVE_HEALTHY", organization_id: "org_1" }),
    "GET /v1/projects/abcdefghijklmnopqrst/api-keys": () =>
      json([
        { type: "publishable", api_key: "pub-key-sentinel" },
        { name: "service_role", api_key: "service-key-sentinel" },
      ]),
  };
  const { impl, calls } = makeFetch(routes);
  let opId;
  await withClient({ fixture, fetchImpl: impl, approve: true }, async ({ client, approvalRequests }) => {
    const prep = resultData(
      await client.callTool({
        name: "prepare_infrastructure_change",
        arguments: {
          projectPath: fixture.project,
          action: { kind: "create_supabase_project", name: "db-proj", organizationSlug: "org-slug", region: "us-east-1", plan: "pro" },
          maxMonthlyBudgetUsd: 50,
          commercialUse: true,
        },
      }),
    );
    opId = prep.operationId;
    assert.strictEqual(prep.estimate.estimatedMonthlyCostUsd, 35);
    const exec = resultData(
      await client.callTool({ name: "execute_infrastructure_change", arguments: { operationId: opId } }),
    );
    assert.strictEqual(exec.status, "succeeded");
    const post = JSON.parse(calls.find((c) => c.path === "/v1/projects" && c.method === "POST").body);
    assert.strictEqual(post.plan, undefined);
    assert.deepStrictEqual(post.region_selection, { type: "specific", code: "us-east-1" });
    assert.match(post.db_pass, /^[A-Za-z0-9_-]{43}$/);

    const vaultPath = join(fixture.stateDir, "operations", `${opId}.secret.json`);
    assert.strictEqual((await stat(vaultPath)).mode & 0o777, 0o600);
    const opJson = await readFile(join(fixture.stateDir, "operations", `${opId}.json`), "utf8");
    assert.ok(!opJson.includes(post.db_pass));
    assert.ok(!approvalRequests[0].message.includes(post.db_pass));

    const syncPrep = resultData(
      await client.callTool({
        name: "prepare_infrastructure_change",
        arguments: {
          projectPath: fixture.project,
          action: { kind: "sync_supabase_env", projectRef: "abcdefghijklmnopqrst", sourceOperationId: opId },
          maxMonthlyBudgetUsd: 50,
          commercialUse: true,
        },
      }),
    );
    const syncExec = resultData(
      await client.callTool({ name: "execute_infrastructure_change", arguments: { operationId: syncPrep.operationId } }),
    );
    assert.strictEqual(syncExec.status, "succeeded");
    assert.ok(!JSON.stringify(syncExec).includes("pub-key-sentinel"));
    assert.ok(!JSON.stringify(syncExec).includes("service-key-sentinel"));
    const envContent = await readFile(join(fixture.project, ".env"), "utf8");
    assert.match(envContent, /SUPABASE_URL=/);
    assert.match(envContent, /SUPABASE_PUBLISHABLE_KEY=/);
    assert.match(envContent, /SUPABASE_DB_PASSWORD=/);
    assert.match(envContent, /DATABASE_URL=/);
    assert.ok(!envContent.includes("SERVICE_ROLE"));
    assert.ok(!envContent.includes("service-key-sentinel"));
    assert.ok(!envContent.includes("NEXT_PUBLIC_"));
  });
});

test("partial env upsert marks operation unknown without retry", async () => {
  const fixture = await makeFixture();
  await writeFile(join(fixture.project, ".env"), "API_KEY=local-value\n");
  const { impl, calls } = makeFetch({
    "GET /v2/teams/team_1": () => json({ id: "team_1", billing: { plan: "pro" } }),
    "GET /v9/projects/prj_1": () => json({ id: "prj_1", name: "app", accountId: "team_1" }),
    "POST /v10/projects/prj_1/env": () => json({ failed: [{ key: "API_KEY", error: { code: "x" } }] }),
  });
  await withClient({ fixture, fetchImpl: impl, approve: true }, async ({ client }) => {
    const prep = resultData(
      await client.callTool({
        name: "prepare_infrastructure_change",
        arguments: {
          projectPath: fixture.project,
          action: { kind: "sync_env_to_vercel", projectId: "prj_1", keys: ["API_KEY"], target: ["production"] },
          maxMonthlyBudgetUsd: 50,
          commercialUse: true,
        },
      }),
    );
    const exec = await client.callTool({ name: "execute_infrastructure_change", arguments: { operationId: prep.operationId } });
    assert.strictEqual(resultData(exec).error.code, "PARTIAL_PROVIDER_FAILURE");
    const status = resultData(await client.callTool({ name: "get_operation", arguments: { operationId: prep.operationId } }));
    assert.strictEqual(status.status, "unknown");
    assert.strictEqual(calls.filter((c) => c.path.endsWith("/env")).length, 1);
  });
});

test("running operations cannot be resubmitted; reconcile matches by deterministic identity", async () => {
  const fixture = await makeFixture();
  const { impl, calls } = makeFetch(vercelRoutes);
  await withClient({ fixture, fetchImpl: impl, approve: true }, async ({ client }) => {
    const prep = resultData(
      await client.callTool({
        name: "prepare_infrastructure_change",
        arguments: {
          projectPath: fixture.project,
          action: { kind: "create_vercel_project", name: "my-app" },
          maxMonthlyBudgetUsd: 50,
          commercialUse: true,
        },
      }),
    );
    const opFile = join(fixture.stateDir, "operations", `${prep.operationId}.json`);
    const stored = JSON.parse(await readFile(opFile, "utf8"));
    stored.status = "running";
    await writeFile(opFile, JSON.stringify(stored));
    const exec = await client.callTool({ name: "execute_infrastructure_change", arguments: { operationId: prep.operationId } });
    assert.strictEqual(resultData(exec).error.code, "RECONCILIATION_REQUIRED");
    assert.strictEqual(calls.filter((c) => c.method === "POST").length, 0);

    const runningStored = JSON.parse(await readFile(opFile, "utf8"));
    runningStored.status = "unknown";
    await writeFile(opFile, JSON.stringify(runningStored));
    const recon = resultData(
      await client.callTool({ name: "reconcile_operation", arguments: { operationId: prep.operationId } }),
    );
    assert.strictEqual(recon.status, "unknown");
  });
});

test("reconcile attaches a matching vercel project", async () => {
  const fixture = await makeFixture();
  let exists = false;
  const { impl } = makeFetch({
    "GET /v2/teams/team_1": () => json({ id: "team_1", billing: { plan: "pro" } }),
    "GET /v9/projects/my-app": () => (exists ? json({ id: "prj_9", name: "my-app", accountId: "team_1" }) : json({ error: "nf" }, 404)),
  });
  await withClient({ fixture, fetchImpl: impl, approve: true }, async ({ client }) => {
    const prep = resultData(
      await client.callTool({
        name: "prepare_infrastructure_change",
        arguments: {
          projectPath: fixture.project,
          action: { kind: "create_vercel_project", name: "my-app" },
          maxMonthlyBudgetUsd: 50,
          commercialUse: true,
        },
      }),
    );
    const opFile = join(fixture.stateDir, "operations", `${prep.operationId}.json`);
    const stored = JSON.parse(await readFile(opFile, "utf8"));
    stored.status = "unknown";
    await writeFile(opFile, JSON.stringify(stored));
    exists = true;
    const recon = resultData(
      await client.callTool({ name: "reconcile_operation", arguments: { operationId: prep.operationId } }),
    );
    assert.strictEqual(recon.status, "succeeded");
    assert.strictEqual(recon.result.projectId, "prj_9");
  });
});

test("concurrent executes produce exactly one remote mutation", async () => {
  const fixture = await makeFixture();
  const { impl, calls } = makeFetch(vercelRoutes);
  await withClient({ fixture, fetchImpl: impl, approve: true }, async ({ client }) => {
    const prep = resultData(
      await client.callTool({
        name: "prepare_infrastructure_change",
        arguments: {
          projectPath: fixture.project,
          action: { kind: "create_vercel_project", name: "my-app" },
          maxMonthlyBudgetUsd: 50,
          commercialUse: true,
        },
      }),
    );
    const [a, b] = await Promise.all([
      client.callTool({ name: "execute_infrastructure_change", arguments: { operationId: prep.operationId } }),
      client.callTool({ name: "execute_infrastructure_change", arguments: { operationId: prep.operationId } }),
    ]);
    assert.strictEqual(calls.filter((c) => c.method === "POST").length, 1);
    const outcomes = [a, b].map((r) => (r.isError ? resultData(r).error.code : resultData(r).status));
    assert.ok(outcomes.includes("succeeded"));
  });
});

test("mutations are blocked for clients without form elicitation", async () => {
  const fixture = await makeFixture();
  const { impl, calls } = makeFetch(vercelRoutes);
  await withClient({ fixture, fetchImpl: impl, approve: true, elicitation: false }, async ({ client }) => {
    const prep = resultData(
      await client.callTool({
        name: "prepare_infrastructure_change",
        arguments: {
          projectPath: fixture.project,
          action: { kind: "create_vercel_project", name: "my-app" },
          maxMonthlyBudgetUsd: 50,
          commercialUse: true,
        },
      }),
    );
    const exec = await client.callTool({ name: "execute_infrastructure_change", arguments: { operationId: prep.operationId } });
    assert.strictEqual(resultData(exec).error.code, "APPROVAL_UNAVAILABLE");
    assert.strictEqual(calls.filter((c) => c.method === "POST").length, 0);
  });
});

test("check_provider_connections returns sanitized status", async () => {
  const fixture = await makeFixture();
  const { impl } = makeFetch({
    "GET /v2/teams/team_1": () => json({ id: "team_1", billing: { plan: "pro" } }),
    "GET /v1/projects": () => json([]),
    "GET /client/v4/accounts/acc_1": () => json({ success: true, result: { id: "acc_1", name: "Acct" } }),
  });
  await withClient({ fixture, fetchImpl: impl, approve: true }, async ({ client }) => {
    const res = resultData(await client.callTool({ name: "check_provider_connections", arguments: {} }));
    assert.strictEqual(res.providers.vercel.plan, "pro");
    assert.strictEqual(res.providers.cloudflare.accountId, "acc_1");
    assert.ok(!JSON.stringify(res).includes(TOKEN));
  });
});

test("shared subscription keys deduplicate across operations while per-resource costs stack", async () => {
  const fixture = await makeFixture();
  const { impl, calls } = makeFetch({
    "GET /v2/teams/team_1": () => json({ id: "team_1", billing: { plan: "pro" } }),
    "GET /v9/projects/my-app": () => json({ error: "not found" }, 404),
    "POST /v11/projects": (_u, init) => json({ id: "prj_new", name: JSON.parse(init.body).name, accountId: "team_1" }),
    "GET /v9/projects/prj_new": () => json({ id: "prj_new", name: "my-app", accountId: "team_1" }),
    "POST /v2/files": () => new Response("", { status: 200 }),
    "POST /v13/deployments": () => json({ id: "dpl_1", readyState: "READY", projectId: "prj_new", url: "https://app-1.vercel.app" }),
  });
  await withClient({ fixture, fetchImpl: impl, approve: true }, async ({ client }) => {
    const prep = resultData(
      await client.callTool({
        name: "prepare_infrastructure_change",
        arguments: {
          projectPath: fixture.project,
          action: { kind: "create_vercel_project", name: "my-app" },
          maxMonthlyBudgetUsd: 20,
          commercialUse: true,
        },
      }),
    );
    assert.ok(prep.operationId);
    const exec = resultData(
      await client.callTool({ name: "execute_infrastructure_change", arguments: { operationId: prep.operationId } }),
    );
    assert.strictEqual(exec.status, "succeeded");
    const deployPrep = resultData(
      await client.callTool({
        name: "prepare_infrastructure_change",
        arguments: {
          projectPath: fixture.project,
          action: { kind: "deploy_vercel", projectId: "prj_new", name: "my-app", target: "preview", source: { type: "local" } },
          maxMonthlyBudgetUsd: 20,
          commercialUse: true,
        },
      }),
    );
    assert.ok(deployPrep.operationId, JSON.stringify(deployPrep));
    assert.strictEqual(deployPrep.projectedCosts.monthlyUsd, 20);
    const deployExec = resultData(
      await client.callTool({ name: "execute_infrastructure_change", arguments: { operationId: deployPrep.operationId } }),
    );
    assert.strictEqual(deployExec.status, "succeeded");
    assert.ok(calls.some((c) => c.method === "POST" && c.path === "/v13/deployments"));
  });
});

test("two supabase pro projects stack compute but share the subscription", async () => {
  const fixture = await makeFixture();
  const { impl } = makeFetch(supabaseRoutes);
  await withClient({ fixture, fetchImpl: impl, approve: true }, async ({ client }) => {
    const first = resultData(
      await client.callTool({
        name: "prepare_infrastructure_change",
        arguments: {
          projectPath: fixture.project,
          action: { kind: "create_supabase_project", name: "db-one", organizationSlug: "org-slug", region: "us-east-1", plan: "pro" },
          maxMonthlyBudgetUsd: 50,
          commercialUse: true,
        },
      }),
    );
    assert.ok(first.operationId);
    const exec = resultData(
      await client.callTool({ name: "execute_infrastructure_change", arguments: { operationId: first.operationId } }),
    );
    assert.strictEqual(exec.status, "succeeded");
    const second = resultData(
      await client.callTool({
        name: "prepare_infrastructure_change",
        arguments: {
          projectPath: fixture.project,
          action: { kind: "create_supabase_project", name: "db-two", organizationSlug: "org-slug", region: "us-east-1", plan: "pro" },
          maxMonthlyBudgetUsd: 45,
          commercialUse: true,
        },
      }),
    );
    assert.ok(second.operationId, JSON.stringify(second));
    assert.strictEqual(second.projectedCosts.monthlyUsd, 45);
    const third = await client.callTool({
      name: "prepare_infrastructure_change",
      arguments: {
        projectPath: fixture.project,
        action: { kind: "create_supabase_project", name: "db-three", organizationSlug: "org-slug", region: "us-east-1", plan: "pro" },
        maxMonthlyBudgetUsd: 54,
        commercialUse: true,
      },
    });
    assert.strictEqual(resultData(third).error.code, "BUDGET_EXCEEDED");
  });
});

test("unpriced vercel plans deny paid mutations", async () => {
  const fixture = await makeFixture();
  const { impl, calls } = makeFetch({
    "GET /v2/teams/team_1": () => json({ id: "team_1", billing: { plan: "enterprise-custom" } }),
  });
  await withClient({ fixture, fetchImpl: impl, approve: true }, async ({ client }) => {
    const res = await client.callTool({
      name: "prepare_infrastructure_change",
      arguments: {
        projectPath: fixture.project,
        action: { kind: "create_vercel_project", name: "my-app" },
        maxMonthlyBudgetUsd: 100,
        commercialUse: true,
      },
    });
    assert.strictEqual(resultData(res).error.code, "UNPRICED_PLAN");
    assert.strictEqual(calls.filter((c) => c.method === "POST").length, 0);
  });
});

test("source changes made during approval block the mutation", async () => {
  const fixture = await makeFixture();
  const { impl, calls } = makeFetch({
    "GET /v2/teams/team_1": () => json({ id: "team_1", billing: { plan: "pro" } }),
    "GET /v9/projects/prj_1": () => json({ id: "prj_1", name: "app", accountId: "team_1" }),
    "POST /v2/files": () => new Response("", { status: 200 }),
    "POST /v13/deployments": () => json({ id: "dpl_1", readyState: "READY" }),
  });
  await withClient(
    {
      fixture,
      fetchImpl: impl,
      approve: async () => {
        await writeFile(join(fixture.project, "drift.js"), "console.log('new');");
      },
    },
    async ({ client }) => {
      const prep = resultData(
        await client.callTool({
          name: "prepare_infrastructure_change",
          arguments: {
            projectPath: fixture.project,
            action: { kind: "deploy_vercel", projectId: "prj_1", name: "app", source: { type: "local" } },
            maxMonthlyBudgetUsd: 20,
            commercialUse: true,
          },
        }),
      );
      assert.ok(prep.operationId);
      const exec = await client.callTool({ name: "execute_infrastructure_change", arguments: { operationId: prep.operationId } });
      assert.strictEqual(resultData(exec).error.code, "PRECONDITION_CHANGED");
      assert.strictEqual(calls.filter((c) => c.method === "POST").length, 0);
    },
  );
});

test("cloudflare account drift during approval blocks the purchase", async () => {
  const fixture = await makeFixture();
  const { impl, calls } = makeFetch({
    "GET /client/v4/accounts/acc_1": () => json({ success: true, result: { id: "acc_1" } }),
    "GET /client/v4/accounts/acc_2": () => json({ success: true, result: { id: "acc_2" } }),
    "POST /client/v4/accounts/acc_1/registrar/domain-check": () =>
      json({ success: true, result: { domains: [{ name: "example.com", registrable: true, tier: "standard", pricing: { currency: "USD", registration_cost: "8.57", renewal_cost: "10.11" } }] } }),
    "POST /client/v4/accounts/acc_2/registrar/domain-check": () =>
      json({ success: true, result: { domains: [{ name: "example.com", registrable: true, tier: "standard", pricing: { currency: "USD", registration_cost: "8.57", renewal_cost: "10.11" } }] } }),
    "POST /client/v4/accounts/acc_1/registrar/registrations": () => json({ success: true, result: { state: "succeeded" } }),
  });
  const creds = { ...CREDS, cloudflareAccountId: "acc_1" };
  const serverFixture = { fixture, fetchImpl: impl, approve: true, creds };
  {
    const config = { projectRoots: [fixture.root], stateDir: fixture.stateDir, credentials: creds };
    const server = createServer(config, { fetch: impl });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "ops-test", version: "0.1.0" }, { capabilities: { elicitation: { form: {} } } });
    client.setRequestHandler(ElicitRequestSchema, async () => ({ action: "accept", content: { approve: true } }));
    await Promise.all([server.connect(st), client.connect(ct)]);
    const prep = resultData(
      await client.callTool({
        name: "prepare_infrastructure_change",
        arguments: {
          projectPath: fixture.project,
          action: { kind: "register_domain", domain: "example.com", years: 1 },
          maxMonthlyBudgetUsd: 0,
          maxUpfrontBudgetUsd: 20,
          commercialUse: true,
        },
      }),
    );
    assert.ok(prep.operationId);
    await client.close();
    await server.close();
    serverFixture.operationId = prep.operationId;
  }
  const creds2 = { ...CREDS, cloudflareAccountId: "acc_2" };
  const config2 = { projectRoots: [fixture.root], stateDir: fixture.stateDir, credentials: creds2 };
  const server2 = createServer(config2, { fetch: impl });
  const [ct2, st2] = InMemoryTransport.createLinkedPair();
  const client2 = new Client({ name: "ops-test", version: "0.1.0" }, { capabilities: { elicitation: { form: {} } } });
  client2.setRequestHandler(ElicitRequestSchema, async () => ({ action: "accept", content: { approve: true } }));
  await Promise.all([server2.connect(st2), client2.connect(ct2)]);
  try {
    const exec = await client2.callTool({ name: "execute_infrastructure_change", arguments: { operationId: serverFixture.operationId } });
    assert.strictEqual(resultData(exec).error.code, "QUOTE_CHANGED");
    assert.strictEqual(calls.filter((c) => c.path.endsWith("/registrations") && c.method === "POST").length, 0);
  } finally {
    await client2.close();
    await server2.close();
  }
});

test("dns record drift during approval blocks the update", async () => {
  const fixture = await makeFixture();
  const records = [{ id: "rec_1", type: "A", name: "www.example.com", content: "192.0.2.1", ttl: 300, proxied: false }];
  const { impl, calls } = makeFetch({
    "GET /client/v4/accounts/acc_1": () => json({ success: true, result: { id: "acc_1" } }),
    "GET /client/v4/zones/zone_1": () =>
      json({ success: true, result: { id: "zone_1", name: "example.com", status: "active", account: { id: "acc_1" } } }),
    "GET /client/v4/zones/zone_1/dns_records": () => json({ success: true, result: records, result_info: { total_pages: 1 } }),
    "GET /client/v4/zones/zone_1/dns_records/rec_1": () => json({ success: true, result: records[0] }),
    "PUT /client/v4/zones/zone_1/dns_records/rec_1": () => json({ success: true, result: {} }),
  });
  await withClient(
    {
      fixture,
      fetchImpl: impl,
      approve: async () => {
        records[0] = { ...records[0], content: "192.0.2.99" };
      },
    },
    async ({ client }) => {
      const prep = resultData(
        await client.callTool({
          name: "prepare_infrastructure_change",
          arguments: {
            projectPath: fixture.project,
            action: { kind: "upsert_dns_record", zoneId: "zone_1", type: "A", name: "www.example.com", content: "192.0.2.9", recordId: "rec_1" },
            maxMonthlyBudgetUsd: 0,
            commercialUse: true,
          },
        }),
      );
      assert.ok(prep.operationId);
      const exec = await client.callTool({ name: "execute_infrastructure_change", arguments: { operationId: prep.operationId } });
      assert.strictEqual(resultData(exec).error.code, "PRECONDITION_CHANGED");
      assert.strictEqual(calls.filter((c) => c.method === "PUT").length, 0);
    },
  );
});

test("a post-mutation read failure marks the operation unknown and keeps the reservation", async () => {
  const fixture = await makeFixture();
  const { impl } = makeFetch({
    "GET /v2/teams/team_1": () => json({ id: "team_1", billing: { plan: "pro" } }),
    "GET /v9/projects/prj_1": () => json({ id: "prj_1", name: "app", accountId: "team_1" }),
    "POST /v10/projects/prj_1/domains": () => json({ name: "example.com", verified: false }),
    "GET /v9/projects/prj_1/domains/example.com": () => json({ error: "boom" }, 503),
  });
  await withClient({ fixture, fetchImpl: impl, approve: true }, async ({ client }) => {
    const prep = resultData(
      await client.callTool({
        name: "prepare_infrastructure_change",
        arguments: {
          projectPath: fixture.project,
          action: { kind: "connect_vercel_domain", projectId: "prj_1", domain: "example.com" },
          maxMonthlyBudgetUsd: 20,
          commercialUse: true,
        },
      }),
    );
    assert.ok(prep.operationId);
    const exec = resultData(await client.callTool({ name: "execute_infrastructure_change", arguments: { operationId: prep.operationId } }));
    assert.ok(exec.error);
    const record = resultData(await client.callTool({ name: "get_operation", arguments: { operationId: prep.operationId } }));
    assert.strictEqual(record.status, "unknown");
    assert.strictEqual(record.costCommitted, true);
  });
});

test("rollback read failure after the mutation marks the operation unknown", async () => {
  const fixture = await makeFixture();
  let prodId = "dpl_new";
  let failProjectRead = false;
  const { impl } = makeFetch({
    "GET /v2/teams/team_1": () => json({ id: "team_1", billing: { plan: "pro" } }),
    "GET /v9/projects/prj_1": () =>
      failProjectRead
        ? json({ error: "boom" }, 503)
        : json({ id: "prj_1", name: "app", accountId: "team_1", targets: { production: { id: prodId } } }),
    "GET /v13/deployments/dpl_old": () => json({ id: "dpl_old", readyState: "READY", target: "production", projectId: "prj_1" }),
    "POST /v1/projects/prj_1/rollback/dpl_old": () => {
      failProjectRead = true;
      return new Response("", { status: 200 });
    },
  });
  await withClient({ fixture, fetchImpl: impl, approve: true }, async ({ client }) => {
    const prep = resultData(
      await client.callTool({
        name: "prepare_infrastructure_change",
        arguments: {
          projectPath: fixture.project,
          action: { kind: "rollback_vercel", projectId: "prj_1", deploymentId: "dpl_old" },
          maxMonthlyBudgetUsd: 20,
          commercialUse: true,
        },
      }),
    );
    assert.ok(prep.operationId, JSON.stringify(prep));
    const exec = resultData(await client.callTool({ name: "execute_infrastructure_change", arguments: { operationId: prep.operationId } }));
    assert.ok(exec.error);
    const record = resultData(await client.callTool({ name: "get_operation", arguments: { operationId: prep.operationId } }));
    assert.strictEqual(record.status, "unknown");
    assert.strictEqual(record.costCommitted, true);
  });
});

test("rollback refresh waits for the production target to move", async () => {
  const fixture = await makeFixture();
  let prodId = "dpl_new";
  const { impl } = makeFetch({
    "GET /v2/teams/team_1": () => json({ id: "team_1", billing: { plan: "pro" } }),
    "GET /v9/projects/prj_1": () => json({ id: "prj_1", name: "app", accountId: "team_1", targets: { production: { id: prodId } } }),
    "GET /v13/deployments/dpl_old": () => json({ id: "dpl_old", readyState: "READY", target: "production", projectId: "prj_1" }),
    "POST /v1/projects/prj_1/rollback/dpl_old": () => new Response("", { status: 200 }),
  });
  await withClient({ fixture, fetchImpl: impl, approve: true }, async ({ client }) => {
    const prep = resultData(
      await client.callTool({
        name: "prepare_infrastructure_change",
        arguments: {
          projectPath: fixture.project,
          action: { kind: "rollback_vercel", projectId: "prj_1", deploymentId: "dpl_old" },
          maxMonthlyBudgetUsd: 20,
          commercialUse: true,
        },
      }),
    );
    const exec = resultData(await client.callTool({ name: "execute_infrastructure_change", arguments: { operationId: prep.operationId } }));
    assert.strictEqual(exec.status, "pending");
    prodId = "dpl_old";
    const record = resultData(
      await client.callTool({ name: "get_operation", arguments: { operationId: prep.operationId, refresh: true } }),
    );
    assert.strictEqual(record.status, "succeeded");
    assert.strictEqual(record.result.productionDeploymentId, "dpl_old");
  });
});

test("a definitive provider rejection marks the operation failed without a reservation", async () => {
  const fixture = await makeFixture();
  const { impl } = makeFetch({
    "GET /v2/teams/team_1": () => json({ id: "team_1", billing: { plan: "pro" } }),
    "GET /v9/projects/my-app": () => json({ error: "not found" }, 404),
    "POST /v11/projects": () => json({ error: { code: "bad_request" } }, 400),
  });
  await withClient({ fixture, fetchImpl: impl, approve: true }, async ({ client }) => {
    const prep = resultData(
      await client.callTool({
        name: "prepare_infrastructure_change",
        arguments: {
          projectPath: fixture.project,
          action: { kind: "create_vercel_project", name: "my-app" },
          maxMonthlyBudgetUsd: 20,
          commercialUse: true,
        },
      }),
    );
    const exec = resultData(await client.callTool({ name: "execute_infrastructure_change", arguments: { operationId: prep.operationId } }));
    assert.strictEqual(exec.error.code, "PROVIDER_REQUEST_FAILED");
    const record = resultData(await client.callTool({ name: "get_operation", arguments: { operationId: prep.operationId } }));
    assert.strictEqual(record.status, "failed");
    assert.strictEqual(record.costCommitted, false);
  });
});

test("a durable save failure after a remote mutation cannot be retried", async () => {
  const fixture = await makeFixture();
  const opsDir = join(fixture.stateDir, "operations");
  const { impl, calls } = makeFetch({
    "GET /v2/teams/team_1": () => json({ id: "team_1", billing: { plan: "pro" } }),
    "GET /v9/projects/my-app": () => json({ error: "not found" }, 404),
    "POST /v11/projects": async (_u, init) => {
      await chmod(opsDir, 0o500);
      return json({ id: "prj_new", name: JSON.parse(init.body).name, accountId: "team_1" });
    },
  });
  try {
    await withClient({ fixture, fetchImpl: impl, approve: true }, async ({ client }) => {
      const prep = resultData(
        await client.callTool({
          name: "prepare_infrastructure_change",
          arguments: {
            projectPath: fixture.project,
            action: { kind: "create_vercel_project", name: "my-app" },
            maxMonthlyBudgetUsd: 20,
            commercialUse: true,
          },
        }),
      );
      assert.ok(prep.operationId);
      const exec = await client.callTool({ name: "execute_infrastructure_change", arguments: { operationId: prep.operationId } });
      assert.strictEqual(resultData(exec).error.code, "WRITE_FAILED");
      const durable = JSON.parse(await readFile(join(opsDir, `${prep.operationId}.json`), "utf8"));
      assert.strictEqual(durable.status, "running");
      await chmod(opsDir, 0o700);
      await unlink(join(opsDir, "operations.lock")).catch(() => {});
      const again = await client.callTool({ name: "execute_infrastructure_change", arguments: { operationId: prep.operationId } });
      assert.strictEqual(resultData(again).error.code, "RECONCILIATION_REQUIRED");
      assert.strictEqual(calls.filter((c) => c.method === "POST" && c.path === "/v11/projects").length, 1);
    });
  } finally {
    await chmod(opsDir, 0o700);
  }
});

test("local .env update failure after remote sync marks the operation unknown", async () => {
  const fixture = await makeFixture();
  const ref = "abcdefghijklmnopqrst";
  const { impl } = makeFetch({
    "GET /v1/organizations/org-slug": () => json({ id: "org_1", name: "Org", plan: "pro" }),
    [`GET /v1/projects/${ref}`]: () =>
      json({ ref, name: "db-proj", status: "ACTIVE_HEALTHY", organization_id: "org_1" }),
    [`GET /v1/projects/${ref}/api-keys`]: () => json([{ name: "anon", type: "publishable", api_key: "pub-key-sentinel" }]),
  });
  await symlink(join(fixture.project, "package.json"), join(fixture.project, ".env"));
  await withClient({ fixture, fetchImpl: impl, approve: true }, async ({ client }) => {
    const prep = resultData(
      await client.callTool({
        name: "prepare_infrastructure_change",
        arguments: {
          projectPath: fixture.project,
          action: { kind: "sync_supabase_env", projectRef: ref },
          maxMonthlyBudgetUsd: 0,
          commercialUse: true,
        },
      }),
    );
    assert.ok(prep.operationId, JSON.stringify(prep));
    const exec = resultData(await client.callTool({ name: "execute_infrastructure_change", arguments: { operationId: prep.operationId } }));
    assert.ok(exec.error);
    const record = resultData(await client.callTool({ name: "get_operation", arguments: { operationId: prep.operationId } }));
    assert.strictEqual(record.status, "unknown");
    assert.strictEqual(record.costCommitted, true);
    await unlink(join(fixture.project, ".env"));
    await writeFile(join(fixture.project, ".env"), `SUPABASE_URL=https://${ref}.supabase.co\n`);
    const reconciled = resultData(
      await client.callTool({ name: "reconcile_operation", arguments: { operationId: prep.operationId } }),
    );
    assert.strictEqual(reconciled.status, "unknown");
    assert.ok(String(reconciled.nextSteps).includes("prepare a new operation"));
    const stillUnknown = resultData(await client.callTool({ name: "get_operation", arguments: { operationId: prep.operationId } }));
    assert.strictEqual(stillUnknown.status, "unknown");
  });
});

test("async domain registration settles via canonical and workflow status", async () => {
  const fixture = await makeFixture();
  let registration = { domain_name: "example.com", status: "registration_pending", expires_at: null };
  const { impl } = makeFetch({
    "GET /client/v4/accounts/acc_1": () => json({ success: true, result: { id: "acc_1" } }),
    "POST /client/v4/accounts/acc_1/registrar/domain-check": () =>
      json({ success: true, result: { domains: [{ name: "example.com", registrable: true, tier: "standard", pricing: { currency: "USD", registration_cost: "8.57", renewal_cost: "10.11" } }] } }),
    "POST /client/v4/accounts/acc_1/registrar/registrations": () =>
      json({ success: true, result: { domain_name: "example.com", state: "running", completed: false } }, 202),
    "GET /client/v4/accounts/acc_1/registrar/registrations/example.com": () => json({ success: true, result: registration }),
    "GET /client/v4/accounts/acc_1/registrar/registrations/example.com/registration-status": () =>
      json({ success: true, result: { state: "failed", completed: true } }),
  });
  await withClient({ fixture, fetchImpl: impl, approve: true }, async ({ client }) => {
    const prep = resultData(
      await client.callTool({
        name: "prepare_infrastructure_change",
        arguments: {
          projectPath: fixture.project,
          action: { kind: "register_domain", domain: "example.com", years: 1 },
          maxMonthlyBudgetUsd: 0,
          maxUpfrontBudgetUsd: 20,
          commercialUse: true,
        },
      }),
    );
    const exec = resultData(await client.callTool({ name: "execute_infrastructure_change", arguments: { operationId: prep.operationId } }));
    assert.strictEqual(exec.status, "pending");
    const failedRefresh = resultData(
      await client.callTool({ name: "get_operation", arguments: { operationId: prep.operationId, refresh: true } }),
    );
    assert.strictEqual(failedRefresh.status, "failed");

    const fixture2 = await makeFixture();
    let registration2 = { domain_name: "example.com", status: "registration_pending", expires_at: null };
    const { impl: impl2 } = makeFetch({
      "GET /client/v4/accounts/acc_1": () => json({ success: true, result: { id: "acc_1" } }),
      "POST /client/v4/accounts/acc_1/registrar/domain-check": () =>
        json({ success: true, result: { domains: [{ name: "example.com", registrable: true, tier: "standard", pricing: { currency: "USD", registration_cost: "8.57", renewal_cost: "10.11" } }] } }),
      "POST /client/v4/accounts/acc_1/registrar/registrations": () =>
        json({ success: true, result: { domain_name: "example.com", state: "running", completed: false } }, 202),
      "GET /client/v4/accounts/acc_1/registrar/registrations/example.com": () => json({ success: true, result: registration2 }),
    });
    await withClient({ fixture: fixture2, fetchImpl: impl2, approve: true }, async ({ client: client2 }) => {
      const prep2 = resultData(
        await client2.callTool({
          name: "prepare_infrastructure_change",
          arguments: {
            projectPath: fixture2.project,
            action: { kind: "register_domain", domain: "example.com", years: 1 },
            maxMonthlyBudgetUsd: 0,
            maxUpfrontBudgetUsd: 20,
            commercialUse: true,
          },
        }),
      );
      const exec2 = resultData(
        await client2.callTool({ name: "execute_infrastructure_change", arguments: { operationId: prep2.operationId } }),
      );
      assert.strictEqual(exec2.status, "pending");
      registration2 = { domain_name: "example.com", status: "active", expires_at: null };
      const refreshed = resultData(
        await client2.callTool({ name: "get_operation", arguments: { operationId: prep2.operationId, refresh: true } }),
      );
      assert.strictEqual(refreshed.status, "succeeded");
    });
  });
});

test("a misconfigured domain stays pending even when verified", async () => {
  const fixture = await makeFixture();
  let misconfigured = true;
  const { impl } = makeFetch({
    "GET /v2/teams/team_1": () => json({ id: "team_1", billing: { plan: "pro" } }),
    "GET /v9/projects/prj_1": () => json({ id: "prj_1", name: "app", accountId: "team_1" }),
    "POST /v10/projects/prj_1/domains": () => json({ name: "example.com", verified: false }),
    "GET /v9/projects/prj_1/domains/example.com": () => json({ name: "example.com", verified: true, verification: [] }),
    "GET /v6/domains/example.com/config": () => json({ misconfigured, recommendedCNAME: [{ rank: 1, value: "cname.vercel-dns.com" }] }),
  });
  await withClient({ fixture, fetchImpl: impl, approve: true }, async ({ client }) => {
    const prep = resultData(
      await client.callTool({
        name: "prepare_infrastructure_change",
        arguments: {
          projectPath: fixture.project,
          action: { kind: "connect_vercel_domain", projectId: "prj_1", domain: "example.com" },
          maxMonthlyBudgetUsd: 20,
          commercialUse: true,
        },
      }),
    );
    const exec = resultData(await client.callTool({ name: "execute_infrastructure_change", arguments: { operationId: prep.operationId } }));
    assert.strictEqual(exec.status, "pending");
    const stillPending = resultData(
      await client.callTool({ name: "get_operation", arguments: { operationId: prep.operationId, refresh: true } }),
    );
    assert.strictEqual(stillPending.status, "pending");
    misconfigured = false;
    const ready = resultData(
      await client.callTool({ name: "get_operation", arguments: { operationId: prep.operationId, refresh: true } }),
    );
    assert.strictEqual(ready.status, "succeeded");
  });
});

test("pending refresh reports remote errors without changing state", async () => {
  const fixture = await makeFixture();
  const { impl } = makeFetch({
    "GET /v2/teams/team_1": () => json({ id: "team_1", billing: { plan: "pro" } }),
    "GET /v9/projects/prj_1": () => json({ id: "prj_1", name: "app", accountId: "team_1" }),
    "POST /v2/files": () => new Response("", { status: 200 }),
    "POST /v13/deployments": () => json({ id: "dpl_1", readyState: "QUEUED", projectId: "prj_1" }),
    "GET /v13/deployments/dpl_1": () => json({ error: "boom" }, 503),
  });
  await withClient({ fixture, fetchImpl: impl, approve: true }, async ({ client }) => {
    const prep = resultData(
      await client.callTool({
        name: "prepare_infrastructure_change",
        arguments: {
          projectPath: fixture.project,
          action: { kind: "deploy_vercel", projectId: "prj_1", name: "app", source: { type: "local" } },
          maxMonthlyBudgetUsd: 20,
          commercialUse: true,
        },
      }),
    );
    const exec = resultData(await client.callTool({ name: "execute_infrastructure_change", arguments: { operationId: prep.operationId } }));
    assert.strictEqual(exec.status, "pending");
    const record = resultData(
      await client.callTool({ name: "get_operation", arguments: { operationId: prep.operationId, refresh: true } }),
    );
    assert.strictEqual(record.status, "pending");
    assert.strictEqual(record.refreshError, "PROVIDER_REQUEST_FAILED");
  });
});

test("reconcile finds a crashed deployment by operation metadata uid", async () => {
  const fixture = await makeFixture();
  let deployments = [];
  const { impl } = makeFetch({
    "GET /v2/teams/team_1": () => json({ id: "team_1", billing: { plan: "pro" } }),
    "GET /v9/projects/prj_1": () => json({ id: "prj_1", name: "app", accountId: "team_1" }),
    "POST /v2/files": () => {
      throw new Error("socket dropped");
    },
    "GET /v7/deployments": () => json({ deployments, pagination: { next: null } }),
  });
  await withClient({ fixture, fetchImpl: impl, approve: true }, async ({ client }) => {
    const prep = resultData(
      await client.callTool({
        name: "prepare_infrastructure_change",
        arguments: {
          projectPath: fixture.project,
          action: { kind: "deploy_vercel", projectId: "prj_1", name: "app", source: { type: "local" } },
          maxMonthlyBudgetUsd: 20,
          commercialUse: true,
        },
      }),
    );
    const exec = resultData(await client.callTool({ name: "execute_infrastructure_change", arguments: { operationId: prep.operationId } }));
    assert.ok(exec.error);
    deployments = [{ uid: "dpl_9", readyState: "READY", meta: { mcpDevopsOperationId: prep.operationId } }];
    const reconciled = resultData(
      await client.callTool({ name: "reconcile_operation", arguments: { operationId: prep.operationId } }),
    );
    assert.strictEqual(reconciled.status, "succeeded");
    assert.strictEqual(reconciled.result.deploymentId, "dpl_9");
  });
});

test("supabase reconcile attaches only with approval and never binds the stored password", async () => {
  const fixture = await makeFixture();
  const ref = "abcdefghijklmnopqrst";
  const { impl } = makeFetch({
    ...supabaseRoutes,
    "POST /v1/projects": () => {
      throw new Error("socket dropped");
    },
    [`GET /v1/projects/${ref}`]: () =>
      json({ ref, name: "db-proj", status: "ACTIVE_HEALTHY", organization_id: "org_1", created_at: new Date(Date.now() + 60_000).toISOString() }),
  });
  await withClient({ fixture, fetchImpl: impl, approve: true }, async ({ client, approvalRequests }) => {
    const prep = resultData(
      await client.callTool({
        name: "prepare_infrastructure_change",
        arguments: {
          projectPath: fixture.project,
          action: { kind: "create_supabase_project", name: "db-proj", organizationSlug: "org-slug", region: "us-east-1", plan: "pro" },
          maxMonthlyBudgetUsd: 50,
          commercialUse: true,
        },
      }),
    );
    const exec = resultData(await client.callTool({ name: "execute_infrastructure_change", arguments: { operationId: prep.operationId } }));
    assert.ok(exec.error);
    const reconciled = resultData(
      await client.callTool({ name: "reconcile_operation", arguments: { operationId: prep.operationId, resourceId: ref } }),
    );
    assert.strictEqual(reconciled.status, "succeeded");
    assert.strictEqual(reconciled.result.generatedPasswordBound, false);
    assert.ok(approvalRequests.some((req) => String(req.message).includes("Attach Supabase project")));
    const sync = await client.callTool({
      name: "prepare_infrastructure_change",
      arguments: {
        projectPath: fixture.project,
        action: { kind: "sync_supabase_env", projectRef: ref, sourceOperationId: prep.operationId },
        maxMonthlyBudgetUsd: 0,
        commercialUse: true,
      },
    });
    assert.strictEqual(resultData(sync).error.code, "UNPROVEN_CREDENTIAL");
  });
});

test("a missing credential vault blocks bound env syncs", async () => {
  const fixture = await makeFixture();
  const ref = "abcdefghijklmnopqrst";
  const { impl } = makeFetch({
    ...supabaseRoutes,
    [`GET /v1/projects/${ref}`]: () => json({ ref, name: "db-proj", status: "ACTIVE_HEALTHY", organization_id: "org_1" }),
    [`GET /v1/projects/${ref}/api-keys`]: () => json([{ name: "anon", type: "publishable", api_key: "pub-key-sentinel" }]),
  });
  await withClient({ fixture, fetchImpl: impl, approve: true }, async ({ client }) => {
    const prep = resultData(
      await client.callTool({
        name: "prepare_infrastructure_change",
        arguments: {
          projectPath: fixture.project,
          action: { kind: "create_supabase_project", name: "db-proj", organizationSlug: "org-slug", region: "us-east-1", plan: "pro" },
          maxMonthlyBudgetUsd: 50,
          commercialUse: true,
        },
      }),
    );
    const exec = resultData(await client.callTool({ name: "execute_infrastructure_change", arguments: { operationId: prep.operationId } }));
    assert.strictEqual(exec.status, "succeeded");
    await unlink(join(fixture.stateDir, "operations", `${prep.operationId}.secret.json`));
    const syncPrep = resultData(
      await client.callTool({
        name: "prepare_infrastructure_change",
        arguments: {
          projectPath: fixture.project,
          action: { kind: "sync_supabase_env", projectRef: ref, sourceOperationId: prep.operationId },
          maxMonthlyBudgetUsd: 50,
          commercialUse: true,
        },
      }),
    );
    assert.ok(syncPrep.operationId, JSON.stringify(syncPrep));
    const syncExec = await client.callTool({ name: "execute_infrastructure_change", arguments: { operationId: syncPrep.operationId } });
    assert.strictEqual(resultData(syncExec).error.code, "MISSING_OPERATION_SECRET");
    const envContent = await readFile(join(fixture.project, ".env"), "utf8").catch(() => "");
    assert.ok(!envContent.includes("SUPABASE_DB_PASSWORD"));
  });
});

test("tightened project roots hide and block existing operations", async () => {
  const fixture = await makeFixture();
  const { impl } = makeFetch(vercelRoutes);
  let operationId;
  await withClient({ fixture, fetchImpl: impl, approve: true }, async ({ client }) => {
    const prep = resultData(
      await client.callTool({
        name: "prepare_infrastructure_change",
        arguments: {
          projectPath: fixture.project,
          action: { kind: "create_vercel_project", name: "my-app" },
          maxMonthlyBudgetUsd: 50,
          commercialUse: true,
        },
      }),
    );
    operationId = prep.operationId;
    assert.ok(operationId);
  });
  await withClient({ fixture, fetchImpl: impl, approve: true, roots: [join(fixture.root, "other")] }, async ({ client }) => {
    const got = await client.callTool({ name: "get_operation", arguments: { operationId } });
    assert.strictEqual(resultData(got).error.code, "PATH_NOT_ALLOWED");
    const exec = await client.callTool({ name: "execute_infrastructure_change", arguments: { operationId } });
    assert.strictEqual(resultData(exec).error.code, "PATH_NOT_ALLOWED");
    const listed = resultData(await client.callTool({ name: "list_operations", arguments: {} }));
    assert.strictEqual(listed.operations.length, 0);
  });
});

test("unsafe state directories and corrupt records fail closed", async () => {
  {
    const fixture = await makeFixture();
    const real = join(fixture.root, "real-state");
    await mkdir(real);
    await symlink(real, fixture.stateDir);
    const { impl } = makeFetch(vercelRoutes);
    await withClient({ fixture, fetchImpl: impl, approve: true }, async ({ client }) => {
      const res = await client.callTool({
        name: "prepare_infrastructure_change",
        arguments: {
          projectPath: fixture.project,
          action: { kind: "create_vercel_project", name: "my-app" },
          maxMonthlyBudgetUsd: 50,
          commercialUse: true,
        },
      });
      assert.strictEqual(resultData(res).error.code, "UNSAFE_STATE_DIR");
    });
  }
  {
    const fixture = await makeFixture();
    await mkdir(fixture.stateDir);
    await chmod(fixture.stateDir, 0o700);
    const outside = join(fixture.root, "ops-outside");
    await mkdir(outside);
    await symlink(outside, join(fixture.stateDir, "operations"));
    const { impl } = makeFetch(vercelRoutes);
    await withClient({ fixture, fetchImpl: impl, approve: true }, async ({ client }) => {
      const res = await client.callTool({
        name: "prepare_infrastructure_change",
        arguments: {
          projectPath: fixture.project,
          action: { kind: "create_vercel_project", name: "my-app" },
          maxMonthlyBudgetUsd: 50,
          commercialUse: true,
        },
      });
      assert.strictEqual(resultData(res).error.code, "UNSAFE_STATE_DIR");
    });
  }
  {
    const fixture = await makeFixture();
    await mkdir(fixture.stateDir);
    await chmod(fixture.stateDir, 0o755);
    const { impl } = makeFetch(vercelRoutes);
    await withClient({ fixture, fetchImpl: impl, approve: true }, async ({ client }) => {
      const res = await client.callTool({
        name: "prepare_infrastructure_change",
        arguments: {
          projectPath: fixture.project,
          action: { kind: "create_vercel_project", name: "my-app" },
          maxMonthlyBudgetUsd: 50,
          commercialUse: true,
        },
      });
      assert.strictEqual(resultData(res).error.code, "UNSAFE_STATE_DIR");
    });
  }
});

test("corrupt operation records block new work and are never overwritten", async () => {
  const seed = async (fixture) => {
    const ops = join(fixture.stateDir, "operations");
    await mkdir(ops, { recursive: true });
    await chmod(fixture.stateDir, 0o700);
    await chmod(ops, 0o700);
    return ops;
  };
  const baseOp = (id, fixture) => ({
    version: 1,
    id,
    projectPath: fixture.project,
    action: { kind: "create_vercel_project", name: "app", framework: null },
    account: { provider: "vercel", id: "team_1" },
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    status: "prepared",
    costCommitted: false,
    maxMonthlyBudgetUsd: 50,
    maxUpfrontBudgetUsd: 0,
    estimatedMonthlyUsageUsd: 0,
    commercialUse: true,
    estimate: {
      currency: "USD",
      recurringItems: [{ key: "vercel:team_1:subscription", cents: 2000 }],
      upfrontCents: 0,
      estimatedMonthlyCostUsd: 20,
      estimatedUpfrontCostUsd: 0,
      scope: "managed_project_baseline",
      hardCap: false,
      warnings: [],
    },
    preconditions: {},
    events: [{ at: new Date().toISOString(), event: "prepared" }],
  });
  const prepareArgs = (fixture) => ({
    name: "prepare_infrastructure_change",
    arguments: {
      projectPath: fixture.project,
      action: { kind: "create_vercel_project", name: "my-app" },
      maxMonthlyBudgetUsd: 50,
      commercialUse: true,
    },
  });
  {
    const fixture = await makeFixture();
    const ops = await seed(fixture);
    const garbage = join(ops, `${randomUUID()}.json`);
    await writeFile(garbage, "{not json");
    const { impl } = makeFetch(vercelRoutes);
    await withClient({ fixture, fetchImpl: impl, approve: true }, async ({ client }) => {
      const res = await client.callTool(prepareArgs(fixture));
      assert.strictEqual(resultData(res).error.code, "CORRUPT_STATE");
    });
    assert.strictEqual(await readFile(garbage, "utf8"), "{not json");
  }
  {
    const fixture = await makeFixture();
    const ops = await seed(fixture);
    const id = randomUUID();
    const bad = { ...baseOp(id, fixture), estimate: { ...baseOp(id, fixture).estimate, upfrontCents: -5 } };
    await writeFile(join(ops, `${id}.json`), JSON.stringify(bad));
    const { impl } = makeFetch(vercelRoutes);
    await withClient({ fixture, fetchImpl: impl, approve: true }, async ({ client }) => {
      const res = await client.callTool(prepareArgs(fixture));
      assert.strictEqual(resultData(res).error.code, "CORRUPT_STATE");
    });
  }
  {
    const fixture = await makeFixture();
    const ops = await seed(fixture);
    const id = randomUUID();
    const bad = { ...baseOp(id, fixture), createdAt: "not-a-timestamp" };
    await writeFile(join(ops, `${id}.json`), JSON.stringify(bad));
    const { impl } = makeFetch(vercelRoutes);
    await withClient({ fixture, fetchImpl: impl, approve: true }, async ({ client }) => {
      const res = await client.callTool(prepareArgs(fixture));
      assert.strictEqual(resultData(res).error.code, "CORRUPT_STATE");
    });
  }
  {
    const fixture = await makeFixture();
    const ops = await seed(fixture);
    const id = randomUUID();
    const file = join(ops, `${id}.json`);
    await writeFile(file, JSON.stringify(baseOp(id, fixture)));
    await link(file, join(ops, `${randomUUID()}.json`));
    const { impl } = makeFetch(vercelRoutes);
    await withClient({ fixture, fetchImpl: impl, approve: true }, async ({ client }) => {
      const res = await client.callTool(prepareArgs(fixture));
      assert.strictEqual(resultData(res).error.code, "UNSAFE_STATE_DIR");
    });
  }
  {
    const fixture = await makeFixture();
    const ops = await seed(fixture);
    const id = randomUUID();
    const target = join(fixture.root, "elsewhere.json");
    await writeFile(target, JSON.stringify(baseOp(id, fixture)));
    await symlink(target, join(ops, `${id}.json`));
    const { impl } = makeFetch(vercelRoutes);
    await withClient({ fixture, fetchImpl: impl, approve: true }, async ({ client }) => {
      const res = await client.callTool(prepareArgs(fixture));
      assert.strictEqual(resultData(res).error.code, "UNSAFE_STATE_DIR");
    });
  }
});

test("operation locks reject live or unreadable holders and take over dead ones", async () => {
  const seed = async (fixture) => {
    const ops = join(fixture.stateDir, "operations");
    await mkdir(ops, { recursive: true });
    await chmod(fixture.stateDir, 0o700);
    await chmod(ops, 0o700);
    return ops;
  };
  const prepareArgs = (fixture) => ({
    name: "prepare_infrastructure_change",
    arguments: {
      projectPath: fixture.project,
      action: { kind: "create_vercel_project", name: "my-app" },
      maxMonthlyBudgetUsd: 50,
      commercialUse: true,
    },
  });
  const nonce = "a".repeat(24);
  {
    const fixture = await makeFixture();
    const ops = await seed(fixture);
    await writeFile(join(ops, "operations.lock"), JSON.stringify({ pid: process.pid, hostname: hostname(), nonce }));
    const { impl } = makeFetch(vercelRoutes);
    await withClient({ fixture, fetchImpl: impl, approve: true }, async ({ client }) => {
      const res = await client.callTool(prepareArgs(fixture));
      assert.strictEqual(resultData(res).error.code, "FILE_BUSY");
    });
  }
  {
    const fixture = await makeFixture();
    const ops = await seed(fixture);
    await writeFile(join(ops, "operations.lock"), JSON.stringify({ pid: "nope" }));
    const { impl } = makeFetch(vercelRoutes);
    await withClient({ fixture, fetchImpl: impl, approve: true }, async ({ client }) => {
      const res = await client.callTool(prepareArgs(fixture));
      assert.strictEqual(resultData(res).error.code, "FILE_BUSY");
    });
  }
  {
    const fixture = await makeFixture();
    const ops = await seed(fixture);
    const { stdout } = await promisify(execFile)(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]);
    const deadPid = Number(stdout);
    assert.ok(Number.isInteger(deadPid) && deadPid > 0);
    await writeFile(join(ops, "operations.lock"), JSON.stringify({ pid: deadPid, hostname: hostname(), nonce }));
    const { impl } = makeFetch(vercelRoutes);
    await withClient({ fixture, fetchImpl: impl, approve: true }, async ({ client }) => {
      const res = resultData(await client.callTool(prepareArgs(fixture)));
      assert.ok(res.operationId, JSON.stringify(res));
    });
  }
});

test("approval prompts disclose the exact action, warnings and budgets", async () => {
  const fixture = await makeFixture();
  const { impl } = makeFetch({
    "GET /client/v4/accounts/acc_1": () => json({ success: true, result: { id: "acc_1" } }),
    "POST /client/v4/accounts/acc_1/registrar/domain-check": () =>
      json({ success: true, result: { domains: [{ name: "example.com", registrable: true, tier: "standard", pricing: { currency: "USD", registration_cost: "8.57", renewal_cost: "10.11" } }] } }),
    "POST /client/v4/accounts/acc_1/registrar/registrations": () =>
      json({ success: true, result: { domain_name: "example.com", state: "succeeded", completed: true } }, 201),
  });
  await withClient({ fixture, fetchImpl: impl, approve: true }, async ({ client, approvalRequests }) => {
    const prep = resultData(
      await client.callTool({
        name: "prepare_infrastructure_change",
        arguments: {
          projectPath: fixture.project,
          action: { kind: "register_domain", domain: "example.com", years: 2 },
          maxMonthlyBudgetUsd: 0,
          maxUpfrontBudgetUsd: 20,
          commercialUse: true,
        },
      }),
    );
    await client.callTool({ name: "execute_infrastructure_change", arguments: { operationId: prep.operationId } });
    const message = approvalRequests.at(-1).message;
    assert.ok(message.includes('"domain":"example.com"'));
    assert.ok(message.includes('"years":2'));
    assert.ok(message.includes("non-refundable"));
    assert.ok(message.includes("maximum-price"));
    assert.ok(message.includes("18.68"));
    assert.ok(message.includes(prep.operationId));
    assert.ok(!message.includes(TOKEN));
  });
});

test("approval prompts disclose dns diffs, source files and privileged keys", async () => {
  const fixture = await makeFixture();
  const records = [{ id: "rec_1", type: "A", name: "www.example.com", content: "192.0.2.1", ttl: 300, proxied: false }];
  const { impl } = makeFetch({
    "GET /client/v4/accounts/acc_1": () => json({ success: true, result: { id: "acc_1" } }),
    "GET /client/v4/zones/zone_1": () =>
      json({ success: true, result: { id: "zone_1", name: "example.com", status: "active", account: { id: "acc_1" } } }),
    "GET /client/v4/zones/zone_1/dns_records": () => json({ success: true, result: records, result_info: { total_pages: 1 } }),
    "GET /client/v4/zones/zone_1/dns_records/rec_1": () => json({ success: true, result: records[0] }),
    "PUT /client/v4/zones/zone_1/dns_records/rec_1": (_u, init) => json({ success: true, result: { id: "rec_1", ...JSON.parse(init.body) } }),
    "GET /v1/organizations/org-slug": () => json({ id: "org_1", name: "Org", plan: "pro" }),
    "GET /v1/projects/abcdefghijklmnopqrst": () =>
      json({ ref: "abcdefghijklmnopqrst", name: "db-proj", status: "ACTIVE_HEALTHY", organization_id: "org_1" }),
    "GET /v1/projects/abcdefghijklmnopqrst/api-keys": () =>
      json([
        { name: "anon", type: "publishable", api_key: "pub-key-sentinel" },
        { name: "service", type: "secret", api_key: "service-key-sentinel" },
      ]),
  });
  await withClient({ fixture, fetchImpl: impl, approve: true }, async ({ client, approvalRequests }) => {
    const dnsPrep = resultData(
      await client.callTool({
        name: "prepare_infrastructure_change",
        arguments: {
          projectPath: fixture.project,
          action: { kind: "upsert_dns_record", zoneId: "zone_1", type: "A", name: "www.example.com", content: "192.0.2.9", recordId: "rec_1" },
          maxMonthlyBudgetUsd: 0,
          commercialUse: true,
        },
      }),
    );
    await client.callTool({ name: "execute_infrastructure_change", arguments: { operationId: dnsPrep.operationId } });
    const dnsMessage = approvalRequests.at(-1).message;
    assert.ok(dnsMessage.includes('"from"'));
    assert.ok(dnsMessage.includes('"content":"192.0.2.9"'));

    const syncPrep = resultData(
      await client.callTool({
        name: "prepare_infrastructure_change",
        arguments: {
          projectPath: fixture.project,
          action: { kind: "sync_supabase_env", projectRef: "abcdefghijklmnopqrst", includeServiceRole: true },
          maxMonthlyBudgetUsd: 0,
          commercialUse: true,
        },
      }),
    );
    assert.ok(syncPrep.operationId, JSON.stringify(syncPrep));
    const syncExec = resultData(
      await client.callTool({ name: "execute_infrastructure_change", arguments: { operationId: syncPrep.operationId } }),
    );
    assert.strictEqual(syncExec.status, "succeeded");
    const syncMessage = approvalRequests.at(-1).message;
    assert.ok(syncMessage.includes("service-role"));
    assert.ok(syncMessage.includes("full database access"));
    const envContent = await readFile(join(fixture.project, ".env"), "utf8");
    assert.ok(envContent.includes("SUPABASE_SECRET_KEY="));
    for (const req of approvalRequests) {
      assert.ok(!String(req.message).includes("service-key-sentinel"));
      assert.ok(!String(req.message).includes("pub-key-sentinel"));
    }
  });
});

test("deploy approval lists source files and deploy previews honor the dotfile allowlist", async () => {
  const fixture = await makeFixture();
  await writeFile(join(fixture.project, ".nvmrc"), "20\n");
  await writeFile(join(fixture.project, ".npmrc"), "//registry.npmjs.org/:_authToken=secret\n");
  const { impl } = makeFetch({
    "GET /v2/teams/team_1": () => json({ id: "team_1", billing: { plan: "pro" } }),
    "GET /v9/projects/prj_1": () => json({ id: "prj_1", name: "app", accountId: "team_1" }),
    "POST /v2/files": () => new Response("", { status: 200 }),
    "POST /v13/deployments": () => json({ id: "dpl_1", readyState: "READY", projectId: "prj_1" }),
  });
  await withClient({ fixture, fetchImpl: impl, approve: true }, async ({ client, approvalRequests }) => {
    const prep = resultData(
      await client.callTool({
        name: "prepare_infrastructure_change",
        arguments: {
          projectPath: fixture.project,
          action: { kind: "deploy_vercel", projectId: "prj_1", name: "app", source: { type: "local" } },
          maxMonthlyBudgetUsd: 20,
          commercialUse: true,
        },
      }),
    );
    assert.ok(prep.preview.sourceFiles.includes(".nvmrc"));
    assert.ok(!prep.preview.sourceFiles.includes(".npmrc"));
    assert.ok(prep.warnings.some((warning) => warning.includes(".npmrc")));
    const exec = resultData(await client.callTool({ name: "execute_infrastructure_change", arguments: { operationId: prep.operationId } }));
    assert.strictEqual(exec.status, "succeeded");
    const message = approvalRequests.at(-1).message;
    assert.ok(message.includes("index.html"));
    assert.ok(message.includes("hardcoded"));
    assert.ok(message.includes("digest"));
  });
});

test("dns conflict detection covers type changes and txt content wildcards are allowed", async () => {
  const fixture = await makeFixture();
  const records = [
    { id: "rec_1", type: "A", name: "www.example.com", content: "192.0.2.1", ttl: 300, proxied: false },
    { id: "rec_2", type: "AAAA", name: "www.example.com", content: "2001:db8::1", ttl: 300, proxied: false },
  ];
  const { impl } = makeFetch({
    "GET /client/v4/accounts/acc_1": () => json({ success: true, result: { id: "acc_1" } }),
    "GET /client/v4/zones/zone_1": () =>
      json({ success: true, result: { id: "zone_1", name: "example.com", status: "active", account: { id: "acc_1" } } }),
    "GET /client/v4/zones/zone_1/dns_records": () => json({ success: true, result: records, result_info: { total_pages: 1 } }),
    "GET /client/v4/zones/zone_1/dns_records/rec_1": () => json({ success: true, result: records[0] }),
  });
  await withClient({ fixture, fetchImpl: impl, approve: true }, async ({ client }) => {
    const cname = await client.callTool({
      name: "prepare_infrastructure_change",
      arguments: {
        projectPath: fixture.project,
        action: { kind: "upsert_dns_record", zoneId: "zone_1", type: "CNAME", name: "www.example.com", content: "target.example.net", recordId: "rec_1" },
        maxMonthlyBudgetUsd: 0,
        commercialUse: true,
      },
    });
    assert.strictEqual(resultData(cname).error.code, "DNS_CONFLICT");
    records.length = 0;
    const txt = resultData(
      await client.callTool({
        name: "prepare_infrastructure_change",
        arguments: {
          projectPath: fixture.project,
          action: { kind: "upsert_dns_record", zoneId: "zone_1", type: "TXT", name: "www.example.com", content: "v=spf1 * ~all" },
          maxMonthlyBudgetUsd: 0,
          commercialUse: true,
        },
      }),
    );
    assert.ok(txt.operationId, JSON.stringify(txt));
  });
});

test("reconcile requires the current provider account to match", async () => {
  const fixture = await makeFixture();
  const records = [{ id: "rec_1", type: "A", name: "www.example.com", content: "192.0.2.1", ttl: 300, proxied: false }];
  const { impl } = makeFetch({
    "GET /client/v4/accounts/acc_1": () => json({ success: true, result: { id: "acc_1" } }),
    "GET /client/v4/accounts/acc_2": () => json({ success: true, result: { id: "acc_2" } }),
    "GET /client/v4/zones/zone_1": () =>
      json({ success: true, result: { id: "zone_1", name: "example.com", status: "active", account: { id: "acc_1" } } }),
    "GET /client/v4/zones/zone_1/dns_records": () => json({ success: true, result: records, result_info: { total_pages: 1 } }),
    "GET /client/v4/zones/zone_1/dns_records/rec_1": () => json({ success: true, result: records[0] }),
    "PUT /client/v4/zones/zone_1/dns_records/rec_1": () => json({ success: false, errors: [{ code: 5000 }] }, 503),
  });
  let operationId;
  await withClient({ fixture, fetchImpl: impl, approve: true }, async ({ client }) => {
    const prep = resultData(
      await client.callTool({
        name: "prepare_infrastructure_change",
        arguments: {
          projectPath: fixture.project,
          action: { kind: "upsert_dns_record", zoneId: "zone_1", type: "A", name: "www.example.com", content: "192.0.2.9", recordId: "rec_1" },
          maxMonthlyBudgetUsd: 0,
          commercialUse: true,
        },
      }),
    );
    operationId = prep.operationId;
    const exec = resultData(await client.callTool({ name: "execute_infrastructure_change", arguments: { operationId } }));
    assert.ok(exec.error);
    const record = resultData(await client.callTool({ name: "get_operation", arguments: { operationId } }));
    assert.strictEqual(record.status, "unknown");
  });
  const creds2 = { ...CREDS, cloudflareAccountId: "acc_2" };
  await withClient({ fixture, fetchImpl: impl, approve: true, creds: creds2 }, async ({ client }) => {
    const reconciled = await client.callTool({ name: "reconcile_operation", arguments: { operationId } });
    assert.strictEqual(resultData(reconciled).error.code, "ACCOUNT_MISMATCH");
  });
});

test("budgets are per local project; another project's spend is invisible", async () => {
  const fixture = await makeFixture();
  const other = join(fixture.root, "other-app");
  await mkdir(other, { recursive: true });
  await writeFile(join(other, "package.json"), JSON.stringify({ name: "other" }));
  const { impl } = makeFetch(vercelRoutes);
  await withClient({ fixture, fetchImpl: impl, approve: true }, async ({ client }) => {
    const prepareArgs = (projectPath) => ({
      name: "prepare_infrastructure_change",
      arguments: {
        projectPath,
        action: { kind: "create_vercel_project", name: "my-app" },
        maxMonthlyBudgetUsd: 20,
        commercialUse: true,
      },
    });
    const a = resultData(await client.callTool(prepareArgs(fixture.project)));
    const b = resultData(await client.callTool(prepareArgs(other)));
    assert.ok(a.operationId);
    assert.ok(b.operationId);
    assert.strictEqual(a.projectedCosts.monthlyUsd, 20);
    assert.strictEqual(b.projectedCosts.monthlyUsd, 20);
    assert.match(b.projectedCosts.scope, /this project/);
  });
});

test("documented vercel domain responses parse and connect-domain succeeds end to end", async () => {
  const fixture = await makeFixture();
  const projectBody = {
    id: "prj_canon",
    name: "my-app",
    accountId: "team_1",
    targets: {
      production: {
        id: "dpl_prod",
        alias: ["my-app.vercel.app"],
        readyState: "READY",
        createdAt: 1700000000000,
        meta: { secret: "SENTINEL_META" },
      },
      staging: null,
    },
  };
  const { impl, calls } = makeFetch({
    "GET /v2/teams/team_1": () => json({ id: "team_1", billing: { plan: "pro" } }),
    "GET /v9/projects/my-app": () => json(projectBody),
    "GET /v9/projects/prj_canon": () => json(projectBody),
    "POST /v10/projects/prj_canon/domains": () =>
      json({
        name: "example.com",
        apexName: "example.com",
        projectId: "prj_canon",
        verified: true,
        createdAt: 1700000000000,
        verification: [{ type: "TXT", domain: "_vercel.example.com", value: "vc-verify-1", reason: "pending" }],
        meta: { token: "SENTINEL_META" },
      }),
    "GET /v9/projects/prj_canon/domains/example.com": () =>
      json({
        name: "example.com",
        apexName: "example.com",
        projectId: "prj_canon",
        verified: true,
        createdAt: 1700000000000,
        verification: [{ type: "TXT", domain: "_vercel.example.com", value: "vc-verify-1" }],
        meta: { token: "SENTINEL_META" },
      }),
    "GET /v6/domains/example.com/config": () =>
      json({ misconfigured: false, recommendedCNAME: [{ rank: 1, value: "cname.vercel-dns.com" }] }),
  });
  await withClient({ fixture, fetchImpl: impl, approve: true }, async ({ client }) => {
    const prep = resultData(
      await client.callTool({
        name: "prepare_infrastructure_change",
        arguments: {
          projectPath: fixture.project,
          action: { kind: "connect_vercel_domain", projectId: "my-app", domain: "example.com" },
          maxMonthlyBudgetUsd: 20,
          commercialUse: true,
        },
      }),
    );
    assert.ok(prep.operationId);
    assert.strictEqual(prep.action.projectId, "prj_canon");
    const exec = resultData(
      await client.callTool({ name: "execute_infrastructure_change", arguments: { operationId: prep.operationId } }),
    );
    assert.strictEqual(exec.status, "succeeded");
    assert.strictEqual(exec.result.domain, "example.com");
    assert.strictEqual(exec.result.verified, true);
    assert.ok(!JSON.stringify(exec).includes("SENTINEL_META"));
    const domainPost = calls.find((c) => c.method === "POST" && c.path.endsWith("/domains"));
    assert.ok(domainPost);
    assert.strictEqual(domainPost.path, "/v10/projects/prj_canon/domains");
  });
});

test("deploy names must equal the real project name", async () => {
  const fixture = await makeFixture();
  const { impl } = makeFetch({
    "GET /v2/teams/team_1": () => json({ id: "team_1", billing: { plan: "pro" } }),
    "GET /v9/projects/prj_1": () => json({ id: "prj_1", name: "real-app", accountId: "team_1" }),
  });
  await withClient({ fixture, fetchImpl: impl, approve: true }, async ({ client }) => {
    const prep = await client.callTool({
      name: "prepare_infrastructure_change",
      arguments: {
        projectPath: fixture.project,
        action: { kind: "deploy_vercel", projectId: "prj_1", name: "someone-else", source: { type: "local" } },
        maxMonthlyBudgetUsd: 50,
        commercialUse: true,
      },
    });
    assert.strictEqual(prep.isError, true);
    assert.strictEqual(resultData(prep).error.code, "PROJECT_NAME_MISMATCH");
  });
});

test("project reassignment during approval blocks the mutation", async () => {
  const fixture = await makeFixture();
  let canonical = { id: "prj_canon", name: "my-app", accountId: "team_1" };
  const { impl, calls } = makeFetch({
    "GET /v2/teams/team_1": () => json({ id: "team_1", billing: { plan: "pro" } }),
    "GET /v9/projects/my-app": () => json(canonical),
    "GET /v9/projects/prj_canon": () => json(canonical),
    "POST /v10/projects/prj_canon/domains": () => json({ name: "example.com", verified: true }),
  });
  await withClient(
    {
      fixture,
      fetchImpl: impl,
      approve: () => {
        canonical = { id: "prj_hijacked", name: "stolen-app", accountId: "team_1" };
        return "accept";
      },
    },
    async ({ client }) => {
      const prep = resultData(
        await client.callTool({
          name: "prepare_infrastructure_change",
          arguments: {
            projectPath: fixture.project,
            action: { kind: "connect_vercel_domain", projectId: "my-app", domain: "example.com" },
            maxMonthlyBudgetUsd: 20,
            commercialUse: true,
          },
        }),
      );
      assert.strictEqual(prep.action.projectId, "prj_canon");
      const exec = await client.callTool({
        name: "execute_infrastructure_change",
        arguments: { operationId: prep.operationId },
      });
      assert.strictEqual(exec.isError, true);
      assert.strictEqual(calls.filter((c) => c.method === "POST").length, 0);
    },
  );
});

test("initial terminal provider responses fail instead of staying pending", async () => {
  const fixture = await makeFixture();
  const { impl } = makeFetch({
    "GET /client/v4/accounts/acc_1": () => json({ success: true, result: { id: "acc_1" } }),
    "POST /client/v4/accounts/acc_1/registrar/domain-check": () =>
      json({ success: true, result: { domains: [{ name: "example.com", registrable: true, tier: "standard", pricing: { currency: "USD", registration_cost: "8.57", renewal_cost: "10.11" } }] } }),
    "POST /client/v4/accounts/acc_1/registrar/registrations": () =>
      json({ success: true, result: { domain_name: "example.com", state: "failed", completed: false } }, 202),
  });
  await withClient({ fixture, fetchImpl: impl, approve: true }, async ({ client }) => {
    const prep = resultData(
      await client.callTool({
        name: "prepare_infrastructure_change",
        arguments: {
          projectPath: fixture.project,
          action: { kind: "register_domain", domain: "example.com", years: 1 },
          maxMonthlyBudgetUsd: 0,
          maxUpfrontBudgetUsd: 20,
          commercialUse: true,
        },
      }),
    );
    const exec = resultData(
      await client.callTool({ name: "execute_infrastructure_change", arguments: { operationId: prep.operationId } }),
    );
    assert.strictEqual(exec.status, "failed");
  });

  const fixture2 = await makeFixture();
  const { impl: impl2 } = makeFetch({
    "GET /v2/teams/team_1": () => json({ id: "team_1", billing: { plan: "pro" } }),
    "GET /v9/projects/prj_1": () => json({ id: "prj_1", name: "app", accountId: "team_1" }),
    "POST /v2/files": () => new Response(null, { status: 200 }),
    "POST /v13/deployments": () => json({ id: "dpl_err", readyState: "ERROR", projectId: "prj_1" }),
  });
  await withClient({ fixture: fixture2, fetchImpl: impl2, approve: true }, async ({ client }) => {
    const prep = resultData(
      await client.callTool({
        name: "prepare_infrastructure_change",
        arguments: {
          projectPath: fixture2.project,
          action: { kind: "deploy_vercel", projectId: "prj_1", name: "app", source: { type: "local" } },
          maxMonthlyBudgetUsd: 50,
          commercialUse: true,
        },
      }),
    );
    const exec = resultData(
      await client.callTool({ name: "execute_infrastructure_change", arguments: { operationId: prep.operationId } }),
    );
    assert.strictEqual(exec.status, "failed");
    assert.strictEqual(exec.result.deploymentId, "dpl_err");
  });
});

test("terminal operations stay hidden after roots tighten and make no remote calls", async () => {
  const fixture = await makeFixture();
  const { impl } = makeFetch(vercelRoutes);
  let operationId;
  await withClient({ fixture, fetchImpl: impl, approve: true }, async ({ client }) => {
    const prep = resultData(
      await client.callTool({
        name: "prepare_infrastructure_change",
        arguments: {
          projectPath: fixture.project,
          action: { kind: "create_vercel_project", name: "my-app" },
          maxMonthlyBudgetUsd: 50,
          commercialUse: true,
        },
      }),
    );
    operationId = prep.operationId;
    const exec = resultData(
      await client.callTool({ name: "execute_infrastructure_change", arguments: { operationId } }),
    );
    assert.strictEqual(exec.status, "succeeded");
  });
  let remoteCalls = 0;
  const counting = async () => {
    remoteCalls += 1;
    return json({}, 200);
  };
  await withClient(
    { fixture, fetchImpl: counting, approve: true, roots: [join(fixture.root, "other")] },
    async ({ client }) => {
      const got = await client.callTool({ name: "get_operation", arguments: { operationId } });
      assert.strictEqual(resultData(got).error.code, "PATH_NOT_ALLOWED");
      const exec = await client.callTool({ name: "execute_infrastructure_change", arguments: { operationId } });
      assert.strictEqual(resultData(exec).error.code, "PATH_NOT_ALLOWED");
      const rec = await client.callTool({ name: "reconcile_operation", arguments: { operationId } });
      assert.strictEqual(resultData(rec).error.code, "PATH_NOT_ALLOWED");
    },
  );
  assert.strictEqual(remoteCalls, 0);
});

test("registration-status 404 keeps the operation pending with guidance", async () => {
  const fixture = await makeFixture();
  let registered = false;
  const { impl } = makeFetch({
    "GET /client/v4/accounts/acc_1": () => json({ success: true, result: { id: "acc_1" } }),
    "POST /client/v4/accounts/acc_1/registrar/domain-check": () =>
      json({ success: true, result: { domains: [{ name: "example.com", registrable: true, tier: "standard", pricing: { currency: "USD", registration_cost: "8.57", renewal_cost: "10.11" } }] } }),
    "POST /client/v4/accounts/acc_1/registrar/registrations": () => {
      registered = true;
      return json({ success: true, result: { domain_name: "example.com", state: "running", completed: false } }, 202);
    },
    "GET /client/v4/accounts/acc_1/registrar/registrations/example.com": () =>
      registered ? json({ success: false, errors: [{ code: 1000 }] }, 404) : json({ success: false, errors: [{ code: 1000 }] }, 404),
    "GET /client/v4/accounts/acc_1/registrar/registrations/example.com/registration-status": () =>
      json({ success: false, errors: [{ code: 1000 }] }, 404),
  });
  await withClient({ fixture, fetchImpl: impl, approve: true }, async ({ client }) => {
    const prep = resultData(
      await client.callTool({
        name: "prepare_infrastructure_change",
        arguments: {
          projectPath: fixture.project,
          action: { kind: "register_domain", domain: "example.com", years: 1 },
          maxMonthlyBudgetUsd: 0,
          maxUpfrontBudgetUsd: 20,
          commercialUse: true,
        },
      }),
    );
    const exec = resultData(
      await client.callTool({ name: "execute_infrastructure_change", arguments: { operationId: prep.operationId } }),
    );
    assert.strictEqual(exec.status, "pending");
    const refreshed = resultData(
      await client.callTool({ name: "get_operation", arguments: { operationId: prep.operationId, refresh: true } }),
    );
    assert.strictEqual(refreshed.status, "pending");
    assert.ok(refreshed.result.nextSteps);
  });
});

test("pending refresh validates the configured provider account", async () => {
  const fixture = await makeFixture();
  const { impl } = makeFetch({
    "GET /v2/teams/team_1": () => json({ id: "team_1", billing: { plan: "pro" } }),
    "GET /v2/teams/team_2": () => json({ id: "team_2", billing: { plan: "pro" } }),
    "GET /v9/projects/prj_1": () => json({ id: "prj_1", name: "app", accountId: "team_1" }),
    "POST /v10/projects/prj_1/domains": () => json({ name: "example.com", verified: false }),
    "GET /v9/projects/prj_1/domains/example.com": () => json({ name: "example.com", verified: false }),
    "GET /v6/domains/example.com/config": () => json({ misconfigured: true }),
  });
  let operationId;
  await withClient({ fixture, fetchImpl: impl, approve: true }, async ({ client }) => {
    const prep = resultData(
      await client.callTool({
        name: "prepare_infrastructure_change",
        arguments: {
          projectPath: fixture.project,
          action: { kind: "connect_vercel_domain", projectId: "prj_1", domain: "example.com" },
          maxMonthlyBudgetUsd: 20,
          commercialUse: true,
        },
      }),
    );
    operationId = prep.operationId;
    const exec = resultData(await client.callTool({ name: "execute_infrastructure_change", arguments: { operationId } }));
    assert.strictEqual(exec.status, "pending");
  });
  const creds2 = { ...CREDS, vercelTeamId: "team_2" };
  await withClient({ fixture, fetchImpl: impl, approve: true, creds: creds2 }, async ({ client }) => {
    const refreshed = resultData(
      await client.callTool({ name: "get_operation", arguments: { operationId, refresh: true } }),
    );
    assert.strictEqual(refreshed.status, "pending");
    assert.strictEqual(refreshed.refreshError, "ACCOUNT_MISMATCH");
  });
});

test("cancelling during approval prevents any remote mutation or state write", async () => {
  const fixture = await makeFixture();
  const { impl, calls } = makeFetch(vercelRoutes);
  const controller = new AbortController();
  await withClient(
    {
      fixture,
      fetchImpl: impl,
      approve: () => {
        controller.abort();
        return "accept";
      },
    },
    async ({ client }) => {
      const prep = resultData(
        await client.callTool({
          name: "prepare_infrastructure_change",
          arguments: {
            projectPath: fixture.project,
            action: { kind: "create_vercel_project", name: "my-app" },
            maxMonthlyBudgetUsd: 50,
            commercialUse: true,
          },
        }),
      );
      const exec = await client
        .callTool(
          { name: "execute_infrastructure_change", arguments: { operationId: prep.operationId } },
          undefined,
          { signal: controller.signal },
        )
        .then(
          (res) => res,
          (err) => err,
        );
      const isAbort =
        (exec && exec.isError && resultData(exec).error?.code === "CANCELLED") ||
        (exec && exec.code === -32001);
      assert.ok(isAbort, `expected a cancelled outcome, got ${JSON.stringify(exec)}`);
      assert.strictEqual(calls.filter((c) => c.method === "POST").length, 0);
      const status = resultData(
        await client.callTool({ name: "get_operation", arguments: { operationId: prep.operationId } }),
      );
      assert.notStrictEqual(status.status, "running");
    },
  );
});

test("name-addressed vercel operations use the canonical id for usage keys", async () => {
  const fixture = await makeFixture();
  const projectBody = { id: "prj_canon", name: "my-app", accountId: "team_1" };
  const { impl } = makeFetch({
    "GET /v2/teams/team_1": () => json({ id: "team_1", billing: { plan: "pro" } }),
    "GET /v9/projects/my-app": () => json(projectBody),
    "GET /v9/projects/prj_canon": () => json(projectBody),
    "POST /v10/projects/prj_canon/domains": () =>
      json({ name: "example.com", apexName: "example.com", projectId: "prj_canon", verified: true, createdAt: 1 }),
    "GET /v9/projects/prj_canon/domains/example.com": () =>
      json({ name: "example.com", projectId: "prj_canon", verified: true }),
    "GET /v6/domains/example.com/config": () => json({ misconfigured: false }),
  });
  await withClient({ fixture, fetchImpl: impl, approve: true }, async ({ client }) => {
    const prep = resultData(
      await client.callTool({
        name: "prepare_infrastructure_change",
        arguments: {
          projectPath: fixture.project,
          action: { kind: "connect_vercel_domain", projectId: "my-app", domain: "example.com" },
          maxMonthlyBudgetUsd: 25,
          estimatedMonthlyUsageUsd: 5,
          commercialUse: true,
        },
      }),
    );
    assert.ok(prep.operationId);
    assert.strictEqual(prep.action.projectId, "prj_canon");
    assert.strictEqual(prep.estimate.estimatedMonthlyCostUsd, 25);
    const usageKey = prep.estimate.recurringItems.find((item) => item.key.includes(":usage:"))?.key;
    assert.ok(usageKey);
    assert.ok(usageKey.endsWith(":prj_canon"), `usage key should end with canonical id: ${usageKey}`);
    const exec = resultData(
      await client.callTool({ name: "execute_infrastructure_change", arguments: { operationId: prep.operationId } }),
    );
    assert.strictEqual(exec.status, "succeeded");
  });
});

test("rollback accepts a project name and compares against the canonical id", async () => {
  const fixture = await makeFixture();
  const projectBody = {
    id: "prj_canon",
    name: "my-app",
    accountId: "team_1",
    targets: { production: { id: "dpl_old", alias: ["a"], readyState: "READY", createdAt: 1 } },
  };
  const { impl, calls } = makeFetch({
    "GET /v2/teams/team_1": () => json({ id: "team_1", billing: { plan: "pro" } }),
    "GET /v9/projects/my-app": () => json(projectBody),
    "GET /v9/projects/prj_canon": () => json(projectBody),
    "GET /v13/deployments/dpl_old": () =>
      json({ id: "dpl_old", readyState: "READY", target: "production", projectId: "prj_canon" }),
    "POST /v1/projects/prj_canon/rollback/dpl_old": () => new Response(null, { status: 200 }),
  });
  await withClient({ fixture, fetchImpl: impl, approve: true }, async ({ client }) => {
    const prep = resultData(
      await client.callTool({
        name: "prepare_infrastructure_change",
        arguments: {
          projectPath: fixture.project,
          action: { kind: "rollback_vercel", projectId: "my-app", deploymentId: "dpl_old" },
          maxMonthlyBudgetUsd: 20,
          commercialUse: true,
        },
      }),
    );
    assert.ok(prep.operationId);
    assert.strictEqual(prep.action.projectId, "prj_canon");
    const exec = resultData(
      await client.callTool({ name: "execute_infrastructure_change", arguments: { operationId: prep.operationId } }),
    );
    assert.strictEqual(exec.status, "succeeded");
    assert.ok(calls.some((c) => c.method === "POST" && c.path === "/v1/projects/prj_canon/rollback/dpl_old"));
  });
});
