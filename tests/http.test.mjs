import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { request } from "node:http";
import { createServer as createNetServer } from "node:net";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createHttpService, loadHttpConfig } from "../dist/http.js";
import { loadConfig } from "../dist/config.js";

const token = randomBytes(32).toString("base64url");
const headers = { Authorization: `Bearer ${token}` };
const initBody = { jsonrpc: "2.0", id: 1, method: "initialize", params: {
  protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "http-test", version: "1" },
} };

async function unusedPort() {
  const probe = createNetServer();
  await new Promise((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "mcp-http-"));
  const project = join(root, "app");
  await mkdir(project);
  await writeFile(join(project, "package.json"), JSON.stringify({ name: "test", dependencies: { next: "15.0.0" } }));
  const config = loadConfig({ MCP_DEVOPS_PROJECT_ROOTS: JSON.stringify([project]), MCP_DEVOPS_STATE_DIR: join(root, "state") }, root);
  let service;
  async function start() {
    const port = await unusedPort();
    const publicUrl = `http://127.0.0.1:${port}/mcp`;
    service = createHttpService(config, { host: "127.0.0.1", port, publicUrl, token }, options);
    await service.listen();
    return new URL(`http://127.0.0.1:${service.httpServer.address().port}/mcp`);
  }
  let url = await start();
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  return { root, project, config, get url() { return url; }, get service() { return service; },
    async restart() { await service.close(); url = await start(); },
    async raw(body = initBody, extra = {}) {
      return new Promise((resolve, reject) => {
        const req = request(url, { method: "POST", headers: { ...headers, "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...extra } }, (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
          res.on("error", reject);
        });
        req.on("error", reject);
        req.end(typeof body === "string" ? body : JSON.stringify(body));
      });
    },
    async client(capabilities = {}, handler) {
      const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers }, reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 10, maxReconnectionDelay: 10, reconnectionDelayGrowFactor: 1 } });
      const client = new Client({ name: "http-test", version: "1" }, { capabilities });
      if (handler) client.setRequestHandler(ElicitRequestSchema, handler);
      await client.connect(transport);
      t.after(() => client.close());
      return { client, transport };
    },
  };
}

function data(result) { return JSON.parse(result.content[0].text); }
function writeCall(client, project) {
  return client.callTool({ name: "write_env_secrets", arguments: { projectPath: project, secrets: { TEST_KEY: "synthetic-private-value" } } });
}

test("HTTP configuration fails closed without disclosing values", () => {
  const env = { MCP_DEVOPS_HTTP_TOKEN: token, MCP_DEVOPS_HTTP_PUBLIC_URL: "https://mcp.test/mcp" };
  assert.equal(loadHttpConfig(env).host, "127.0.0.1");
  assert.equal(loadHttpConfig({ ...env, PORT: "10000", MCP_DEVOPS_HTTP_HOST: "0.0.0.0" }).port, 10000);
  assert.doesNotThrow(() => loadHttpConfig({ ...env, MCP_DEVOPS_HTTP_PUBLIC_URL: "http://127.0.0.1:3000/mcp" }));
  for (const override of [
    { MCP_DEVOPS_HTTP_TOKEN: "short-secret" }, { MCP_DEVOPS_HTTP_TOKEN: "" },
    { MCP_DEVOPS_HTTP_PUBLIC_URL: "http://mcp.test/mcp" },
    { MCP_DEVOPS_HTTP_PUBLIC_URL: "https://user:private@mcp.test/mcp" },
    { MCP_DEVOPS_HTTP_PUBLIC_URL: "https://mcp.test/mcp?token=private" },
    { MCP_DEVOPS_HTTP_PUBLIC_URL: "https://mcp.test/other" },
    { MCP_DEVOPS_HTTP_PUBLIC_URL: "https://mcp.test/mcp#private" },
    { PORT: "0" }, { PORT: "65536" }, { MCP_DEVOPS_HTTP_HOST: "mcp.test" },
  ]) {
    assert.throws(() => loadHttpConfig({ ...env, ...override }), (error) => error.code === "INVALID_CONFIG" && !error.message.includes(token) && !error.message.includes("short-secret"));
  }
});

test("HTTP gates every MCP method and session; health exposes only liveness", async (t) => {
  const f = await fixture(t);
  const health = await fetch(new URL("/healthz", f.url));
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });
  assert.equal(health.headers.get("cache-control"), "no-store");
  for (const method of ["POST", "GET", "DELETE"]) {
    const response = await fetch(f.url, { method });
    assert.equal(response.status, 401);
    assert.ok(!JSON.stringify(await response.json()).includes(token));
  }
  for (const extra of [{ Host: "evil.test" }, { Origin: "https://evil.test" }, { Origin: "null" }, { Authorization: "Bearer wrong" }]) {
    const r = await f.raw(initBody, extra);
    assert.equal(r.status, extra.Authorization ? 401 : 403);
    await r.text();
  }
  const query = new URL(f.url); query.search = "?access_token=private";
  assert.equal((await fetch(query, { headers })).status, 404);
  assert.equal((await fetch(f.url, { method: "PUT", headers })).status, 405);
  const { client, transport } = await f.client();
  assert.ok((await client.listTools()).tools.some((tool) => tool.name === "execute_infrastructure_step"));
  const denied = await fetch(f.url, { method: "DELETE", headers: { "mcp-session-id": transport.sessionId } });
  assert.equal(denied.status, 401);
  assert.ok((await client.listTools()).tools.length);
  await transport.terminateSession();
  assert.equal((await f.raw({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { "mcp-session-id": transport.sessionId ?? "unknown" })).status, 404);
});

test("HTTP rejects malformed, compressed and oversized bodies before tool access", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.raw("{bad")).status, 400);
  assert.equal((await f.raw(initBody, { "Content-Type": "text/plain" })).status, 415);
  assert.equal((await f.raw(initBody, { "Content-Encoding": "gzip" })).status, 415);
  const declaredStatus = await new Promise((resolve, reject) => {
    const req = request(f.url, { method: "POST", headers: { ...headers, "Content-Type": "application/json", "Content-Length": String(1024 * 1024 + 1) } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on("error", reject);
    req.end();
  });
  assert.equal(declaredStatus, 413);
  const status = await new Promise((resolve, reject) => {
    const req = request(f.url, { method: "POST", headers: { ...headers, "Content-Type": "application/json", "Transfer-Encoding": "chunked" } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on("error", reject);
    req.end("x".repeat(1024 * 1024 + 1));
  });
  assert.equal(status, 413);
  assert.equal((await f.raw({ jsonrpc: "2.0", id: 2, method: "tools/list" })).status, 400);
});

test("HTTP bounds active body readers and can stop incomplete uploads", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const uploads = [];
  t.after(() => { for (const upload of uploads) upload.destroy(); });
  let accepted = 0;
  let full;
  const ready = new Promise((resolve) => { full = resolve; });
  f.service.httpServer.on("request", () => { if (++accepted === 64) full(); });
  for (let i = 0; i < 64; i++) {
    const req = request(f.url, { method: "POST", headers: { ...headers, "Content-Type": "application/json" } });
    req.on("error", () => {});
    uploads.push(req);
    req.write("{");
  }
  await ready;
  const response = await f.raw();
  assert.equal(response.status, 429);
  await f.service.close();
});

test("HTTP approval requires form support and explicit acceptance", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const noForm = await f.client();
  assert.equal(data(await writeCall(noForm.client, f.project)).error.code, "APPROVAL_UNAVAILABLE");
  assert.equal(existsSync(join(f.project, ".env")), false);
  let response = { action: "decline" };
  let prompts = 0;
  const { client } = await f.client({ elicitation: { form: {} } }, async (request) => {
    prompts++;
    assert.ok(!JSON.stringify(request).includes("synthetic-private-value"));
    assert.match(request.params.message, /TEST_KEY/);
    return response;
  });
  assert.equal(data(await writeCall(client, f.project)).error.code, "APPROVAL_DECLINED");
  assert.equal(existsSync(join(f.project, ".env")), false);
  response = { action: "accept", content: { approve: false } };
  assert.equal(data(await writeCall(client, f.project)).error.code, "APPROVAL_DECLINED");
  response = { action: "accept", content: { approve: true } };
  const result = await writeCall(client, f.project);
  assert.equal(data(result).status, "updated");
  assert.ok(!JSON.stringify(result).includes("synthetic-private-value"));
  assert.match(await readFile(join(f.project, ".env"), "utf8"), /TEST_KEY='synthetic-private-value'/);
  assert.equal(prompts, 3);
});

test("HTTP disconnect cancels pending approval and invalidates its session", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  let prompt;
  const prompted = new Promise((resolve) => { prompt = resolve; });
  let approve;
  const decision = new Promise((resolve) => { approve = resolve; });
  const { client, transport } = await f.client({ elicitation: { form: {} } }, async () => { prompt(); return decision; });
  const call = writeCall(client, f.project).catch(() => undefined);
  await prompted;
  const sessionId = transport.sessionId;
  await client.close();
  // Probe until the server has processed the socket close, with a fixed deadline.
  const deadline = Date.now() + 3000;
  let status;
  do {
    const r = await f.raw({ jsonrpc: "2.0", id: 10, method: "ping" }, { "mcp-session-id": sessionId });
    status = r.status; await r.text();
  } while (status !== 404 && Date.now() < deadline);
  assert.equal(status, 404);
  approve({ action: "accept", content: { approve: true } });
  await call;
  assert.equal(existsSync(join(f.project, ".env")), false);
});

test("HTTP bounds sessions and expires idle sessions even with an open GET stream", async (t) => {
  let clock = 0;
  const f = await fixture(t, { now: () => clock });
  for (let i = 0; i < 8; i++) {
    const r = await f.raw(); assert.equal(r.status, 200); await r.text();
  }
  assert.equal((await f.raw()).status, 429);
  clock = 16 * 60_000;
  const { client, transport } = await f.client();
  const sessionId = transport.sessionId;
  clock += 16 * 60_000;
  const r = await f.raw({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { "mcp-session-id": sessionId });
  assert.equal(r.status, 404);
  await client.close();
  assert.equal((await f.raw()).status, 200);
});

test("HTTP restart retains plans and rejects old sessions", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const { client, transport } = await f.client();
  const plan = data(await client.callTool({ name: "propose_infrastructure_plan", arguments: { projectPath: f.project, constraints: { maxMonthlyBudgetUsd: 60, maxUpfrontBudgetUsd: 20 } } }));
  assert.ok(plan.id);
  const oldSession = transport.sessionId;
  await client.close();
  await f.restart();
  assert.equal((await f.raw({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { "mcp-session-id": oldSession })).status, 404);
  const reconnected = await f.client();
  const loaded = data(await reconnected.client.callTool({ name: "get_infrastructure_plan", arguments: { planId: plan.id } }));
  assert.equal(loaded.id, plan.id);
  assert.deepEqual(loaded.constraints, plan.constraints);
});

test("serve-http stops on SIGTERM with pending approval and keeps stdout empty", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const port = await unusedPort();
  const url = `http://127.0.0.1:${port}/mcp`;
  const child = spawn(process.execPath, [new URL("../dist/index.js", import.meta.url).pathname, "serve-http"], {
    cwd: f.root,
    env: { PATH: process.env.PATH, HOME: f.root, PORT: String(port), MCP_DEVOPS_PROJECT_ROOTS: JSON.stringify([f.project]), MCP_DEVOPS_STATE_DIR: join(f.root, "state"), MCP_DEVOPS_HTTP_TOKEN: token, MCP_DEVOPS_HTTP_PUBLIC_URL: url },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  let stdout = ""; let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  const started = new Promise((resolve, reject) => {
    child.stderr.on("data", (chunk) => { stderr += chunk; if (stderr.includes("MCP HTTP service started.")) resolve(); });
    child.once("exit", () => reject(new Error("HTTP child did not start: " + stderr)));
  });
  await started;
  const client = new Client({ name: "shutdown-test", version: "1" }, { capabilities: { elicitation: { form: {} } } });
  let prompted;
  const prompt = new Promise((resolve) => { prompted = resolve; });
  let respond;
  client.setRequestHandler(ElicitRequestSchema, async () => { prompted(); return new Promise((resolve) => { respond = resolve; }); });
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } }, reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 10, maxReconnectionDelay: 10, reconnectionDelayGrowFactor: 1 } });
  t.after(() => client.close());
  await client.connect(transport);
  const call = writeCall(client, f.project).catch(() => undefined);
  await prompt;
  const exit = once(child, "exit");
  child.kill("SIGTERM");
  const [code] = await exit;
  assert.equal(code, 0);
  respond({ action: "accept", content: { approve: true } });
  await client.close(); await call;
  assert.equal(existsSync(join(f.project, ".env")), false);
  assert.equal(stdout, "");
  assert.ok(!stderr.includes(token));
});
