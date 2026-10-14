import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after } from "node:test";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const execFileP = promisify(execFile);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const entry = join(repoRoot, "dist", "index.js");
const SENTINEL = "SENTINEL_TOKEN_VALUE_9f3";
const tempDirs = [];

after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})));
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "mcp-cli-"));
  tempDirs.push(dir);
  return dir;
}

function baseEnv(extra = {}) {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    ...extra,
  };
}

async function run(args, { cwd, env, timeout = 10000 } = {}) {
  try {
    const { stdout, stderr } = await execFileP(process.execPath, [entry, ...args], {
      cwd,
      env: baseEnv(env),
      timeout,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code ?? -1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

const expectedTools = [
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
];

test("help works without configuration and never reads env or credentials", async () => {
  const dir = await fixture();
  for (const flag of ["--help", "-h"]) {
    const res = await run([flag], {
      cwd: dir,
      env: {
        MCP_DEVOPS_PROJECT_ROOTS: "not-json-at-all{",
        MCP_DEVOPS_STATE_DIR: "relative-not-absolute",
        VERCEL_TOKEN: SENTINEL,
      },
    });
    assert.strictEqual(res.code, 0);
    assert.match(res.stdout, /Usage:/);
    assert.match(res.stdout, /doctor/);
    assert.match(res.stdout, /elicitation/);
    assert.ok(!res.stdout.includes(SENTINEL));
    assert.ok(!res.stderr.includes(SENTINEL));
  }
  const entries = await readdir(dir);
  assert.deepStrictEqual(entries, []);
});

test("version matches package.json and the MCP server initialize metadata", async () => {
  const dir = await fixture();
  const res = await run(["--version"], { cwd: dir });
  assert.strictEqual(res.code, 0);
  const manifest = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
  assert.strictEqual(res.stdout, `${manifest.name} ${manifest.version}\n`);

  const { createServer, loadConfig } = await import("../dist/server.js");
  assert.strictEqual(typeof createServer, "function");
  assert.strictEqual(typeof loadConfig, "function");
  const config = loadConfig({ MCP_DEVOPS_PROJECT_ROOTS: JSON.stringify([dir]), MCP_DEVOPS_STATE_DIR: join(dir, "state") }, dir);
  const server = createServer(config, { fetch: async () => new Response("{}", { status: 500 }) });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "cli-test", version: "0.1.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const info = client.getServerVersion();
    assert.strictEqual(info.name, manifest.name);
    assert.strictEqual(info.version, manifest.version);
  } finally {
    await client.close();
    await server.close();
  }
});

test("unknown commands and flags exit 2 with a fixed message and empty stdout", async () => {
  const dir = await fixture();
  const secretArg = `--token=${SENTINEL}`;
  for (const args of [[secretArg], ["doctor", "--bogus"], ["serve", "extra"], ["--json"]]) {
    const res = await run(args, { cwd: dir });
    assert.strictEqual(res.code, 2, `args ${args.join(" ")}`);
    assert.strictEqual(res.stdout, "");
    assert.strictEqual(res.stderr, "Unknown command or option. Run mcp-devops-agent --help.\n");
  }
});

test("doctor --json is healthy offline with no credentials and writes nothing", async () => {
  const dir = await fixture();
  const project = join(dir, "app");
  await mkdir(project);
  const stateDir = join(dir, "state");
  const before = await readdir(dir);
  const res = await run(["doctor", "--json"], {
    cwd: dir,
    env: {
      MCP_DEVOPS_PROJECT_ROOTS: JSON.stringify([project]),
      MCP_DEVOPS_STATE_DIR: stateDir,
    },
  });
  assert.strictEqual(res.code, 0);
  assert.strictEqual(res.stderr, "");
  const report = JSON.parse(res.stdout);
  assert.strictEqual(report.readyForLocalTools, true);
  assert.strictEqual(report.readyForLiveChecks, false);
  assert.strictEqual(report.networkAccessed, false);
  assert.strictEqual(report.filesChanged, false);
  assert.strictEqual(report.approvalSupport, "must_be_verified_in_client");
  for (const provider of report.providers) {
    assert.strictEqual(provider.configured, false);
    assert.strictEqual(provider.connectionVerified, false);
    assert.ok(provider.missingSettings.length > 0);
  }
  assert.strictEqual(report.configuration.stateDirectory.status, "will_create");
  assert.strictEqual(existsSync(stateDir), false);
  assert.deepStrictEqual((await readdir(dir)).sort(), before.sort());
});

test("doctor reports credential presence only and never performs network access", async () => {
  const dir = await fixture();
  const project = join(dir, "app");
  await mkdir(project);
  const env = {
    MCP_DEVOPS_PROJECT_ROOTS: JSON.stringify([project]),
    MCP_DEVOPS_STATE_DIR: join(dir, "state"),
    VERCEL_TOKEN: SENTINEL,
    VERCEL_TEAM_ID: "team-sentinel-id",
    SUPABASE_ACCESS_TOKEN: "supa-sentinel",
    CLOUDFLARE_API_TOKEN: "cf-sentinel",
    CLOUDFLARE_ACCOUNT_ID: "cf-acc-sentinel",
  };
  const res = await run(["doctor", "--json"], { cwd: dir, env });
  assert.strictEqual(res.code, 0);
  assert.ok(!res.stdout.includes(SENTINEL));
  assert.ok(!res.stdout.includes("supa-sentinel"));
  assert.ok(!res.stdout.includes("cf-sentinel"));
  const report = JSON.parse(res.stdout);
  assert.strictEqual(report.readyForLiveChecks, true);
  assert.deepStrictEqual(
    report.providers.map((provider) => provider.configured),
    [true, true, true],
  );
  assert.ok(report.providers.every((provider) => provider.connectionVerified === false));

  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    fetchCalls += 1;
    return Promise.reject(new Error("network must not be used"));
  };
  try {
    const { buildDoctorReport } = await import("../dist/doctor.js");
    const inProcess = await buildDoctorReport(env, dir);
    assert.strictEqual(fetchCalls, 0);
    assert.strictEqual(inProcess.networkAccessed, false);
    assert.strictEqual(inProcess.readyForLiveChecks, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("doctor fails on invalid configuration and unsafe paths without mutating anything", async () => {
  const malformed = await fixture();
  const res1 = await run(["doctor"], {
    cwd: malformed,
    env: { MCP_DEVOPS_PROJECT_ROOTS: "{{not json" },
  });
  assert.strictEqual(res1.code, 1);
  assert.match(res1.stdout, /INVALID_CONFIG/);

  const missingRoot = await fixture();
  const res2 = await run(["doctor", "--json"], {
    cwd: missingRoot,
    env: { MCP_DEVOPS_PROJECT_ROOTS: JSON.stringify([join(missingRoot, "ghost")]) },
  });
  assert.strictEqual(res2.code, 1);
  const report2 = JSON.parse(res2.stdout);
  assert.strictEqual(report2.configuration.projectRoots[0].status, "unavailable");
  assert.strictEqual(report2.readyForLocalTools, false);

  const badState = await fixture();
  const project = join(badState, "app");
  const stateDir = join(badState, "state");
  await mkdir(project);
  await mkdir(stateDir, { mode: 0o755 });
  const res3 = await run(["doctor", "--json"], {
    cwd: badState,
    env: { MCP_DEVOPS_PROJECT_ROOTS: JSON.stringify([project]), MCP_DEVOPS_STATE_DIR: stateDir },
  });
  assert.strictEqual(res3.code, 1);
  assert.strictEqual(JSON.parse(res3.stdout).configuration.stateDirectory.status, "unsafe");

  if (process.platform !== "win32") {
    const linked = await fixture();
    const project2 = join(linked, "app");
    const realState = join(linked, "real-state");
    const linkState = join(linked, "state");
    await mkdir(project2);
    await mkdir(realState, { mode: 0o700 });
    await symlink(realState, linkState, "dir");
    const res4 = await run(["doctor", "--json"], {
      cwd: linked,
      env: { MCP_DEVOPS_PROJECT_ROOTS: JSON.stringify([project2]), MCP_DEVOPS_STATE_DIR: linkState },
    });
    assert.strictEqual(res4.code, 1);
    assert.strictEqual(JSON.parse(res4.stdout).configuration.stateDirectory.status, "unsafe");
  }

  for (const dir of [malformed, missingRoot, badState]) {
    const entries = await readdir(dir);
    assert.ok(!entries.includes("operations"));
  }
});

test("doctor rejects unreadable state dirs and roots on POSIX", { skip: process.platform === "win32" || (typeof process.getuid === "function" && process.getuid() === 0) }, async () => {
  {
    const dir = await fixture();
    const project = join(dir, "app");
    const stateDir = join(dir, "state");
    await mkdir(project);
    await mkdir(stateDir, { mode: 0o700 });
    await chmod(stateDir, 0o500);
    try {
      const res = await run(["doctor", "--json"], {
        cwd: dir,
        env: { MCP_DEVOPS_PROJECT_ROOTS: JSON.stringify([project]), MCP_DEVOPS_STATE_DIR: stateDir },
      });
      assert.strictEqual(res.code, 1);
      const report = JSON.parse(res.stdout);
      assert.strictEqual(report.configuration.stateDirectory.status, "unsafe");
      assert.strictEqual(report.readyForLocalTools, false);
    } finally {
      await chmod(stateDir, 0o700);
    }
  }
  {
    const dir = await fixture();
    const project = join(dir, "app");
    const stateDir = join(dir, "state");
    const opsDir = join(stateDir, "operations");
    await mkdir(project);
    await mkdir(stateDir, { mode: 0o700 });
    await mkdir(opsDir, { mode: 0o700 });
    await chmod(opsDir, 0o000);
    try {
      const res = await run(["doctor", "--json"], {
        cwd: dir,
        env: { MCP_DEVOPS_PROJECT_ROOTS: JSON.stringify([project]), MCP_DEVOPS_STATE_DIR: stateDir },
      });
      assert.strictEqual(res.code, 1);
      assert.strictEqual(JSON.parse(res.stdout).configuration.stateDirectory.status, "unsafe");
    } finally {
      await chmod(opsDir, 0o700);
    }
  }
  {
    const dir = await fixture();
    const project = join(dir, "app");
    const blocked = join(dir, "blocked");
    const stateDir = join(blocked, "state");
    await mkdir(project);
    await mkdir(blocked);
    await chmod(blocked, 0o000);
    try {
      const res = await run(["doctor", "--json"], {
        cwd: dir,
        env: { MCP_DEVOPS_PROJECT_ROOTS: JSON.stringify([project]), MCP_DEVOPS_STATE_DIR: stateDir },
      });
      assert.strictEqual(res.code, 1);
      const report = JSON.parse(res.stdout);
      assert.strictEqual(report.configuration.stateDirectory.status, "unsafe");
      assert.ok(report.errors.some((error) => error.code === "STATE_DIR_UNUSABLE" || error.code === "UNSAFE_STATE_DIR"));
      assert.strictEqual(existsSync(stateDir), false);
    } finally {
      await chmod(blocked, 0o700);
    }
  }
  {
    const dir = await fixture();
    const project = join(dir, "app");
    await mkdir(project, { mode: 0o700 });
    await chmod(project, 0o000);
    try {
      const res = await run(["doctor", "--json"], {
        cwd: dir,
        env: { MCP_DEVOPS_PROJECT_ROOTS: JSON.stringify([project]), MCP_DEVOPS_STATE_DIR: join(dir, "state") },
      });
      assert.strictEqual(res.code, 1);
      const report = JSON.parse(res.stdout);
      assert.strictEqual(report.configuration.projectRoots[0].status, "unavailable");
      assert.strictEqual(report.readyForLocalTools, false);
    } finally {
      await chmod(project, 0o700);
    }
  }
});

test("serve alias performs a normal stdio handshake and lists all tools", { timeout: 15000 }, async () => {
  const dir = await fixture();
  const project = join(dir, "app");
  await mkdir(project);
  await writeFile(join(project, "package.json"), JSON.stringify({ name: "app" }));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry, "serve"],
    cwd: dir,
    stderr: "pipe",
    env: baseEnv({
      MCP_DEVOPS_PROJECT_ROOTS: JSON.stringify([project]),
      MCP_DEVOPS_STATE_DIR: join(dir, "state"),
    }),
  });
  const client = new Client({ name: "cli-serve-test", version: "0.1.0" }, { capabilities: {} });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepStrictEqual(tools.map((tool) => tool.name).sort(), expectedTools);
  } finally {
    await client.close();
  }
});
