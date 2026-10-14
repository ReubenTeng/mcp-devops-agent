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
    assert.deepStrictEqual(tools.map((t) => t.name).sort(), [
      "analyze_project_infra",
      "cancel_operation",
      "check_domain_availability",
      "check_provider_connections",
      "execute_infrastructure_change",
      "get_operation",
      "get_resource_status",
      "inspect_vercel_domain",
      "list_operations",
      "prepare_infrastructure_change",
      "propose_infra_plan",
      "reconcile_operation",
      "search_domains",
      "write_env_secrets",
    ]);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    assert.deepStrictEqual(byName["analyze_project_infra"].inputSchema.required, ["projectPath"]);
    assert.deepStrictEqual(
      byName["propose_infra_plan"].inputSchema.required.sort(),
      ["maxMonthlyBudgetUsd", "stackRequirements"].sort(),
    );
    assert.deepStrictEqual(byName["write_env_secrets"].inputSchema.required.sort(), ["projectPath", "secrets"].sort());

    const analysis = textJson(
      await client.callTool({ name: "analyze_project_infra", arguments: { projectPath: project } }),
    );
    assert.ok(analysis.frameworks.includes("nextjs"));
    for (const req of ["hosting", "serverless-functions", "sql", "auth", "storage"]) {
      assert.ok(analysis.stackRequirements.includes(req), `expected requirement ${req}`);
    }
    assert.strictEqual(analysis.packageManager, "npm");
    assert.deepStrictEqual(analysis.envKeys, ["SMOKE_KEY"]);
    assert.ok(analysis.missingPrerequisites.includes("hosting provider not configured"));
    assert.ok(analysis.missingPrerequisites.includes("database provider not configured"));

    const commercialZero = textJson(
      await client.callTool({
        name: "propose_infra_plan",
        arguments: { stackRequirements: ["hosting"], maxMonthlyBudgetUsd: 0, commercialUse: true },
      }),
    );
    assert.strictEqual(commercialZero.recommended, null);
    assert.strictEqual(commercialZero.budgetPolicy, "approved_estimates");
    assert.strictEqual(commercialZero.estimatesAreHardCaps, false);

    const personalZero = textJson(
      await client.callTool({
        name: "propose_infra_plan",
        arguments: {
          stackRequirements: ["hosting"],
          maxMonthlyBudgetUsd: 0,
          commercialUse: false,
          preferProductionReliability: false,
        },
      }),
    );
    assert.strictEqual(personalZero.recommended.estimatedMonthlyCostUsd, 0);
    assert.ok(personalZero.recommended.components.some((c) => c.id === "vercel-hobby"));

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
        name: "propose_infra_plan",
        arguments: { stackRequirements: ["sql"], maxMonthlyBudgetUsd: -1 },
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
