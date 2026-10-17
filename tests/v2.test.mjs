import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "../dist/server.js";
import { InfrastructureEngine } from "../dist/v2/engine.js";
import { constraintsSchema, manifestSchema, planSchema } from "../dist/v2/schema.js";
import { loadInstalled } from "../dist/v2/adapter.js";

const dirs = [];
after(async () => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));
const hash = (s) => createHash("sha256").update(s).digest("hex");
const today = new Date().toISOString().slice(0, 10);
const sentinel = "synthetic-adapter-credential-private";
async function fixture({ credentials = true, cap = "edge" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "mcp-v2-")); dirs.push(root);
  const app = join(root, "application"); await mkdir(app);
  await writeFile(join(app, "index.html"), "<h1>application</h1>");
  const termsFile = join(root, "terms.json"); const logFile = join(root, "calls.jsonl");
  await writeFile(termsFile, JSON.stringify({ cents: 100, status: "succeeded" }));
  const code = `import {readFile,appendFile} from 'node:fs/promises';
let input=''; for await(const chunk of process.stdin) input+=chunk;
const r=JSON.parse(input);const terms=JSON.parse(await readFile(${JSON.stringify(termsFile)},'utf8'));
await appendFile(${JSON.stringify(logFile)},JSON.stringify({method:r.method,request:r,keys:Object.keys(process.env)})+'\\n');
let output;
if(r.method==='prepare') output={account:'fixture-account',mutations:[{action:r.operation==='teardown'?'delete':'deploy',target:'fixture-service',details:'One service'}],estimate:{recurring:[{key:'fixture-service',cents:terms.cents}],upfrontCents:0,reviewedAt:terms.date??${JSON.stringify(today)},source:'https://example.com/pricing',assumptions:['Synthetic fixture']},preconditions:{sourceRevision:r.parameters.sourceRevision??null},expiresAt:new Date(Date.now()+300000).toISOString()};
else if(r.method==='verify') output={checks:[{kind:${JSON.stringify(cap)},status:'passed',detail:'Synthetic semantic probe passed.'},{kind:'http',status:'passed',detail:'Synthetic HTTP probe passed.'}]};
else {if(terms.crash&&r.method==='execute')process.exit(1);output={status:terms.status,resources:[{id:'service-fixture',provider:'fixture',kind:'service',account:'fixture-account'}]};}
if(terms.leak) output={token:process.env.ADAPTER_TEST_TOKEN};
process.stdout.write(JSON.stringify(output));`;
  const manifest = manifestSchema.parse({ protocolVersion: 2, id: "fixture", version: "2.0.0", name: "Synthetic provider", tier: "executable", capabilities: [cap], runtimes: [], frameworks: [], regions: ["test-region"], compliance: ["test-compliance"], commercialUse: "allowed", reliability: "production", credentials: ["ADAPTER_TEST_TOKEN"], accountSettings: [], operations: ["provision", "teardown"], teardown: true, reconciliation: "idempotency", pricing: { monthlyCents: 100, upfrontCents: 0, reviewedAt: today, source: "https://example.com/pricing", assumptions: [] }, documentation: ["https://example.com/docs"], limits: [] });
  const text = JSON.stringify(manifest); const manifestPath = join(root, "manifest.json"); const entrypoint = join(root, "adapter.mjs");
  await writeFile(manifestPath, text); await writeFile(entrypoint, code);
  const spec = { manifestPath, manifestSha256: hash(text), entrypoint, sha256: hash(code), credentialNames: ["ADAPTER_TEST_TOKEN"] };
  const config = { projectRoots: [app], stateDir: join(root, "state"), adapters: [spec], credentials: {}, providerEnvironment: credentials ? { ADAPTER_TEST_TOKEN: sentinel, UNDECLARED_TOKEN: "must-never-inherit" } : {} };
  const engine = new InfrastructureEngine(config);
  const constraints = constraintsSchema.parse({ maxMonthlyBudgetUsd: 10 });
  const overrides = { capabilities: [cap], providers: { [cap]: "fixture" } };
  const logs = async () => { try { return (await readFile(logFile, "utf8")).trim().split("\n").map(JSON.parse); } catch { return []; } };
  const terms = (value) => writeFile(termsFile, JSON.stringify({ cents: 100, status: "succeeded", ...value }));
  return { root, app, engine, config, spec, constraints, overrides, logs, terms };
}
async function clientFor(f, approve = () => true, capabilities = true) {
  const server = createServer(f.config); const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "v2-test", version: "2.0.0" }, { capabilities: capabilities ? { elicitation: { form: {} } } : {} });
  if (capabilities) client.setRequestHandler(ElicitRequestSchema, async (r) => (await approve(r.params)) ? { action: "accept", content: { approve: true } } : { action: "decline" });
  await Promise.all([server.connect(b), client.connect(a)]);
  return { server, client, close: async () => { await client.close(); await server.close(); } };
}
async function proposed(f) { const p = await f.engine.propose(f.app, f.constraints, f.overrides); return f.engine.prepare(p.id); }

test("v2 plans dynamically use an installed provider and execute exactly once", async () => {
  const f = await fixture(); const session = await clientFor(f);
  try {
    let p = await proposed(f); assert.equal(p.recommended.status, "ready"); assert.equal(p.steps[0].status, "prepared");
    p = await f.engine.execute(p.id, p.steps[0].id, session.server); assert.equal(p.steps[0].status, "succeeded");
    await f.engine.execute(p.id, p.steps[0].id, session.server);
    assert.equal((await f.logs()).filter((r) => r.method === "execute").length, 1);
    const request = (await f.logs()).find((r) => r.method === "execute");
    assert.deepEqual(request.keys.filter((k) => k !== "__CF_USER_TEXT_ENCODING"), ["ADAPTER_TEST_TOKEN"]); assert.ok(!JSON.stringify(request).includes(f.app));
    assert.ok(!JSON.stringify(p).includes(sentinel));
    assert.equal((await stat(join(f.config.stateDir, "operations", `plan-${p.id}.json`))).mode & 0o777, 0o600);
    p = await f.engine.verify(p.id); assert.equal(p.verification.status, "verified");
  } finally { await session.close(); }
});
test("missing adapter credentials remain recommended with exact setup requirements", async () => {
  const f = await fixture({ credentials: false }); const p = await proposed(f);
  assert.equal(p.recommended.status, "setup_required"); assert.match(p.recommended.prerequisites.join(), /ADAPTER_TEST_TOKEN/);
  assert.equal(p.steps[0].status, "blocked"); assert.equal(p.steps[0].error, "SETUP_REQUIRED"); assert.deepEqual(await f.logs(), []);
});
test("changed prices during approval block mutation and preserve recoverable state", async () => {
  const f = await fixture(); const session = await clientFor(f, async () => { await f.terms({ cents: 200 }); return true; });
  try { const p = await proposed(f); await assert.rejects(f.engine.execute(p.id, p.steps[0].id, session.server), { code: "PRECONDITION_CHANGED" }); assert.equal((await f.logs()).filter((r) => r.method === "execute").length, 0); }
  finally { await session.close(); }
});
test("reads and cancellation remain available during approval and stale approval cannot execute", async () => {
  const f = await fixture(); let p = await proposed(f);
  const session = await clientFor(f, async () => {
    assert.equal((await f.engine.get(p.id)).steps[0].status, "approving");
    await f.engine.cancel(p.id, p.steps[0].id); return true;
  });
  try { await assert.rejects(f.engine.execute(p.id, p.steps[0].id, session.server), { code: "STALE_PLAN" }); p = await f.engine.get(p.id); assert.equal(p.steps[0].status, "cancelled"); assert.equal((await f.logs()).filter((r) => r.method === "execute").length, 0); }
  finally { await session.close(); }
});
test("ambiguous adapter failure requires reconciliation and never resubmits", async () => {
  const f = await fixture(); const session = await clientFor(f);
  try {
    const p = await proposed(f); await f.terms({ crash: true });
    await assert.rejects(f.engine.execute(p.id, p.steps[0].id, session.server), { code: "ADAPTER_FAILED" });
    assert.equal((await f.engine.get(p.id)).steps[0].status, "unknown");
    await assert.rejects(f.engine.execute(p.id, p.steps[0].id, session.server), { code: "INVALID_STATE" });
    await f.terms({}); const recovered = await f.engine.reconcile(p.id, p.steps[0].id, undefined, session.server);
    assert.equal(recovered.steps[0].status, "succeeded"); assert.equal((await f.logs()).filter((r) => r.method === "execute").length, 1);
  } finally { await session.close(); }
});
test("adapter pin changes, project changes and stale pricing block execution", async () => {
  const f = await fixture(); const p = await proposed(f); const session = await clientFor(f);
  try {
    await writeFile(join(f.app, "index.html"), "changed");
    await assert.rejects(f.engine.execute(p.id, p.steps[0].id, session.server), { code: "SOURCE_CHANGED" });
    await f.terms({ date: "2000-01-01" }); const next = await f.engine.propose(f.app, f.constraints, f.overrides); const prepared = await f.engine.prepare(next.id);
    assert.equal(prepared.steps[0].error, "PRICING_STALE");
    await writeFile(f.spec.entrypoint, "process.exit(1)"); await assert.rejects(f.engine.registry.validate("fixture", p.steps[0].adapterChecksum), { code: "ADAPTER_CHANGED" });
  } finally { await session.close(); }
});
test("credential output is rejected, credentials are isolated, and a client cannot skip approval", async () => {
  const f = await fixture(); const p = await proposed(f); const session = await clientFor(f, () => true, false);
  try { await assert.rejects(f.engine.execute(p.id, p.steps[0].id, session.server), { code: "APPROVAL_UNAVAILABLE" }); await f.terms({ leak: true }); const { adapter } = await loadInstalled(f.spec, f.config); await assert.rejects(adapter.invoke({ protocolVersion: 2, method: "quote", operationId: "fixture", operation: "quote", parameters: {} }), { code: "UNSAFE_DATA" }); }
  finally { await session.close(); }
});
test("planner rejects unverified region/compliance and returns deterministic ranks", async () => {
  const f = await fixture(); const first = await f.engine.propose(f.app, f.constraints, f.overrides); const second = await f.engine.propose(f.app, f.constraints, f.overrides);
  assert.deepEqual(first.recommended, second.recommended);
  const blocked = await f.engine.propose(f.app, { ...f.constraints, region: "unsupported" }, f.overrides);
  assert.equal(blocked.recommended, null); assert.ok(blocked.rejected.some((r) => r.provider === "fixture"));
  assert.ok(planSchema.safeParse(first).success);
});
test("teardown is separately proposed, ordered and cannot include domains", async () => {
  const f = await fixture(); const session = await clientFor(f);
  try {
    const p = await proposed(f); await f.engine.execute(p.id, p.steps[0].id, session.server);
    const teardown = await f.engine.teardown(p.id); assert.equal(teardown.intent, "teardown"); assert.equal(teardown.steps[0].status, "draft");
    assert.equal((await f.logs()).filter((r) => r.request.operation === "teardown").length, 0);
    await f.engine.store.transaction(p.id, (saved) => saved.steps[0].resources.push({ id: "example.test", provider: "fixture", kind: "domain", account: "fixture-account" }));
    const domain = await f.engine.teardown(p.id, ["example.test"]); assert.deepEqual(domain.steps, []);
  } finally { await session.close(); }
});
