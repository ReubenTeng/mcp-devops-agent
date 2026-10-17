import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after } from "node:test";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const execFileP = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const tempDirs = [];

after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})));
});

async function fixture(name) {
  const dir = await mkdtemp(join(tmpdir(), name));
  tempDirs.push(dir);
  return dir;
}

function npmCommand(args) {
  const execPath = process.env.npm_execpath;
  if (execPath && execPath.endsWith(".js")) {
    return { command: process.execPath, args: [execPath, ...args] };
  }
  return { command: process.platform === "win32" ? "npm.cmd" : "npm", args };
}

async function npm(args, options) {
  const { command, args: argv } = npmCommand(args);
  const { stdout, stderr } = await execFileP(command, argv, {
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    ...options,
  });
  return { stdout, stderr };
}

function parsePackJson(stdout) {
  const start = stdout.indexOf("[");
  assert.notStrictEqual(start, -1, `npm pack --json produced no JSON array: ${stdout.slice(0, 500)}`);
  const parsed = JSON.parse(stdout.slice(start));
  assert.ok(Array.isArray(parsed) && parsed.length === 1);
  return parsed[0];
}

const expectedTools = ["analyze_project_infra", "cancel_infrastructure_step", "check_provider_connections", "discover_providers", "execute_infrastructure_step", "get_infrastructure_plan", "list_infrastructure_plans", "list_provider_capabilities", "prepare_infrastructure_plan", "propose_infrastructure_plan", "propose_teardown_plan", "quote_domain", "reconcile_infrastructure_step", "search_domains", "verify_infrastructure_plan", "write_env_secrets"];

test("the packed artifact installs and runs in a clean consumer", { timeout: 240_000 }, async () => {
  const packDir = await fixture("mcp-pack-");
  const consumer = await fixture("mcp-consumer-");
  const app = join(await fixture("mcp-app-"), "app");
  await mkdir(app, { recursive: true });
  await writeFile(
    join(app, "package.json"),
    JSON.stringify({ name: "consumer-app", dependencies: { next: "15.0.0" } }),
  );
  await writeFile(join(app, "index.ts"), "export const answer = 42;\n");
  const stateDir = join(dirname(app), "state");

  const { stdout: packOut } = await npm(["pack", "--json", "--silent", "--pack-destination", packDir], { cwd: repoRoot });
  const packed = parsePackJson(packOut);
  const tarball = join(packDir, packed.filename);
  assert.ok(existsSync(tarball));
  assert.ok(packed.size > 0);

  const paths = packed.files.map((file) => file.path);
  for (const required of [
    "package.json",
    "README.md",
    "dist/index.js",
    "dist/server.js",
    "dist/cli.js",
    "dist/doctor.js",
    "dist/metadata.js",
    "dist/config.js",
    "dist/server.d.ts",
    "dist/config.d.ts",
  ]) {
    assert.ok(paths.includes(required), `missing from package: ${required}`);
  }
  const manifest = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
  const sensitiveBasenames = new Set([
    ".env",
    ".npmrc",
    ".yarnrc",
    ".yarnrc.yml",
    ".pypirc",
    ".netrc",
    ".git-credentials",
    "id_rsa",
    "id_ed25519",
    "credentials",
    "AGENTS.md",
  ]);
  for (const file of paths) {
    assert.ok(
      ["package.json", "README.md", "IMPLEMENTATION_STATUS.md", "DEPLOYMENT.md", "skills/infrastructure-chat/SKILL.md"].includes(file) || /^dist\/.*\.(js|d\.ts|js\.map)$/.test(file),
      `unexpected file in package: ${file}`,
    );
    const base = file.split("/").pop();
    assert.ok(!sensitiveBasenames.has(base), `sensitive file leaked: ${file}`);
    assert.ok(!base.startsWith(".env."), `env variant leaked: ${file}`);
    assert.ok(!/\.(pem|key|p12|pfx)$/i.test(base), `credential material leaked: ${file}`);
  }

  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({ name: "consumer", private: true, type: "module" }),
  );
  await npm(
    ["install", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund", tarball],
    { cwd: consumer },
  );

  const installed = join(consumer, "node_modules", "mcp-devops-agent");
  assert.ok(existsSync(join(installed, "dist", "index.js")));
  assert.ok(existsSync(join(installed, "dist", "server.d.ts")));
  const binPath = join(consumer, "node_modules", ".bin", "mcp-devops-agent");

  if (process.platform !== "win32") {
    assert.ok(existsSync(binPath));
    const { stdout: version } = await execFileP(binPath, ["--version"], {
      cwd: consumer,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      timeout: 15_000,
    });
    assert.strictEqual(version.trim(), `${manifest.name} ${manifest.version}`);
    const { stdout: help } = await execFileP(binPath, ["--help"], {
      cwd: consumer,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      timeout: 15_000,
    });
    assert.match(help, /Usage:/);
  }

  const topLevel = await readdir(join(consumer, "node_modules"));
  assert.ok(!topLevel.includes("typescript"), "typescript must not be installed as a runtime dependency");
  assert.ok(!topLevel.includes("tsx"), "tsx must not be installed as a runtime dependency");

  const { stdout: apiCheck } = await execFileP(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const mod = await import("mcp-devops-agent");
if (typeof mod.createServer !== "function" || typeof mod.loadConfig !== "function") process.exit(1);
console.log("api-ok");`,
    ],
    { cwd: consumer, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" }, timeout: 15_000 },
  );
  assert.strictEqual(apiCheck.trim(), "api-ok");

  const serverEntry = process.platform === "win32" ? join(installed, "dist", "index.js") : binPath;
  const serverCommand = process.platform === "win32" ? process.execPath : binPath;
  const serverArgs = process.platform === "win32" ? [serverEntry, "serve"] : ["serve"];
  const transport = new StdioClientTransport({
    command: serverCommand,
    args: serverArgs,
    cwd: dirname(app),
    stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      MCP_DEVOPS_PROJECT_ROOTS: JSON.stringify([app]),
      MCP_DEVOPS_STATE_DIR: stateDir,
    },
  });
  let serverStderr = "";
  transport.stderr.on("data", (chunk) => {
    serverStderr += chunk.toString("utf8");
  });
  const client = new Client({ name: "pack-test", version: "0.1.0" }, { capabilities: {} });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepStrictEqual(tools.map((tool) => tool.name).sort(), expectedTools);

    const analysis = await client.callTool({
      name: "analyze_project_infra",
      arguments: { projectPath: app },
    });
    assert.strictEqual(analysis.isError, undefined);
    const analysisData = JSON.parse(analysis.content.find((block) => block.type === "text").text);
    assert.ok(Array.isArray(analysisData.frameworks));
    assert.ok(Array.isArray(analysisData.capabilities));

    const plan = await client.callTool({
      name: "propose_infrastructure_plan",
      arguments: { projectPath: app, constraints: { maxMonthlyBudgetUsd: 20, commercialUse: true } },
    });
    assert.strictEqual(plan.isError, undefined);
    const planData = JSON.parse(plan.content.find((block) => block.type === "text").text);
    assert.strictEqual(planData.version, 2);
    assert.ok(Array.isArray(planData.steps));
    assert.ok(Array.isArray(planData.alternatives));
    assert.ok(Array.isArray(planData.rejected));

    const secrets = await client.callTool({
      name: "write_env_secrets",
      arguments: { projectPath: app, secrets: { PACKED_CHECK: "no-write" } },
    });
    assert.strictEqual(secrets.isError, true);
    const secretsData = JSON.parse(secrets.content.find((block) => block.type === "text").text);
    assert.strictEqual(secretsData.error.code, "APPROVAL_UNAVAILABLE");
    assert.strictEqual(existsSync(join(app, ".env")), false);
  } finally {
    await client.close();
  }
  assert.ok(!serverStderr.includes("no-write"));
});
