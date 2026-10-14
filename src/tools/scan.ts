import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parse as parseEnv } from "dotenv";
import ignore from "ignore";
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../config.js";
import { AppError, toolResult } from "../errors.js";
import { analyzeProjectInfraInput, type ProjectAnalysis } from "../types/index.js";
import { readProjectFile, resolveProjectPath } from "../utils/files.js";

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".turbo",
  ".devin",
  ".cursor",
  ".agents",
  ".mcp-devops-agent",
]);
const READABLE_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".vue",
  ".svelte",
  ".prisma",
  ".sql",
  ".json",
  ".html",
]);
const SKIP_READ_NAMES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
]);
const KNOWN_CONFIG_FILES = [
  "vercel.json",
  "supabase/config.toml",
  "wrangler.toml",
  "wrangler.json",
  ".vercel/project.json",
];
const HOSTING_CONFIG_FILES = new Set(["vercel.json", "wrangler.toml", "wrangler.json", ".vercel/project.json"]);
const HOSTING_REQUIREMENTS = new Set(["hosting", "static-hosting", "serverless-functions"]);
const DATABASE_REQUIREMENTS = new Set(["sql", "auth", "storage"]);

const MAX_ENTRIES = 2000;
const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_DEPTH = 12;

const DEPENDENCY_SIGNALS: { dep: string; framework?: string; requirements: string[] }[] = [
  { dep: "next", framework: "nextjs", requirements: ["hosting", "serverless-functions"] },
  { dep: "vite", framework: "vite", requirements: ["hosting"] },
  { dep: "react", framework: "react", requirements: ["hosting"] },
  { dep: "@angular/core", framework: "angular", requirements: ["hosting"] },
  { dep: "astro", framework: "astro", requirements: ["hosting"] },
  { dep: "@sveltejs/kit", framework: "sveltekit", requirements: ["hosting"] },
  { dep: "svelte", framework: "svelte", requirements: ["hosting"] },
  { dep: "nuxt", framework: "nuxt", requirements: ["hosting"] },
  { dep: "express", framework: "express", requirements: ["node-server"] },
  { dep: "fastify", framework: "fastify", requirements: ["node-server"] },
  { dep: "@nestjs/core", framework: "nest", requirements: ["node-server"] },
  { dep: "pg", requirements: ["sql"] },
  { dep: "postgres", requirements: ["sql"] },
  { dep: "mysql", requirements: ["mysql"] },
  { dep: "mysql2", requirements: ["mysql"] },
  { dep: "better-sqlite3", requirements: ["sqlite"] },
  { dep: "sqlite3", requirements: ["sqlite"] },
  { dep: "@libsql/client", requirements: ["sqlite"] },
  { dep: "mongodb", requirements: ["mongodb"] },
  { dep: "mongoose", requirements: ["mongodb"] },
  { dep: "ioredis", requirements: ["redis"] },
  { dep: "redis", requirements: ["redis"] },
  { dep: "@supabase/supabase-js", requirements: ["sql", "auth", "storage"] },
];

const ORM_PACKAGES = new Set(["@prisma/client", "prisma", "drizzle-orm"]);
const ORM_ENGINE_IMPORTS: { pattern: RegExp; requirement: string; signal: string }[] = [
  { pattern: /drizzle-orm\/(?:pg-core|node-postgres|postgres-js|vercel-postgres|neon-http)/, requirement: "sql", signal: "drizzle postgres import" },
  { pattern: /drizzle-orm\/mysql-core/, requirement: "mysql", signal: "drizzle mysql import" },
  { pattern: /drizzle-orm\/sqlite-core/, requirement: "sqlite", signal: "drizzle sqlite import" },
];
const DATABASE_ENGINE_REQUIREMENTS = new Set(["sql", "mysql", "sqlite", "mongodb"]);

const PRISMA_PROVIDERS: Record<string, string> = {
  postgresql: "sql",
  mysql: "mysql",
  sqlite: "sqlite",
  mongodb: "mongodb",
};

const ENV_NAME_RES = [
  /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
  /process\.env\[["']([A-Za-z_][A-Za-z0-9_]*)["']\]/g,
  /import\.meta\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
];

interface ScanEntry {
  rel: string;
  isDir: boolean;
  size: number;
}

function toPosix(rel: string): string {
  return rel.split(path.sep).join("/");
}

function isIgnoredName(name: string): boolean {
  if (IGNORED_DIRS.has(name)) return true;
  if (name.startsWith(".env") && name !== ".env.example") return true;
  return false;
}

export async function analyzeProject(projectPath: string, config: AppConfig): Promise<ProjectAnalysis> {
  const root = await resolveProjectPath(projectPath, config.projectRoots);
  let resolvedStateDir = path.resolve(config.stateDir);
  try {
    resolvedStateDir = await realpath(config.stateDir);
  } catch {}
  const warnings: string[] = [];
  const evidence: ProjectAnalysis["evidence"] = [];
  const envKeys = new Set<string>();
  const requirements = new Set<string>();
  const frameworks = new Set<string>();
  let truncated = false;
  let totalBytes = 0;
  let entryCount = 0;
  let ormDetected = false;

  const entries: ScanEntry[] = [];
  const matchers: { base: string; ig: ReturnType<typeof ignore> }[] = [];

  const ignoredBy = (relPosix: string, isDir: boolean): boolean => {
    let ignored = false;
    for (const matcher of matchers) {
      const rel = path.posix.relative(matcher.base, relPosix);
      if (rel === "" || rel.startsWith("..") || path.posix.isAbsolute(rel)) continue;
      const tested = isDir ? `${rel}/` : rel;
      const result = matcher.ig.test(tested);
      if (result.ignored) ignored = true;
      if (result.unignored) ignored = false;
    }
    return ignored;
  };

  const walk = async (relDir: string, depth: number): Promise<void> => {
    const absDir = relDir === "" ? root : path.join(root, relDir);
    const matcherCount = matchers.length;
    let gitignore: string | undefined;
    try {
      gitignore = await readProjectFile(root, relDir === "" ? ".gitignore" : `${relDir}/.gitignore`, MAX_FILE_BYTES);
    } catch {
      warnings.push("A .gitignore file could not be read; its directory was not fully scanned.");
      truncated = true;
      return;
    }
    if (gitignore !== undefined) {
      try {
        matchers.push({ base: relDir === "" ? "." : toPosix(relDir), ig: ignore().add(gitignore) });
      } catch {
        warnings.push("A .gitignore file could not be parsed; its directory was not fully scanned.");
        truncated = true;
        return;
      }
    }
    let listing;
    try {
      listing = await readdir(absDir, { withFileTypes: true });
    } catch {
      warnings.push("Some directories could not be read; results may be incomplete.");
      truncated = true;
      return;
    }
    listing.sort((a, b) => a.name.localeCompare(b.name));
    for (const item of listing) {
      entryCount += 1;
      if (entryCount > MAX_ENTRIES) {
        truncated = true;
        return;
      }
      if (isIgnoredName(item.name) || item.isSymbolicLink()) continue;
      const rel = relDir === "" ? item.name : `${toPosix(relDir)}/${item.name}`;
      if (ignoredBy(rel, item.isDirectory())) continue;
      if (item.isDirectory()) {
        if (item.name === ".vercel") continue;
        if (path.join(root, toPosix(rel)) === resolvedStateDir || path.join(root, rel) === resolvedStateDir) continue;
        if (depth + 1 > MAX_DEPTH) {
          truncated = true;
          continue;
        }
        entries.push({ rel, isDir: true, size: 0 });
        await walk(rel, depth + 1);
        if (truncated) return;
      } else if (item.isFile()) {
        let size = 0;
        try {
          size = (await lstat(path.join(root, rel))).size;
        } catch {
          continue;
        }
        entries.push({ rel, isDir: false, size });
      }
    }
  };

  await walk("", 0);

  const readLimited = async (rel: string): Promise<string | undefined> => {
    if (totalBytes >= MAX_TOTAL_BYTES) {
      truncated = true;
      return undefined;
    }
    const content = await readProjectFile(root, rel, MAX_FILE_BYTES).catch(() => {
      truncated = true;
      return undefined;
    });
    if (content === undefined) return undefined;
    totalBytes += Buffer.byteLength(content, "utf8");
    return content;
  };

  const fileSet = new Set(entries.filter((entry) => !entry.isDir).map((entry) => entry.rel));

  const existingConfigFiles: string[] = [];
  for (const candidate of KNOWN_CONFIG_FILES) {
    if (fileSet.has(candidate)) {
      existingConfigFiles.push(candidate);
      continue;
    }
    if (candidate.startsWith(".vercel/")) {
      try {
        const dirInfo = await lstat(path.join(root, ".vercel"));
        if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory()) continue;
        const info = await lstat(path.join(root, candidate));
        if (info.isFile() && !info.isSymbolicLink()) existingConfigFiles.push(candidate);
      } catch {}
    }
  }

  let packageManager: ProjectAnalysis["packageManager"] = "unknown";
  if (fileSet.has("pnpm-lock.yaml")) packageManager = "pnpm";
  else if (fileSet.has("yarn.lock")) packageManager = "yarn";
  else if (fileSet.has("bun.lock") || fileSet.has("bun.lockb")) packageManager = "bun";
  else if (fileSet.has("package-lock.json")) packageManager = "npm";

  const packageJsonRaw = fileSet.has("package.json") ? await readLimited("package.json") : undefined;
  if (fileSet.has("package.json") && packageJsonRaw === undefined) {
    throw new AppError("INVALID_PROJECT_CONFIG", "package.json could not be read or exceeds the supported size limit.");
  }
  if (packageJsonRaw !== undefined) {
    let manifest: { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; workspaces?: unknown };
    try {
      manifest = JSON.parse(packageJsonRaw);
    } catch {
      throw new AppError("INVALID_PROJECT_CONFIG", "package.json is not valid JSON.");
    }
    if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
      throw new AppError("INVALID_PROJECT_CONFIG", "package.json is not a valid package manifest.");
    }
    const deps = { ...(manifest.dependencies ?? {}), ...(manifest.devDependencies ?? {}) };
    for (const signal of DEPENDENCY_SIGNALS) {
      if (!Object.hasOwn(deps, signal.dep)) continue;
      if (signal.framework) frameworks.add(signal.framework);
      for (const requirement of signal.requirements) {
        requirements.add(requirement);
        evidence.push({ requirement, file: "package.json", signal: `dependency "${signal.dep}"` });
      }
    }
    for (const orm of ORM_PACKAGES) {
      if (Object.hasOwn(deps, orm)) ormDetected = true;
    }
    if (manifest.workspaces !== undefined) {
      warnings.push("package.json declares workspaces; analysis is scoped to the selected project directory.");
    }
  } else {
    warnings.push("No package.json found; dependency-based detection is unavailable.");
  }

  for (const entry of entries) {
    if (entry.isDir) continue;
    const ext = path.posix.extname(entry.rel);
    const base = path.posix.basename(entry.rel);
    if (base === "index.html") {
      requirements.add("static-hosting");
      evidence.push({ requirement: "static-hosting", file: entry.rel, signal: "index.html file present" });
    }
    if (base === ".env.example") {
      const content = await readLimited(entry.rel);
      if (content !== undefined) {
        for (const key of Object.keys(parseEnv(content))) {
          if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) envKeys.add(key);
        }
      }
      continue;
    }
    if (SKIP_READ_NAMES.has(base) || !READABLE_EXTENSIONS.has(ext)) continue;
    if (entry.rel === "package.json") continue;
    const content = await readLimited(entry.rel);
    if (content === undefined) continue;
    if (ext === ".prisma") {
      ormDetected = true;
      const datasourceRe = /datasource\s+\w+\s*\{[^}]*?provider\s*=\s*"([^"]+)"/gs;
      let providerMatch;
      while ((providerMatch = datasourceRe.exec(content)) !== null) {
        const provider = providerMatch[1] as string;
        const requirement = Object.hasOwn(PRISMA_PROVIDERS, provider) ? PRISMA_PROVIDERS[provider] : undefined;
        if (requirement) {
          requirements.add(requirement);
          evidence.push({
            requirement,
            file: entry.rel,
            signal: `prisma datasource provider "${provider}"`,
          });
        }
      }
    }
    for (const engineImport of ORM_ENGINE_IMPORTS) {
      if (engineImport.pattern.test(content)) {
        requirements.add(engineImport.requirement);
        evidence.push({ requirement: engineImport.requirement, file: entry.rel, signal: engineImport.signal });
      }
    }
    for (const re of ENV_NAME_RES) {
      re.lastIndex = 0;
      let envMatch;
      while ((envMatch = re.exec(content)) !== null) {
        envKeys.add(envMatch[1] as string);
      }
    }
  }

  if (ormDetected && ![...DATABASE_ENGINE_REQUIREMENTS].some((req) => requirements.has(req))) {
    warnings.push(
      "An ORM was detected but the database engine could not be confirmed; verify Postgres, MySQL or SQLite before planning.",
    );
  }

  const missingPrerequisites: string[] = [];
  const hasHostingConfig = existingConfigFiles.some((file) => HOSTING_CONFIG_FILES.has(file));
  if ([...HOSTING_REQUIREMENTS].some((req) => requirements.has(req)) && !hasHostingConfig) {
    missingPrerequisites.push("hosting provider not configured");
  }
  if (requirements.has("sql") && !existingConfigFiles.includes("supabase/config.toml")) {
    missingPrerequisites.push("database provider not configured");
  }

  if (truncated && !warnings.some((warning) => warning.startsWith("Analysis reached scan limits"))) {
    warnings.push("Analysis reached scan limits; results may be incomplete.");
  }

  return {
    projectPath: root,
    frameworks: [...frameworks].sort(),
    stackRequirements: [...requirements].sort(),
    packageManager,
    evidence,
    envKeys: [...envKeys].sort(),
    existingConfigFiles: existingConfigFiles.sort(),
    missingPrerequisites,
    warnings,
    truncated,
  };
}

export function registerScanTools(server: McpServer, config: AppConfig): void {
  server.registerTool(
    "analyze_project_infra",
    {
      description:
        "Analyzes a local project's stack, infrastructure requirements, environment variable names, and existing provider configuration inside allowed roots. Read-only; never executes project code or reads secret values.",
      inputSchema: analyzeProjectInfraInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => toolResult(() => analyzeProject(args.projectPath, config)),
  );
}
