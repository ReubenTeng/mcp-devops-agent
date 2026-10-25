import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { InfrastructureEngine } from "../dist/v2/engine.js";
import { loadConfig } from "../dist/config.js";
import { constraintsSchema, digest } from "../dist/v2/schema.js";
import { renderManifest } from "../dist/v2/render.js";
import { renderMonthlyCents } from "../dist/operations/service.js";
import { loadHttpConfig } from "../dist/http.js";

const dirs = [];
after(async () => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));
const image = `ghcr.io/example/mcp-devops-agent@sha256:${"a".repeat(64)}`;
const apiToken = "synthetic-render-api-key";
const mcpToken = "synthetic-http-token-" + "z".repeat(32);
const owner = "tea-example";
const json = (data, status = 200) => new Response(JSON.stringify(data), { status });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "render-adapter-")); dirs.push(root);
  const app = join(root, "app"); await mkdir(app);
  await writeFile(join(app, "package.json"), JSON.stringify({ name: "app", type: "module" }));
  const config = loadConfig({ MCP_DEVOPS_PROJECT_ROOTS: JSON.stringify([app]), MCP_DEVOPS_STATE_DIR: join(root, "state"), RENDER_API_KEY: apiToken, RENDER_OWNER_ID: owner, RENDER_MCP_HTTP_TOKEN: mcpToken }, root);
  const calls = [];
  let service;
  let deployment;
  let engine;
  let ambiguous = false;
  let rejectCreate = false;
  let malformed = false;
  let omitDeployId = false;
  let duplicateDeploy = false;
  let driftOwner = false;
  let changeOnApproval;
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url); assert.equal(u.origin, "https://api.render.com");
    const method = init.method ?? "GET";
    assert.equal(init.headers.authorization, `Bearer ${apiToken}`);
    assert.equal(init.redirect, "error");
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: u.pathname, body, query: u.searchParams });
    if (u.pathname === `/v1/owners/${owner}`) return json({ id: driftOwner ? "tea-other" : owner, email: "private-provider-data@example.test", unexpectedSecret: apiToken });
    if (u.pathname === "/v1/services" && method === "GET") {
      const rows = [{ service: { id: "srv-unrelated", name: "another-app", ownerId: owner, type: "static_site" }, cursor: "other" }];
      if (service) rows.push({ service, cursor: "end" });
      return json(rows);
    }
    if (u.pathname === "/v1/services" && method === "POST") {
      // The mutation must be preceded by a durable running record.
      const plans = await engine.store.list();
      assert.equal(plans.find((p) => p.steps.some((s) => s.parameters.image === image)).steps[0].status, "running");
      if (rejectCreate) return json({ providerSecret: apiToken }, 503);
      service = {
        id: "srv-created", ownerId: body.ownerId, name: body.name, type: body.type, imagePath: body.image.imagePath,
        autoDeployTrigger: body.autoDeployTrigger,
        serviceDetails: { ...body.serviceDetails, disk: { ...body.serviceDetails.disk, id: "dsk-created" }, url: "https://created.onrender.com" },
        registryCredential: { secret: apiToken },
      };
      deployment = { id: "dep-created", status: "update_in_progress", image: { ref: image, sha: `sha256:${"a".repeat(64)}` }, rawSecret: mcpToken };
      if (ambiguous) throw new TypeError("Network response lost after creation: " + apiToken);
      if (malformed) return json({ service: { id: "not-a-service" } }, 201);
      return json({ service, ...(omitDeployId ? {} : { deployId: deployment.id }) }, 201);
    }
    if (u.pathname === "/v1/services/srv-created") return service ? json(service) : json({}, 404);
    if (u.pathname === "/v1/services/srv-created/deploys/dep-created") return json(deployment);
    if (u.pathname === "/v1/services/srv-created/deploys") return json([{ deploy: deployment, cursor: "one" }, ...(duplicateDeploy ? [{ deploy: { ...deployment, id: "dep-second" }, cursor: "two" }] : [])]);
    throw new Error(`Unexpected synthetic Render request: ${method} ${u.pathname}`);
  };
  engine = new InfrastructureEngine(config, { fetch: fetchImpl, healthProbe: async () => ({ status: "passed", detail: "Synthetic HTTPS health probe passed." }) });
  const approvals = [];
  let decision = true;
  const server = { server: { getClientCapabilities: () => ({ elicitation: { form: {} } }), elicitInput: async (args) => {
    approvals.push(args.message); changeOnApproval?.(); return { action: "accept", content: { approve: decision } };
  } } };
  const constraints = constraintsSchema.parse({ maxMonthlyBudgetUsd: 60, maxUpfrontBudgetUsd: 20, region: "singapore", storageGb: 1 });
  const overrides = { blueprint: "web_service", capabilities: ["server", "disk"], providers: { server: "render", disk: "render" }, parameters: { render: { image } } };
  return { app, config, engine, calls, server, approvals, constraints, overrides,
    decline() { decision = false; }, ambiguous() { ambiguous = true; }, reject() { rejectCreate = true; }, malformed() { malformed = true; }, noDeployId() { omitDeployId = true; }, duplicate() { duplicateDeploy = true; },
    change(fn) { changeOnApproval = fn; },
    ownerDrift() { driftOwner = true; },
    get service() { return service; }, get deployment() { return deployment; },
  };
}

async function prepare(f, constraints = f.constraints, overrides = f.overrides) {
  const plan = await f.engine.propose(f.app, constraints, overrides);
  return f.engine.prepare(plan.id);
}

test("Render uses reviewed compute and disk prices and loads private settings", async () => {
  assert.equal(renderMonthlyCents("starter", 1), 725);
  assert.equal(renderMonthlyCents("standard", 20), 3000);
  for (const disk of [-1, 0, 1.5, 21, NaN]) assert.throws(() => renderMonthlyCents("starter", disk));
  assert.throws(() => renderMonthlyCents("free", 1));
  assert.equal(renderManifest.tier, "executable");
  const f = await fixture();
  assert.equal(f.config.providerEnvironment.RENDER_API_KEY, apiToken);
  const connections = await f.engine.native.service.checkConnections();
  assert.equal(connections.providers.render.accountId, owner);
  assert.equal(connections.providers.render.billingVerified, false);
  assert.ok(!JSON.stringify(connections).includes(apiToken));
  const http = loadHttpConfig({ MCP_DEVOPS_HTTP_TOKEN: mcpToken, RENDER_EXTERNAL_URL: "https://created.onrender.com" });
  assert.equal(http.publicUrl, "https://created.onrender.com/mcp");
});

test("Render provisions the approved image and disk once, then reconciles without secrets", async () => {
  const f = await fixture();
  let plan = await prepare(f);
  assert.equal(plan.steps[0].status, "prepared", JSON.stringify(plan.steps));
  assert.equal(plan.steps[0].prepared.estimate.recurring[0].cents, 725);
  assert.ok(f.calls.every((c) => c.method === "GET"));
  plan = await f.engine.execute(plan.id, "provider-render", f.server);
  assert.equal(plan.steps[0].status, "pending");
  assert.equal(plan.steps[0].committed, true);
  assert.equal(f.approvals.length, 1);
  assert.match(f.approvals[0], /initialDeploy/);
  assert.match(f.approvals[0], /Failed deploys can remain billed/);
  assert.match(f.approvals[0], /725/);
  const mutation = f.calls.find((c) => c.method === "POST").body;
  assert.equal(mutation.image.imagePath, image);
  assert.equal(mutation.autoDeployTrigger, "off");
  assert.equal(mutation.serviceDetails.numInstances, 1);
  assert.equal(mutation.serviceDetails.disk.mountPath, "/var/data");
  assert.equal(mutation.envVars.find((e) => e.key === "MCP_DEVOPS_HTTP_TOKEN").value, mcpToken);
  f.deployment.status = "live";
  plan = await f.engine.reconcile(plan.id, "provider-render", undefined, f.server);
  assert.equal(plan.steps[0].status, "succeeded");
  assert.equal(f.calls.filter((c) => c.method !== "GET").length, 1);
  const checked = await f.engine.verify(plan.id);
  assert.equal(checked.verification.status, "incomplete");
  assert.ok(checked.verification.checks.some((c) => c.kind === "disk" && c.status === "unverified"));
  assert.ok(checked.verification.checks.some((c) => c.kind === "server" && c.status === "unverified"));
  for (const output of [plan, checked, f.approvals]) {
    assert.ok(!JSON.stringify(output).includes(apiToken));
    assert.ok(!JSON.stringify(output).includes(mcpToken));
    assert.ok(!JSON.stringify(output).includes("private-provider-data@example.test"));
  }
});

test("Render rejects mutable sources, missing private setup and insufficient budgets", async () => {
  const f = await fixture();
  for (const unsafeImage of ["ghcr.io/example/app:latest", "https://user:private@ghcr.io/app", "docker.io/example/app@sha256:" + "a".repeat(64)]) {
    const plan = await prepare(f, f.constraints, { ...f.overrides, parameters: { render: { image: unsafeImage } } });
    assert.equal(plan.steps[0].status, "blocked");
    assert.equal(plan.steps[0].error, "SETUP_REQUIRED");
  }
  assert.equal(f.calls.length, 0);
  delete f.config.providerEnvironment.RENDER_MCP_HTTP_TOKEN;
  let plan = await prepare(f);
  assert.equal(plan.steps[0].error, "SETUP_REQUIRED");
  f.config.providerEnvironment.RENDER_MCP_HTTP_TOKEN = mcpToken;
  // The selected standard plan and disk must be reserved at their actual estimate.
  plan = await prepare(f, { ...f.constraints, maxMonthlyBudgetUsd: 20, storageGb: 4 }, { ...f.overrides, parameters: { render: { image, plan: "standard" } } });
  assert.equal(plan.steps[0].status, "blocked");
  assert.equal(plan.steps[0].error, "BUDGET_EXCEEDED");
  assert.equal(f.calls.filter((c) => c.method !== "GET").length, 0);
});

test("Render decline and private credential drift during approval send no mutation", async () => {
  for (const drift of [false, true]) {
    const f = await fixture();
    const plan = await prepare(f);
    if (drift) f.change(() => { f.config.providerEnvironment.RENDER_MCP_HTTP_TOKEN = "b".repeat(43); });
    else f.decline();
    await assert.rejects(f.engine.execute(plan.id, "provider-render", f.server), { code: drift ? "PRECONDITION_CHANGED" : "APPROVAL_DECLINED" });
    assert.equal(f.calls.filter((c) => c.method !== "GET").length, 0);
  }
});

test("Render recovers lost and malformed creation responses without retrying", async () => {
  for (const fault of ["ambiguous", "malformed"]) {
    const f = await fixture(); const plan = await prepare(f); f[fault]();
    await assert.rejects(f.engine.execute(plan.id, "provider-render", f.server));
    let saved = await f.engine.get(plan.id);
    assert.equal(saved.steps[0].status, "unknown");
    assert.equal(saved.steps[0].committed, true);
    await assert.rejects(f.engine.execute(plan.id, "provider-render", f.server));
    f.deployment.status = "live";
    saved = await f.engine.reconcile(plan.id, "provider-render", undefined, f.server);
    assert.equal(saved.steps[0].status, "succeeded");
    assert.equal(f.calls.filter((c) => c.method === "POST").length, 1);
  }
});

test("Render failed deployment retains billed resources; unknown deploy identity stays unknown", async () => {
  const f = await fixture(); const plan = await prepare(f);
  let saved = await f.engine.execute(plan.id, "provider-render", f.server);
  f.deployment.status = "update_failed";
  saved = await f.engine.reconcile(plan.id, "provider-render", undefined, f.server);
  assert.equal(saved.steps[0].status, "failed");
  assert.equal(saved.steps[0].committed, true);
  assert.ok(saved.steps[0].resources.some((r) => r.kind === "disk"));
  const other = await fixture(); other.noDeployId(); other.duplicate();
  const draft = await prepare(other);
  await other.engine.execute(draft.id, "provider-render", other.server);
  const recovered = await other.engine.reconcile(draft.id, "provider-render", undefined, other.server);
  assert.equal(recovered.steps[0].status, "unknown");
  assert.equal(other.calls.filter((c) => c.method === "POST").length, 1);
});

test("Render validates account and disk identities and never retries a failed mutation", async () => {
  const f = await fixture(); const plan = await prepare(f);
  f.change(() => f.ownerDrift());
  await assert.rejects(f.engine.execute(plan.id, "provider-render", f.server), { code: "ACCOUNT_MISMATCH" });
  assert.equal(f.calls.filter((c) => c.method === "POST").length, 0);
  const rejected = await fixture(); const p = await prepare(rejected); rejected.reject();
  await assert.rejects(rejected.engine.execute(p.id, "provider-render", rejected.server), { code: "PROVIDER_REQUEST_FAILED" });
  assert.equal(rejected.calls.filter((c) => c.method === "POST").length, 1);
  const changed = await fixture(); const c = await prepare(changed);
  await changed.engine.execute(c.id, "provider-render", changed.server);
  changed.service.serviceDetails.disk.id = "dsk-replaced";
  await assert.rejects(changed.engine.reconcile(c.id, "provider-render", undefined, changed.server), { code: "RESOURCE_CHANGED" });
});
