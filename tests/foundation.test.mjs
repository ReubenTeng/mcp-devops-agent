import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const SECRET_SENTINEL = "synthetic-test-secret";

const files = await import("../dist/utils/files.js");
const env = await import("../dist/utils/env.js");
const budget = await import("../dist/utils/budget.js");
const planning = await import("../dist/planning.js");
const { createLegacyServer: createServer } = await import("../dist/legacy-server.js");
const { analyzeProject } = await import("../dist/tools/scan.js");

const tempDirs = [];

after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempRoot() {
  const dir = await mkdtemp(join(tmpdir(), "mcp-devops-foundation-"));
  tempDirs.push(dir);
  return dir;
}

function errorCode(err) {
  return err && err.code;
}

test("resolveProjectPath enforces canonical root boundaries", async () => {
  const root = await tempRoot();
  const inside = join(root, "project");
  const sibling = `${root}-sibling`;
  tempDirs.push(sibling);
  const outside = await tempRoot();
  await mkdir(inside, { recursive: true });
  await mkdir(sibling, { recursive: true });

  const resolved = await files.resolveProjectPath(inside, [root]);
  assert.strictEqual(resolved, await files.resolveProjectPath(resolved, [root]));

  await assert.rejects(() => files.resolveProjectPath(join(inside, "..", ".."), [root]), (e) =>
    ["INVALID_PROJECT_PATH", "PATH_NOT_ALLOWED"].includes(errorCode(e)),
  );
  await assert.rejects(() => files.resolveProjectPath("relative/path", [root]), (e) => errorCode(e) === "INVALID_PROJECT_PATH");
  await assert.rejects(() => files.resolveProjectPath(join(root, "missing"), [root]), (e) => errorCode(e) === "INVALID_PROJECT_PATH");
  await assert.rejects(() => files.resolveProjectPath(sibling, [root]), (e) => errorCode(e) === "PATH_NOT_ALLOWED");
  await assert.rejects(() => files.resolveProjectPath(outside, [root]), (e) => errorCode(e) === "PATH_NOT_ALLOWED");

  const escapeLink = join(root, "escape-link");
  await symlink(outside, escapeLink, "dir");
  await assert.rejects(() => files.resolveProjectPath(escapeLink, [root]), (e) => errorCode(e) === "PATH_NOT_ALLOWED");

  const innerTarget = join(inside, "real");
  await mkdir(innerTarget);
  await symlink(innerTarget, join(inside, "inner-link"), "dir");
  await assert.rejects(
    () => files.resolveProjectPath(join(inside, "inner-link"), [root]),
    (e) => errorCode(e) === "UNSAFE_PATH",
  );
  assert.strictEqual(await files.resolveProjectPath(innerTarget, [root]), join(resolved, "real"));

  const filePath = join(inside, "file.txt");
  await writeFile(filePath, "x");
  await assert.rejects(() => files.resolveProjectPath(filePath, [root]), (e) => errorCode(e) === "INVALID_PROJECT_PATH");
});

test("readProjectFile rejects traversal, symlinks and oversize files", async () => {
  const root = await tempRoot();
  await writeFile(join(root, "ok.txt"), "hello");
  assert.strictEqual(await files.readProjectFile(root, "ok.txt"), "hello");
  assert.strictEqual(await files.readProjectFile(root, "missing.txt"), undefined);

  await assert.rejects(() => files.readProjectFile(root, "../outside.txt"), (e) => errorCode(e) === "INVALID_FILE_PATH");
  await assert.rejects(() => files.readProjectFile(root, "/abs/path"), (e) => errorCode(e) === "INVALID_FILE_PATH");
  await assert.rejects(() => files.readProjectFile(root, "a/../../b"), (e) => errorCode(e) === "INVALID_FILE_PATH");

  const outside = await tempRoot();
  const target = join(outside, "secret.txt");
  await writeFile(target, "nope");
  await symlink(target, join(root, "linked.txt"));
  await assert.rejects(() => files.readProjectFile(root, "linked.txt"), (e) => errorCode(e) === "UNSAFE_PATH");

  await mkdir(join(root, "dir"));
  await symlink(outside, join(root, "dir-link"), "dir");
  await assert.rejects(() => files.readProjectFile(root, "dir-link/secret.txt"), (e) => errorCode(e) === "UNSAFE_PATH");

  await writeFile(join(root, "big.txt"), Buffer.alloc(2048));
  await assert.rejects(() => files.readProjectFile(root, "big.txt", 1024), (e) => errorCode(e) === "FILE_TOO_LARGE");
});

test("readProjectBytes reads binaries and rejects directories, hardlinks and special files", async () => {
  const root = await tempRoot();
  await writeFile(join(root, "bin.dat"), Buffer.from([0, 1, 2, 255]));
  assert.deepStrictEqual([...(await files.readProjectBytes(root, "bin.dat", 1024))], [0, 1, 2, 255]);
  assert.strictEqual(await files.readProjectBytes(root, "missing.dat", 1024), undefined);

  await mkdir(join(root, "plain-dir"));
  await assert.rejects(() => files.readProjectFile(root, "plain-dir"), (e) => errorCode(e) === "UNSAFE_PATH");

  const hardSource = join(root, "hard-source.txt");
  await writeFile(hardSource, "x");
  await link(hardSource, join(root, "hard-second.txt"));
  await assert.rejects(() => files.readProjectFile(root, "hard-source.txt"), (e) => errorCode(e) === "UNSAFE_PATH");

  if (process.platform !== "win32") {
    execFileSync("mkfifo", [join(root, "pipe.fifo")]);
    await assert.rejects(() => files.readProjectFile(root, "pipe.fifo"), (e) => errorCode(e) === "UNSAFE_PATH");
  }
});

test("withFileLock serializes writers and releases the lock", async () => {
  const root = await tempRoot();
  const target = join(root, ".env");
  await assert.rejects(
    () =>
      files.withFileLock(target, async () => {
        assert.ok(existsSync(`${target}.lock`));
        return files.withFileLock(target, async () => "never");
      }),
    (e) => errorCode(e) === "FILE_BUSY",
  );
  const result = await files.withFileLock(target, async () => "done");
  assert.strictEqual(result, "done");
  assert.strictEqual(existsSync(`${target}.lock`), false);
});

test("atomicWritePrivate writes 0600 and refuses symlink/hardlink targets", async () => {
  const root = await tempRoot();
  const target = join(root, ".env");
  await files.atomicWritePrivate(target, "A=1\n");
  assert.strictEqual(await readFile(target, "utf8"), "A=1\n");
  assert.strictEqual((await stat(target)).mode & 0o777, 0o600);

  await files.atomicWritePrivate(target, "A=2\n");
  assert.strictEqual(await readFile(target, "utf8"), "A=2\n");

  const linked = join(root, ".env.linked");
  await symlink(join(root, "elsewhere"), linked);
  await assert.rejects(() => files.atomicWritePrivate(linked, "B=1\n"), (e) => errorCode(e) === "UNSAFE_PATH");

  const hard = join(root, ".env.hard");
  await writeFile(hard, "C=1\n");
  await link(hard, join(root, ".env.hard2"));
  await assert.rejects(() => files.atomicWritePrivate(hard, "C=2\n"), (e) => errorCode(e) === "UNSAFE_PATH");
  assert.strictEqual(await readFile(hard, "utf8"), "C=1\n");

  await assert.rejects(
    () => files.atomicWritePrivate(join(root, "no-dir", ".env"), "D=1\n"),
    (e) => errorCode(e) === "INVALID_PROJECT_PATH",
  );
});

test("mergeEnvContents preserves unrelated content and round-trips values", async () => {
  const { mergeEnvContents } = env;
  const dotenv = await import("dotenv");

  const merged = mergeEnvContents(
    "# top comment\nKEEP=1 # inline\nexport OLD=previous\n\nOTHER=\"quoted\"\n",
    { OLD: "new-value", ADDED: "fresh" },
  );
  const parsed = dotenv.parse(merged);
  assert.strictEqual(parsed.OLD, "new-value");
  assert.strictEqual(parsed.ADDED, "fresh");
  assert.strictEqual(parsed.KEEP, "1");
  assert.strictEqual(parsed.OTHER, "quoted");
  assert.match(merged, /# top comment/);
  assert.match(merged, /KEEP=1 # inline/);
  assert.match(merged, /export OLD=/);

  const dupes = mergeEnvContents("A=1\nA=2\n", { A: "x" });
  assert.deepStrictEqual(dotenv.parse(dupes).A, "x");
  assert.strictEqual((dupes.match(/A=/g) ?? []).length, 2);

  const noTrailing = mergeEnvContents("ONLY=1", { NEW: "2" });
  assert.match(noTrailing, /ONLY=1\r?\nNEW=/);
  assert.strictEqual(dotenv.parse(noTrailing).NEW, "2");

  const crlf = mergeEnvContents("A=1\r\nB=2\r\n", { A: "z" });
  assert.strictEqual(crlf.replace(/\r\n/g, "").includes("\n"), false);
  assert.strictEqual(dotenv.parse(crlf).A, "z");
  assert.strictEqual(dotenv.parse(crlf).B, "2");

  const roundTripValues = [
    "it's fine",
    "has `backtick`",
    'has "double"',
    "dollar $HOME sign",
    "back\\slash",
    "trailing space ",
    "hash#nospace",
    "hash #space",
    "line1\nline2",
    "carriage\rreturn",
    "héllo wörld 日本語",
    "tab\there",
  ];
  for (const value of roundTripValues) {
    const out = mergeEnvContents("", { VAL: value });
    assert.strictEqual(dotenv.parse(out).VAL, value, `round-trip failed for ${JSON.stringify(value)}`);
  }

  const duplicateKeys = mergeEnvContents("A=1\nA=2\nB=3\n", { A: "u" });
  assert.strictEqual(dotenv.parse(duplicateKeys).B, "3");
});

test("mergeEnvContents fails closed on unsupported values and malformed files", async () => {
  const { mergeEnvContents } = env;

  assert.throws(() => mergeEnvContents("", { "BAD=KEY": "x" }), (e) => errorCode(e) === "INVALID_SECRET_KEY");
  assert.throws(
    () => mergeEnvContents("", Object.fromEntries([["__proto__", "x"]])),
    (e) => errorCode(e) === "INVALID_SECRET_KEY",
  );
  assert.throws(() => mergeEnvContents("", { constructor: "x" }), (e) => errorCode(e) === "INVALID_SECRET_KEY");
  assert.throws(
    () => mergeEnvContents("", { OK: `a${String.fromCharCode(0)}b` }),
    (e) => errorCode(e) === "INVALID_SECRET_VALUE",
  );

  assert.throws(
    () => mergeEnvContents("BROKEN=\"never closed\nNEXT=1\n", { ADDED: "x" }),
    (e) => errorCode(e) === "MALFORMED_ENV",
  );

  const tricky = `a 'b\`c${"\\"}nd #x`;
  assert.throws(() => mergeEnvContents("", { VAL: tricky }), (e) => errorCode(e) === "UNSUPPORTED_ENV_VALUE");

  const multiline = 'A="line one\nB=looks-like-assignment\nline three"\n';
  const dotenv = await import("dotenv");
  const updated = mergeEnvContents(multiline, { OTHER: "v" });
  assert.strictEqual(dotenv.parse(updated).A, dotenv.parse(multiline).A);
  assert.strictEqual(dotenv.parse(updated).OTHER, "v");

  const collision = mergeEnvContents("", { _MCP_PROBE_BEFORE: "x", _MCP_PROBE_AFTER: "y" });
  const parsedCollision = dotenv.parse(collision);
  assert.strictEqual(parsedCollision._MCP_PROBE_BEFORE, "x");
  assert.strictEqual(parsedCollision._MCP_PROBE_AFTER, "y");

  assert.throws(
    () => mergeEnvContents('BROKEN="never closed\n', { BROKEN: "x" }),
    (e) => errorCode(e) === "MALFORMED_ENV",
  );

  const filler = `# ${"x".repeat(1024 * 1024)}\nA=1\n`;
  assert.throws(
    () => mergeEnvContents(filler, { ADDED: "x" }),
    (e) => errorCode(e) === "ENV_MERGE_UNSAFE",
  );
});

test("readSelectedEnv treats inherited names as missing", async () => {
  const root = await tempRoot();
  await writeFile(join(root, ".env"), "ALPHA=1\n");
  await assert.rejects(() => env.readSelectedEnv(root, ["toString"]), (e) => errorCode(e) === "MISSING_ENV_KEY");
});

test("updateEnvSecrets writes atomically, rejects unsafe files and stays silent on empty input", async () => {
  const root = await tempRoot();
  const project = join(root, "p");
  await mkdir(project);
  const envPath = join(project, ".env");
  await writeFile(envPath, "KEEP=1\nOLD=gone\n");
  await chmod(envPath, 0o644);

  const updated = await env.updateEnvSecrets(project, { OLD: SECRET_SENTINEL, NEW_KEY: "n" });
  assert.deepStrictEqual(updated, ["NEW_KEY", "OLD"]);
  const written = await readFile(envPath, "utf8");
  const dotenv = await import("dotenv");
  assert.strictEqual(dotenv.parse(written).OLD, SECRET_SENTINEL);
  assert.strictEqual(dotenv.parse(written).KEEP, "1");
  assert.strictEqual((await stat(envPath)).mode & 0o777, 0o600);

  assert.deepStrictEqual(await env.updateEnvSecrets(project, {}), []);

  const before = await readFile(envPath, "utf8");
  await writeFile(`${envPath}.lock`, "");
  await assert.rejects(() => env.updateEnvSecrets(project, { NEW_KEY: "x" }), (e) => errorCode(e) === "FILE_BUSY");
  assert.strictEqual(await readFile(envPath, "utf8"), before);
  await unlink(`${envPath}.lock`);

  const linkProject = join(root, "linked");
  await mkdir(linkProject);
  const realEnv = join(root, "real-env");
  await writeFile(realEnv, "A=1\n");
  await symlink(realEnv, join(linkProject, ".env"));
  await assert.rejects(
    () => env.updateEnvSecrets(linkProject, { A: "x" }),
    (e) => errorCode(e) === "UNSAFE_ENV_FILE",
  );
  assert.strictEqual(await readFile(realEnv, "utf8"), "A=1\n");

  const hardProject = join(root, "hard");
  await mkdir(hardProject);
  const hardEnv = join(hardProject, ".env");
  await writeFile(hardEnv, "A=1\n");
  await link(hardEnv, join(root, "hard-copy"));
  await assert.rejects(
    () => env.updateEnvSecrets(hardProject, { A: "x" }),
    (e) => errorCode(e) === "UNSAFE_ENV_FILE",
  );
  assert.strictEqual(await readFile(hardEnv, "utf8"), "A=1\n");
});

test("readSelectedEnv returns only requested keys and fails safely on missing keys", async () => {
  const root = await tempRoot();
  await writeFile(join(root, ".env"), "ALPHA=1\nBETA=2\n");
  assert.deepStrictEqual(await env.readSelectedEnv(root, ["BETA"]), { BETA: "2" });
  await assert.rejects(() => env.readSelectedEnv(root, ["GAMMA"]), (e) => errorCode(e) === "MISSING_ENV_KEY");
  await assert.rejects(() => env.readSelectedEnv(root, ["BAD=K"]), (e) => errorCode(e) === "INVALID_SECRET_KEY");
});

test("usdToCents and decimalUsdToCents enforce safe money handling", async () => {
  assert.strictEqual(budget.usdToCents(0), 0);
  assert.strictEqual(budget.usdToCents(19.99), 1999);
  for (const bad of [-1, NaN, Infinity, 19.999, 1_000_001]) {
    assert.throws(() => budget.usdToCents(bad), (e) => errorCode(e) === "INVALID_BUDGET");
  }
  assert.strictEqual(budget.decimalUsdToCents("0"), 0);
  assert.strictEqual(budget.decimalUsdToCents("25.05"), 2505);
  for (const bad of ["abc", "1.234", "-5", "99999999999"]) {
    assert.throws(() => budget.decimalUsdToCents(bad), (e) => errorCode(e) === "INVALID_PRICE");
  }
});

const baseInput = { commercialUse: true, preferProductionReliability: true };

test("proposeInfraPlan composes catalog candidates under approved estimates", async () => {
  const { proposeInfraPlan } = planning;
  const now = new Date("2026-10-15");

  const personalFree = proposeInfraPlan(
    { stackRequirements: ["hosting"], maxMonthlyBudgetUsd: 0, commercialUse: false, preferProductionReliability: false },
    now,
  );
  assert.strictEqual(personalFree.recommended.estimatedMonthlyCostUsd, 0);
  assert.ok(personalFree.recommended.components.some((c) => c.id === "vercel-hobby"));

  const commercialZero = proposeInfraPlan({ stackRequirements: ["hosting"], maxMonthlyBudgetUsd: 0, ...baseInput }, now);
  assert.strictEqual(commercialZero.recommended, null);
  assert.ok(commercialZero.alternatives.length >= 2);

  const commercialPro = proposeInfraPlan({ stackRequirements: ["hosting"], maxMonthlyBudgetUsd: 20, ...baseInput }, now);
  assert.strictEqual(commercialPro.recommended.estimatedMonthlyCostUsd, 20);
  assert.ok(commercialPro.recommended.components.some((c) => c.id === "vercel-pro"));
  assert.ok(commercialPro.alternatives.some((v) => v.components.some((c) => c.id === "vercel-hobby")));

  const sqlReliable = proposeInfraPlan({ stackRequirements: ["postgres"], maxMonthlyBudgetUsd: 25, ...baseInput }, now);
  assert.ok(sqlReliable.recommended.components.some((c) => c.id === "supabase-pro"));
  assert.strictEqual(sqlReliable.recommended.estimatedMonthlyCostUsd, 25);

  const sqlFree = proposeInfraPlan({ stackRequirements: ["sql"], maxMonthlyBudgetUsd: 0, ...baseInput }, now);
  assert.ok(sqlFree.recommended.components.some((c) => c.id === "supabase-free"));

  const full = proposeInfraPlan({ stackRequirements: ["hosting", "sql"], maxMonthlyBudgetUsd: 45, ...baseInput }, now);
  assert.strictEqual(full.recommended.estimatedMonthlyCostUsd, 45);
  assert.ok(full.recommended.components.some((c) => c.id === "vercel-pro"));
  assert.ok(full.recommended.components.some((c) => c.id === "supabase-pro"));

  const unknown = proposeInfraPlan({ stackRequirements: ["redis"], maxMonthlyBudgetUsd: 100, ...baseInput }, now);
  assert.strictEqual(unknown.recommended, null);
  assert.deepStrictEqual(unknown.unmetRequirements.map((u) => u.requirement), ["redis"]);

  const inherited = proposeInfraPlan(
    { stackRequirements: ["constructor", "toString"], maxMonthlyBudgetUsd: 100, ...baseInput },
    now,
  );
  assert.deepStrictEqual(inherited.unmetRequirements.map((u) => u.requirement), ["constructor", "tostring"]);

  const domain = proposeInfraPlan({ stackRequirements: ["domains"], maxMonthlyBudgetUsd: 100, ...baseInput }, now);
  assert.strictEqual(domain.recommended, null);
  const domainUnmet = domain.unmetRequirements.find((u) => u.requirement === "domain-registration");
  assert.match(domainUnmet.reason, /registrar/i);
  assert.ok(domain.alternatives.every((v) => v.estimatedUpfrontCostUsd === null));

  const empty = proposeInfraPlan({ stackRequirements: [], maxMonthlyBudgetUsd: 0, ...baseInput }, now);
  assert.deepStrictEqual(empty.recommended.components, []);
  assert.strictEqual(empty.recommended.estimatedMonthlyCostUsd, 0);

  const stale = proposeInfraPlan(
    { stackRequirements: ["hosting"], maxMonthlyBudgetUsd: 50, ...baseInput },
    new Date("2026-12-01"),
  );
  assert.strictEqual(stale.pricingStale, true);
  assert.strictEqual(stale.recommended, null);
  assert.ok(stale.alternatives.length > 0);

  for (const budgetValue of [-1, NaN, Infinity, 19.999]) {
    assert.throws(
      () => proposeInfraPlan({ stackRequirements: [], maxMonthlyBudgetUsd: budgetValue, ...baseInput }, now),
      (e) => errorCode(e) === "INVALID_BUDGET",
    );
  }

  const aliased = proposeInfraPlan(
    { stackRequirements: ["postgresql", "authentication", "object-storage"], maxMonthlyBudgetUsd: 25, ...baseInput },
    now,
  );
  assert.ok(aliased.recommended.components.some((c) => c.provider === "supabase"));
  assert.deepStrictEqual(aliased.recommended.unmetRequirements, []);

  assert.strictEqual(personalFree.estimatesAreHardCaps, false);
  assert.ok(personalFree.warnings.some((w) => w.includes("not a billing cap")));
});

test("analyzeProject ignores .env, symlinks and gitignored files without executing code", async () => {
  const root = await tempRoot();
  const project = join(root, "proj");
  await mkdir(project, { recursive: true });
  const config = { projectRoots: [root], stateDir: join(root, "state"), credentials: {} };

  await writeFile(
    join(project, "package.json"),
    JSON.stringify({
      name: "fixture",
      scripts: { postinstall: "touch EXECUTED_MARKER" },
      dependencies: { express: "4.0.0" },
    }),
  );
  await writeFile(join(project, ".env"), "HIDDEN_KEY=nope\n");
  await writeFile(join(project, ".env.example"), "EXAMPLE_KEY=\n");
  await writeFile(join(project, ".gitignore"), "*.skip.ts\n!important.ts\nignored-dir/\n");
  await writeFile(join(project, "visible.ts"), "process.env.VISIBLE_KEY;\n");
  await writeFile(join(project, "temp.skip.ts"), "process.env.SKIPPED_KEY;\n");
  await writeFile(join(project, "important.ts"), "import.meta.env.IMPORTANT_KEY;\n");
  await mkdir(join(project, "ignored-dir"));
  await writeFile(join(project, "ignored-dir", "inner.ts"), "process.env.IGNORED_DIR_KEY;\n");
  await writeFile(join(project, "env-target"), "process.env.VIA_SYMLINK;\n");
  await symlink(join(project, "env-target"), join(project, "linked.ts"));
  await mkdir(join(project, "nested"));
  await writeFile(join(project, "nested", ".gitignore"), "hidden.ts\n");
  await writeFile(join(project, "nested", "hidden.ts"), "process.env.NESTED_HIDDEN;\n");
  await writeFile(join(project, "nested", "shown.ts"), "process.env.NESTED_SHOWN;\n");

  const analysis = await analyzeProject(project, config);
  assert.ok(analysis.envKeys.includes("EXAMPLE_KEY"));
  assert.ok(analysis.envKeys.includes("VISIBLE_KEY"));
  assert.ok(analysis.envKeys.includes("IMPORTANT_KEY"));
  assert.ok(analysis.envKeys.includes("NESTED_SHOWN"));
  for (const forbidden of ["HIDDEN_KEY", "SKIPPED_KEY", "IGNORED_DIR_KEY", "VIA_SYMLINK", "NESTED_HIDDEN"]) {
    assert.ok(!analysis.envKeys.includes(forbidden), `${forbidden} must not be collected`);
  }
  assert.ok(analysis.frameworks.includes("express"));
  assert.ok(analysis.stackRequirements.includes("node-server"));
  assert.strictEqual(existsSync(join(project, "EXECUTED_MARKER")), false);
});

test("analyzeProject distinguishes prisma engines and warns when unconfirmed", async () => {
  const root = await tempRoot();
  const config = { projectRoots: [root], stateDir: join(root, "state"), credentials: {} };

  const sqliteProj = join(root, "sqlite-proj");
  await mkdir(sqliteProj, { recursive: true });
  await writeFile(
    join(sqliteProj, "package.json"),
    JSON.stringify({ name: "s", dependencies: { "@prisma/client": "6.0.0" } }),
  );
  await writeFile(join(sqliteProj, "schema.prisma"), 'datasource db { provider = "sqlite" }\n');
  const sqliteAnalysis = await analyzeProject(sqliteProj, config);
  assert.ok(sqliteAnalysis.stackRequirements.includes("sqlite"));
  assert.ok(!sqliteAnalysis.stackRequirements.includes("sql"));

  const unknownProj = join(root, "unknown-proj");
  await mkdir(unknownProj, { recursive: true });
  await writeFile(
    join(unknownProj, "package.json"),
    JSON.stringify({ name: "u", dependencies: { "drizzle-orm": "1.0.0" } }),
  );
  const unknownAnalysis = await analyzeProject(unknownProj, config);
  assert.ok(!unknownAnalysis.stackRequirements.includes("sql"));
  assert.ok(unknownAnalysis.warnings.some((w) => w.includes("database engine could not be confirmed")));

  const mysqlProj = join(root, "mysql-proj");
  await mkdir(mysqlProj, { recursive: true });
  await writeFile(
    join(mysqlProj, "package.json"),
    JSON.stringify({ name: "m", dependencies: { mysql2: "3.0.0" } }),
  );
  const mysqlAnalysis = await analyzeProject(mysqlProj, config);
  assert.ok(mysqlAnalysis.stackRequirements.includes("mysql"));
});

test("analyzeProject honors nested negation and fails closed on unreadable files", async () => {
  const root = await tempRoot();
  const project = join(root, "proj");
  await mkdir(project, { recursive: true });
  const config = { projectRoots: [root], stateDir: join(root, "state"), credentials: {} };

  await writeFile(join(project, ".gitignore"), "sub/*.ts\n");
  await mkdir(join(project, "sub"));
  await writeFile(join(project, "sub", ".gitignore"), "!shown.ts\n");
  await writeFile(join(project, "sub", "shown.ts"), "process.env.SHOWN_KEY;\n");
  await writeFile(join(project, "sub", "hidden.ts"), "process.env.HIDDEN_SUB_KEY;\n");

  const analysis = await analyzeProject(project, config);
  assert.ok(analysis.envKeys.includes("SHOWN_KEY"));
  assert.ok(!analysis.envKeys.includes("HIDDEN_SUB_KEY"));

  const broken = join(root, "broken-proj");
  await mkdir(join(broken, "bad", ".gitignore"), { recursive: true });
  await writeFile(join(broken, "bad", "inside.ts"), "process.env.UNREADABLE_DIR_KEY;\n");
  await writeFile(join(broken, "package.json"), JSON.stringify({ name: "b" }));
  const brokenAnalysis = await analyzeProject(broken, config);
  assert.ok(brokenAnalysis.warnings.some((w) => w.includes(".gitignore")));
  assert.ok(!brokenAnalysis.envKeys.includes("UNREADABLE_DIR_KEY"));

  const unreadable = join(root, "unreadable-proj");
  await mkdir(unreadable, { recursive: true });
  await writeFile(join(unreadable, "package.json"), JSON.stringify({ name: "u" }));
  const locked = join(unreadable, "locked.ts");
  await writeFile(locked, "process.env.LOCKED_KEY;\n");
  await chmod(locked, 0o000);
  try {
    const lockedAnalysis = await analyzeProject(unreadable, config);
    assert.ok(lockedAnalysis.warnings.some((w) => w.includes("incomplete")));
    assert.ok(!lockedAnalysis.envKeys.includes("LOCKED_KEY"));
  } finally {
    await chmod(locked, 0o644);
  }
});

test("write_env_secrets requires real form elicitation approval", { timeout: 15000 }, async () => {
  const root = await tempRoot();
  const project = join(root, "proj");
  await mkdir(project);
  const config = { projectRoots: [root], stateDir: join(root, "state"), credentials: {} };

  async function withServer(clientOptions, handler, fn) {
    const server = createServer(config);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "foundation-test", version: "0.1.0" }, clientOptions);
    if (handler) client.setRequestHandler(ElicitRequestSchema, handler);
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      await fn(client);
    } finally {
      await client.close();
      await server.close();
    }
  }

  const callWrite = (client, secrets) =>
    client.callTool({ name: "write_env_secrets", arguments: { projectPath: project, secrets } });

  await withServer({ capabilities: {} }, null, async (client) => {
    const res = await callWrite(client, { API_TOKEN: SECRET_SENTINEL });
    assert.strictEqual(res.isError, true);
    assert.strictEqual(JSON.parse(res.content[0].text).error.code, "APPROVAL_UNAVAILABLE");
    assert.strictEqual(existsSync(join(project, ".env")), false);
  });

  await withServer({ capabilities: { elicitation: { form: {} } } }, null, async (client) => {
    const res = await callWrite(client, { API_TOKEN: SECRET_SENTINEL });
    assert.strictEqual(res.isError, true);
    assert.strictEqual(JSON.parse(res.content[0].text).error.code, "APPROVAL_UNAVAILABLE");
    assert.strictEqual(existsSync(join(project, ".env")), false);
  });

  await withServer(
    { capabilities: { elicitation: { form: {} } } },
    async () => ({ action: "decline" }),
    async (client) => {
      const res = await callWrite(client, { API_TOKEN: SECRET_SENTINEL });
      assert.strictEqual(res.isError, true);
      assert.strictEqual(JSON.parse(res.content[0].text).error.code, "APPROVAL_DECLINED");
      assert.strictEqual(existsSync(join(project, ".env")), false);
    },
  );

  await withServer(
    { capabilities: { elicitation: { form: {} } } },
    async () => ({ action: "accept", content: { approve: false } }),
    async (client) => {
      const res = await callWrite(client, { API_TOKEN: SECRET_SENTINEL });
      assert.strictEqual(res.isError, true);
      assert.strictEqual(JSON.parse(res.content[0].text).error.code, "APPROVAL_DECLINED");
      assert.strictEqual(existsSync(join(project, ".env")), false);
    },
  );

  await writeFile(join(project, ".env"), "KEEP_ME=original\n");
  await withServer(
    { capabilities: { elicitation: { form: {} } } },
    async (request) => {
      assert.match(request.params.message, /API_TOKEN/);
      assert.match(request.params.message, /\.env/);
      assert.ok(!request.params.message.includes(SECRET_SENTINEL));
      return { action: "accept", content: { approve: true } };
    },
    async (client) => {
      const res = await callWrite(client, { API_TOKEN: SECRET_SENTINEL, SECOND: "two" });
      assert.strictEqual(res.isError, undefined);
      const data = JSON.parse(res.content[0].text);
      assert.strictEqual(data.status, "updated");
      assert.deepStrictEqual(data.updatedKeys, ["API_TOKEN", "SECOND"]);
      assert.ok(!JSON.stringify(res).includes(SECRET_SENTINEL));
    },
  );

  const dotenv = await import("dotenv");
  const finalEnv = dotenv.parse(await readFile(join(project, ".env"), "utf8"));
  assert.strictEqual(finalEnv.API_TOKEN, SECRET_SENTINEL);
  assert.strictEqual(finalEnv.KEEP_ME, "original");
  assert.strictEqual((await stat(join(project, ".env"))).mode & 0o777, 0o600);
});

test("analyzeProject skips the configured state directory inside the project", async () => {
  const root = await tempRoot();
  const project = join(root, "proj");
  const stateDir = join(project, "agent-state");
  await mkdir(join(stateDir, "operations"), { recursive: true });
  const config = { projectRoots: [root], stateDir, credentials: {} };
  await writeFile(join(project, "index.ts"), "process.env.VISIBLE_KEY;\n");
  await writeFile(
    join(stateDir, "operations", "op.json"),
    JSON.stringify({ secret: "supabase service key", env: "process.env.STATE_DIR_LEAK" }),
  );
  const analysis = await analyzeProject(project, config);
  assert.ok(analysis.envKeys.includes("VISIBLE_KEY"));
  assert.ok(!analysis.envKeys.includes("STATE_DIR_LEAK"));
  assert.ok(!JSON.stringify(analysis.evidence).includes("op.json"));
});

test("readProjectBytes validates the size limit before reading", async () => {
  const root = await tempRoot();
  const file = join(root, "a.txt");
  await writeFile(file, "data");
  for (const bad of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(() => files.readProjectBytes(root, "a.txt", bad), (e) => errorCode(e) === "INVALID_FILE_PATH");
  }
});

test("lexical and canonical root variants enforce the same symlink policy", async () => {
  const root = await tempRoot();
  const canonicalRoot = await realpath(root);
  const project = join(root, "project");
  await mkdir(project, { recursive: true });
  const canonicalProject = await realpath(project);
  const outside = join(root, "outside.txt");
  await writeFile(outside, "x");
  await symlink(outside, join(project, "linked.txt"));
  const lexicalInside = join(project, "linked.txt");
  await assert.rejects(
    () => files.readProjectFile(canonicalProject, "linked.txt"),
    (e) => errorCode(e) === "UNSAFE_PATH",
  );
  await assert.rejects(
    () => files.resolveProjectPath(join(canonicalProject, "linked.txt"), [root]),
    (e) => errorCode(e) === "INVALID_PROJECT_PATH",
  );
  const resolved = await files.resolveProjectPath(canonicalProject, [root]);
  assert.strictEqual(resolved, canonicalProject);
  assert.strictEqual(lexicalInside.includes(canonicalRoot) || lexicalInside.startsWith(root), true);
});
