import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const serverEntry = join(repoRoot, "dist", "index.js");
const SECRET_SENTINEL = "synthetic-test-secret";

async function expectToolError(call) {
  const result = await call;
  assert.strictEqual(result.isError, true);
  const message = result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  assert.match(message, /Input validation error: Invalid arguments for tool /);
}

function textJson(result) {
  assert.strictEqual(result.isError, undefined);
  return JSON.parse(result.content.find((block) => block.type === "text").text);
}

test("MCP server tools analyze, plan and gate secrets over stdio", { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-devops-smoke-"));
  const project = join(root, "fixture");
  await mkdir(project, { recursive: true });
  await writeFile(
    join(project, "package.json"),
    JSON.stringify({
      name: "fixture",
      dependencies: { next: "15.0.0", "@supabase/supabase-js": "2.0.0" },
    }),
  );
  await writeFile(join(project, "package-lock.json"), "{}");
  await writeFile(join(project, "index.ts"), "const key = process.env.SMOKE_KEY;\nexport default key;\n");

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    cwd: root,
    stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      MCP_DEVOPS_PROJECT_ROOTS: JSON.stringify([root]),
      MCP_DEVOPS_STATE_DIR: join(root, "state"),
    },
  });
  let serverStderr = "";
  transport.stderr.on("data", (chunk) => {
    serverStderr += chunk.toString("utf8");
  });
  const client = new Client({ name: "smoke-test", version: "0.1.0" }, { capabilities: {} });
  try {
    await client.connect(transport);

    const { tools } = await client.listTools();
    assert.ok(tools.some((t) => t.name === "propose_infrastructure_plan"));
    assert.ok(!tools.some((t) => t.name === "propose_infra_plan"));
    const analysis = textJson(await client.callTool({ name: "analyze_project_infra", arguments: { projectPath: project } }));
    assert.ok(analysis.frameworks.includes("nextjs"));
    for (const capability of ["serverless", "postgres", "auth", "storage"]) assert.ok(analysis.capabilities.includes(capability));
    assert.deepStrictEqual(analysis.envKeys, ["SMOKE_KEY"]);
    const commercialZero = textJson(await client.callTool({ name: "propose_infrastructure_plan", arguments: { projectPath: project, constraints: { maxMonthlyBudgetUsd: 0 } } }));
    assert.strictEqual(commercialZero.version, 2);
    assert.ok(commercialZero.recommended === null || commercialZero.recommended.status === "catalog_only");
    const personalZero = textJson(await client.callTool({ name: "propose_infrastructure_plan", arguments: { projectPath: project, constraints: { maxMonthlyBudgetUsd: 100, commercialUse: false } } }));
    assert.ok(personalZero.recommended);
    assert.ok(personalZero.steps.length);

    const writeAttempt = await client.callTool({
      name: "write_env_secrets",
      arguments: { projectPath: project, secrets: { API_TOKEN: SECRET_SENTINEL } },
    });
    assert.strictEqual(writeAttempt.isError, true);
    const writeError = JSON.parse(writeAttempt.content.find((block) => block.type === "text").text);
    assert.strictEqual(writeError.error.code, "APPROVAL_UNAVAILABLE");
    assert.strictEqual(existsSync(join(project, ".env")), false);

    for (const res of [analysis, commercialZero, personalZero, writeAttempt]) {
      assert.ok(!JSON.stringify(res).includes(SECRET_SENTINEL), "response must not echo secret values");
    }
    assert.ok(!serverStderr.includes(SECRET_SENTINEL), "server stderr must not contain secret values");

    await expectToolError(client.callTool({ name: "analyze_project_infra", arguments: { projectPath: "" } }));
    await expectToolError(
      client.callTool({
        name: "propose_infrastructure_plan",
        arguments: { projectPath: project, constraints: { maxMonthlyBudgetUsd: -1 } },
      }),
    );
    await expectToolError(
      client.callTool({
        name: "write_env_secrets",
        arguments: { projectPath: "/placeholder/project", secrets: { API_TOKEN: 42 } },
      }),
    );
    await expectToolError(
      client.callTool({
        name: "write_env_secrets",
        arguments: { projectPath: "/placeholder/project", secrets: { "BAD=KEY": "value" } },
      }),
    );
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("isWithinBudget validates and compares non-negative finite amounts", async () => {
  const { isWithinBudget } = await import("../dist/utils/budget.js");
  assert.strictEqual(isWithinBudget(0, 0), true);
  assert.strictEqual(isWithinBudget(5, 5), true);
  assert.strictEqual(isWithinBudget(6, 5), false);
  for (const [a, b] of [
    [NaN, 5],
    [Infinity, 5],
    [-1, 5],
    [5, NaN],
    [5, Infinity],
    [5, -1],
  ]) {
    assert.throws(() => isWithinBudget(a, b));
  }
});
