import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { InfrastructureEngine } from "../dist/v2/engine.js";
import { constraintsSchema } from "../dist/v2/schema.js";
const dirs = []; after(async () => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));
const sha = "a".repeat(40);
const json = (v, status = 200) => new Response(JSON.stringify(v), { status });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pages-adapter-")); dirs.push(root); const app = join(root, "app"); await mkdir(app); await writeFile(join(app, "index.html"), "<h1>Ready static source</h1>");
  const config = { projectRoots: [app], stateDir: join(root, "state"), credentials: {}, providerEnvironment: { GITHUB_TOKEN: "synthetic-github-token" } };
  const calls = []; let ref; let page; let state = "built";
  const fetchImpl = async (url, init = {}) => {
    const p = new URL(url).pathname; const method = init.method ?? "GET"; const body = init.body ? JSON.parse(init.body) : undefined; calls.push({ p, method, body });
    if (p === "/repos/example/app") return json({ id: 101, name: "app", owner: { login: "example", id: 99 }, private: false, permissions: { admin: true, push: true } });
    if (p === `/repos/example/app/commits/${sha}`) return json({ sha });
    if (p.includes("/git/ref/heads/")) return ref ? json(ref) : json({}, 404);
    if (p.endsWith("/git/refs") && method === "POST") { ref = { ref: body.ref, object: { sha: body.sha } }; return json(ref, 201); }
    if (p === "/repos/example/app/pages") {
      if (method === "GET") return page ? json(page) : json({}, 404);
      if (method === "DELETE") { page = undefined; return new Response(null, { status: 204 }); }
      page = { ...body, status: "built", html_url: "https://example.github.io/app/" }; return method === "PUT" ? new Response(null, { status: 204 }) : json(page, 201);
    }
    if (p === "/repos/example/app/pages/builds" && method === "POST") return json({ status: "queued" }, 201);
    if (p === "/repos/example/app/pages/builds/latest") return json({ status: state, commit: sha });
    throw new Error(`Unrouted synthetic Pages API ${method} ${p}`);
  };
  const engine = new InfrastructureEngine(config, { fetch: fetchImpl, healthProbe: async () => ({ status: "passed", detail: "Synthetic public HTTPS endpoint." }) });
  const approvals = [];
  const server = { server: { getClientCapabilities: () => ({ elicitation: { form: {} } }), elicitInput: async (args) => { approvals.push(args.message); return { action: "accept", content: { approve: true } }; } } };
  const constraints = constraintsSchema.parse({ maxMonthlyBudgetUsd: 0, commercialUse: false });
  const overrides = { providers: { static: "github-pages" }, parameters: { "github-pages": { owner: "example", repo: "app", sha } } };
  return { engine, app, config, calls, approvals, server, constraints, overrides, drift: () => { ref.object.sha = "b".repeat(40); }, fail: () => { state = "errored"; } };
}
test("GitHub Pages separates repository source, settings and deployment approval and reconciles immutable builds", async () => {
  const f = await fixture(); let p = await f.engine.propose(f.app, f.constraints, f.overrides);
  assert.deepEqual(p.steps.map((s) => s.id), ["pages-source", "pages-settings", "pages-deploy"]);
  for (const id of ["pages-source", "pages-settings", "pages-deploy"]) {
    p = await f.engine.prepare(p.id); assert.equal(p.steps.find((s) => s.id === id).status, "prepared", JSON.stringify(p.steps));
    p = await f.engine.execute(p.id, id, f.server);
  }
  assert.equal(p.steps[2].status, "pending"); assert.equal(f.approvals.length, 3);
  assert.match(f.approvals[0], /Create a source branch/); assert.match(f.approvals[1], /before.*after/);
  p = await f.engine.reconcile(p.id, "pages-deploy", undefined, f.server); assert.equal(p.steps[2].status, "succeeded");
  assert.equal((await f.engine.verify(p.id)).verification.status, "verified");
  let teardown = await f.engine.teardown(p.id); assert.equal(teardown.steps.length, 1); assert.equal(teardown.steps[0].resources[0].kind, "pages");
  teardown = await f.engine.prepare(teardown.id); assert.equal(teardown.steps[0].status, "prepared");
  teardown = await f.engine.execute(teardown.id, teardown.steps[0].id, f.server); assert.equal(teardown.steps[0].status, "succeeded");
  assert.equal(f.calls.filter((c) => c.method === "DELETE").length, 1); assert.equal(f.calls.filter((c) => /git\/refs/.test(c.p) && c.method === "DELETE").length, 0);
});
test("GitHub Pages rejects commercial workloads and changed immutable refs", async () => {
  const f = await fixture(); const commercial = await f.engine.propose(f.app, { ...f.constraints, commercialUse: true }, f.overrides);
  assert.equal(commercial.recommended, null); assert.ok(commercial.rejected.find((r) => r.provider === "github-pages"));
  const auth = await f.engine.propose(f.app, { ...f.constraints, maxMonthlyBudgetUsd: 100 }, { ...f.overrides, capabilities: ["static", "auth"], providers: { static: "github-pages", auth: "supabase" } });
  assert.equal(auth.recommended, null); assert.ok(auth.rejected.find((r) => r.provider === "github-pages" && r.reasons.some((reason) => reason.includes("usage restrictions"))));
  let p = await f.engine.propose(f.app, f.constraints, f.overrides); p = await f.engine.prepare(p.id); await f.engine.execute(p.id, "pages-source", f.server);
  p = await f.engine.prepare(p.id); f.drift();
  await assert.rejects(f.engine.execute(p.id, "pages-settings", f.server), { code: "SOURCE_CHANGED" });
  assert.equal(f.calls.filter((c) => c.p.endsWith("/pages") && c.method === "POST").length, 0);
});
