import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "../dist/server.js";
import { InfrastructureEngine } from "../dist/v2/engine.js";
import { OperationService } from "../dist/operations/service.js";
import { OperationStore } from "../dist/operations/store.js";

const dirs = [];
after(async () => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
async function fixture(fullstack = false) {
  const root = await mkdtemp(join(tmpdir(), "mcp-native-v2-")); dirs.push(root); const app = join(root, "app"); await mkdir(app);
  await writeFile(join(app, "package.json"), JSON.stringify({ name: "app", ...(fullstack ? { dependencies: { next: "15", "@supabase/supabase-js": "2" } } : {}) }));
  await writeFile(join(app, "index.html"), "<h1>app</h1>");
  if (fullstack) await writeFile(join(app, "app.js"), "const url = process.env.NEXT_PUBLIC_SUPABASE_URL; const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY; const db = process.env.DATABASE_URL;");
  const config = { projectRoots: [app], stateDir: join(root, "state"), credentials: { vercelToken: "synthetic-vercel-token", vercelTeamId: "team_1", supabaseToken: "synthetic-supabase-token" } };
  const calls = []; let project; let database; let readyState = "READY"; let metadataId;
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url); const method = init.method ?? "GET"; const p = u.pathname; const body = init.body && typeof init.body === "string" && /^[{[]/.test(init.body) ? JSON.parse(init.body) : undefined;
    calls.push({ p, method, body });
    if (p === "/v2/teams/team_1") return json({ id: "team_1", billing: { plan: "pro" } });
    if (p === "/v9/projects/app" || p === "/v9/projects/prj_v2") return project ? json(project) : json({}, 404);
    if (p === "/v11/projects" && method === "POST") { project = { id: "prj_v2", name: body.name, accountId: "team_1" }; return json(project); }
    if (p === "/v2/files") return new Response(null, { status: 200 });
    if (p === "/v10/projects/prj_v2/env" && method === "POST") return json({ failed: [], created: body.map((e, i) => ({ id: `env_${i}`, key: e.key, target: e.target, type: "encrypted" })) });
    if (p === "/v13/deployments" && method === "POST") { metadataId = body.meta?.mcpDevopsOperationId; return json({ id: "dpl_v2", url: "https://app-v2.vercel.app", readyState, projectId: "prj_v2" }); }
    if (p === "/v13/deployments/dpl_v2") return json({ id: "dpl_v2", readyState, projectId: "prj_v2", target: "production" });
    if (p === "/v7/deployments") return json({ deployments: [{ uid: "dpl_v2", readyState, meta: { mcpDevopsOperationId: metadataId } }], pagination: { next: null } });
    if (p === "/v1/organizations/org") return json({ id: "org_1", name: "Org", plan: "pro" });
    if (p === "/v1/projects/available-regions") return json({ all: { specific: [{ code: "us-east-1" }] } });
    if (p === "/v1/projects" && method === "GET") return json(database ? [database] : []);
    if (p === "/v1/projects" && method === "POST") { database = { ref: "abcdefghijklmnopqrst", id: "abcdefghijklmnopqrst", name: body.name, status: "ACTIVE_HEALTHY", organization_id: "org_1" }; return json(database); }
    if (p === "/v1/projects/abcdefghijklmnopqrst") return json(database);
    if (p === "/v1/projects/abcdefghijklmnopqrst/api-keys") return json([{ type: "publishable", api_key: "synthetic-publishable-key" }]);
    throw new Error(`Unexpected synthetic request: ${method} ${p}`);
  };
  const server = createServer(config, { fetch: fetchImpl, healthProbe: async () => ({ status: "unverified", detail: "Synthetic test does not contact live applications." }) }); const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "native-v2-test", version: "2" }, { capabilities: { elicitation: { form: {} } } }); const approvals = [];
  client.setRequestHandler(ElicitRequestSchema, async (r) => { approvals.push(r.params.message); return { action: "accept", content: { approve: true } }; });
  await Promise.all([server.connect(b), client.connect(a)]);
  const tool = async (name, args) => { const r = await client.callTool({ name, arguments: args }); const data = JSON.parse(r.content[0].text); assert.equal(r.isError, undefined, JSON.stringify(data)); return data; };
  return { config, app, calls, approvals, tool, fetchImpl, state: (s) => { readyState = s; }, close: async () => { await client.close(); await server.close(); } };
}
test("v2 chat flow creates a Vercel project, resolves dependency IDs and deploys safe source", async () => {
  const f = await fixture();
  try {
    let p = await f.tool("propose_infrastructure_plan", { projectPath: f.app, constraints: { maxMonthlyBudgetUsd: 20 }, overrides: { providers: { static: "vercel" } } });
    p = await f.tool("prepare_infrastructure_plan", { planId: p.id }); assert.equal(p.steps[0].status, "prepared"); assert.equal(p.steps[1].status, "draft");
    p = await f.tool("execute_infrastructure_step", { planId: p.id, stepId: "hosting" });
    p = await f.tool("prepare_infrastructure_plan", { planId: p.id }); assert.equal(p.steps[1].status, "prepared");
    p = await f.tool("execute_infrastructure_step", { planId: p.id, stepId: "deploy" });
    assert.ok(p.steps.every((s) => s.status === "succeeded")); assert.equal(f.approvals.length, 2);
    const deploy = f.calls.find((c) => c.p === "/v13/deployments" && c.method === "POST"); assert.equal(deploy.body.project, "prj_v2");
    const verification = await f.tool("verify_infrastructure_plan", { planId: p.id }); assert.equal(verification.verification.status, "incomplete");
  } finally { await f.close(); }
});
test("full stack flow copies generated database secrets using public framework aliases before deployment", async () => {
  const f = await fixture(true);
  try {
    let p = await f.tool("propose_infrastructure_plan", { projectPath: f.app, constraints: { maxMonthlyBudgetUsd: 60 }, overrides: { providers: { serverless: "vercel", postgres: "supabase", auth: "supabase", storage: "supabase" }, parameters: { supabase: { organizationSlug: "org", region: "us-east-1" } } } });
    for (const id of ["database", "hosting", "database-env", "hosting-env", "deploy"]) {
      p = await f.tool("prepare_infrastructure_plan", { planId: p.id });
      const step = p.steps.find((s) => s.id === id); assert.equal(step.status, "prepared", JSON.stringify(step));
      p = await f.tool("execute_infrastructure_step", { planId: p.id, stepId: id });
    }
    assert.ok(p.steps.every((s) => s.status === "succeeded"));
    const env = await readFile(join(f.app, ".env"), "utf8"); assert.match(env, /NEXT_PUBLIC_SUPABASE_URL=/); assert.match(env, /NEXT_PUBLIC_SUPABASE_ANON_KEY=/); assert.match(env, /DATABASE_URL=/);
    assert.ok(!JSON.stringify(p).includes("synthetic-publishable-key"));
    const upload = f.calls.find((c) => c.p === "/v10/projects/prj_v2/env"); assert.ok(upload);
    const deployIndex = f.calls.findIndex((c) => c.p === "/v13/deployments" && c.method === "POST"); const envIndex = f.calls.indexOf(upload); assert.ok(envIndex < deployIndex);
  } finally { await f.close(); }
});
test("v1 migration retains original bytes and BLOCKED deployments reconcile as failed", async () => {
  const f = await fixture();
  try {
    const service = new OperationService(f.config, { fetch: f.fetchImpl });
    const prep = await service.prepare({ projectPath: f.app, action: { kind: "create_vercel_project", name: "app", framework: null }, maxMonthlyBudgetUsd: 20, maxUpfrontBudgetUsd: 0, estimatedMonthlyUsageUsd: 0, commercialUse: true });
    const file = join(f.config.stateDir, "operations", `${prep.operationId}.json`); const before = await readFile(file);
    const engine = new InfrastructureEngine(f.config, { fetch: f.fetchImpl }); await engine.init(); const migrated = await engine.get(prep.operationId);
    assert.equal(migrated.intent, "legacy"); assert.deepEqual(await readFile(file), before);
    const store = new OperationStore(f.config.stateDir); const op = await store.load(prep.operationId);
    op.action = { kind: "deploy_vercel", projectId: "prj_v2", name: "app", target: "production", source: { type: "github", org: "example", repo: "app", sha: "a".repeat(40) } }; op.status = "unknown"; op.result = { deploymentId: "dpl_v2" }; op.preconditions = {}; await store.save(op);
    f.state("BLOCKED");
    // The deterministic metadata lookup uses the exact original operation ID.
    const blockedFetch = async (url, init) => new URL(url).pathname === "/v7/deployments" ? json({ deployments: [{ uid: "dpl_v2", readyState: "BLOCKED", meta: { mcpDevopsOperationId: op.id } }], pagination: { next: null } }) : f.fetchImpl(url, init);
    const recovered = new OperationService(f.config, { fetch: blockedFetch }); const result = await recovered.reconcile(op.id, undefined, {}); assert.equal(result.status, "failed");
  } finally { await f.close(); }
});
