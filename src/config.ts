import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { AppError } from "./errors.js";
import { z } from "zod";

const installedAdapterSchema = z.object({
  manifestPath: z.string().refine(isAbsolute), manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  entrypoint: z.string().refine(isAbsolute).optional(), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  credentialNames: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).max(32).default([]),
}).strict().refine((a) => !!a.entrypoint === !!a.sha256);
export type InstalledAdapter = z.infer<typeof installedAdapterSchema>;

export interface AppConfig {
  projectRoots: string[];
  stateDir: string;
  adapters?: InstalledAdapter[];
  providerEnvironment?: Record<string, string>;
  discoverySources?: string[];
  credentials: {
    vercelToken?: string;
    vercelTeamId?: string;
    supabaseToken?: string;
    cloudflareToken?: string;
    cloudflareAccountId?: string;
  };
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): AppConfig {
  let adapters: InstalledAdapter[];
  let discoverySources: string[];
  try {
    adapters = z.array(installedAdapterSchema).max(64).parse(JSON.parse(env.MCP_DEVOPS_ADAPTERS ?? "[]"));
    discoverySources = z.array(z.string().url().refine((v) => { const u = new URL(v); return u.protocol === "https:" && !u.username && !u.password && !u.port && !u.search; })).max(16).parse(JSON.parse(env.MCP_DEVOPS_DISCOVERY_SOURCES ?? "[]"));
  } catch { throw new AppError("INVALID_CONFIG", "Adapter and discovery configuration is invalid; use pinned absolute file paths and HTTPS catalog URLs."); }
  const credentialNames = [...new Set(["GITHUB_TOKEN", "RENDER_API_KEY", "RENDER_OWNER_ID", "RENDER_MCP_HTTP_TOKEN", ...adapters.flatMap((a) => a.credentialNames)])];
  let projectRoots: string[];
  const rootsRaw = env.MCP_DEVOPS_PROJECT_ROOTS;
  if (rootsRaw === undefined) {
    if (!isAbsolute(cwd)) {
      throw new AppError("INVALID_CONFIG", "The default project root is not an absolute path.");
    }
    projectRoots = [cwd];
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rootsRaw);
    } catch {
      throw new AppError("INVALID_CONFIG", "MCP_DEVOPS_PROJECT_ROOTS must be a JSON array of absolute directory paths.");
    }
    if (
      !Array.isArray(parsed) ||
      parsed.length === 0 ||
      parsed.some((entry) => typeof entry !== "string" || entry.length === 0 || !isAbsolute(entry))
    ) {
      throw new AppError("INVALID_CONFIG", "MCP_DEVOPS_PROJECT_ROOTS must be a JSON array of absolute directory paths.");
    }
    projectRoots = parsed as string[];
  }

  const stateDirRaw = env.MCP_DEVOPS_STATE_DIR;
  const stateDir = stateDirRaw === undefined ? join(homedir(), ".local", "state", "mcp-devops-agent") : stateDirRaw;
  if (stateDir.length === 0 || !isAbsolute(stateDir)) {
    throw new AppError("INVALID_CONFIG", "MCP_DEVOPS_STATE_DIR must be an absolute path.");
  }

  return {
    projectRoots,
    stateDir,
    adapters, discoverySources,
    providerEnvironment: Object.fromEntries(credentialNames.filter((k) => env[k]).map((k) => [k, env[k]!])),
    credentials: {
      vercelToken: nonEmpty(env.VERCEL_TOKEN),
      vercelTeamId: nonEmpty(env.VERCEL_TEAM_ID),
      supabaseToken: nonEmpty(env.SUPABASE_ACCESS_TOKEN),
      cloudflareToken: nonEmpty(env.CLOUDFLARE_API_TOKEN),
      cloudflareAccountId: nonEmpty(env.CLOUDFLARE_ACCOUNT_ID),
    },
  };
}
