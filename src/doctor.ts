import { constants } from "node:fs";
import * as fsp from "node:fs/promises";
import path from "node:path";
import { loadConfig, type AppConfig } from "./config.js";
import { AppError } from "./errors.js";
import { SERVER_NAME, SERVER_VERSION } from "./metadata.js";
import { resolveProjectPath } from "./utils/files.js";

export interface DoctorReport {
  name: string;
  version: string;
  runtime: { node: string; platform: string; supported: boolean };
  configuration: {
    valid: boolean;
    projectRoots: Array<{ path: string; status: "ok" | "unavailable" }>;
    stateDirectory?: { path: string; status: "private" | "will_create" | "unsafe" };
  };
  providers: Array<{
    provider: "vercel" | "supabase" | "cloudflare";
    configured: boolean;
    missingSettings: string[];
    connectionVerified: false;
  }>;
  readyForLocalTools: boolean;
  readyForLiveChecks: boolean;
  approvalSupport: "must_be_verified_in_client";
  networkAccessed: false;
  filesChanged: false;
  errors: Array<{ code: string; message: string }>;
  warnings: string[];
}

const REQUIRED_SETTINGS: Array<{ provider: "vercel" | "supabase" | "cloudflare"; names: string[] }> = [
  { provider: "vercel", names: ["VERCEL_TOKEN", "VERCEL_TEAM_ID"] },
  { provider: "supabase", names: ["SUPABASE_ACCESS_TOKEN"] },
  { provider: "cloudflare", names: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"] },
];

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as NodeJS.ErrnoException).code === "ENOENT";
}

async function optionalStat(target: string): Promise<import("node:fs").Stats | undefined> {
  try {
    return await fsp.lstat(target);
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw new AppError("STATE_DIR_UNUSABLE", "The state directory or its ancestors cannot be inspected.");
  }
}

function isContained(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function modeIsPrivate(mode: number): boolean {
  return (mode & 0o077) === 0;
}

function ownedByCurrentUser(info: { uid: number }): boolean {
  return typeof process.getuid !== "function" || info.uid === process.getuid();
}

async function deepestExistingAncestor(candidate: string): Promise<string | undefined> {
  let current = candidate;
  for (;;) {
    const info = await optionalStat(current);
    if (info) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function finalDirIsSafe(info: import("node:fs").Stats): boolean {
  return !info.isSymbolicLink() && info.isDirectory() && ownedByCurrentUser(info) && modeIsPrivate(info.mode);
}

async function inspectStateDir(stateDir: string, errors: DoctorReport["errors"]): Promise<"private" | "will_create" | "unsafe"> {
  const info = await optionalStat(stateDir);
  if (info === undefined) {
    const ancestor = await deepestExistingAncestor(path.dirname(stateDir));
    if (ancestor === undefined) {
      errors.push({ code: "STATE_DIR_UNUSABLE", message: "No existing directory ancestor was found for the state directory." });
      return "unsafe";
    }
    const canonicalAncestor = await fsp.realpath(ancestor).catch(() => undefined);
    const canonicalInfo = canonicalAncestor !== undefined ? await optionalStat(canonicalAncestor) : undefined;
    if (!canonicalInfo || !canonicalInfo.isDirectory()) {
      errors.push({ code: "STATE_DIR_UNUSABLE", message: "The existing ancestor of the state directory is not a usable directory." });
      return "unsafe";
    }
    try {
      await fsp.access(canonicalAncestor as string, constants.W_OK | constants.X_OK);
    } catch {
      errors.push({ code: "STATE_DIR_UNUSABLE", message: "The state directory's ancestor is not writable by this user." });
      return "unsafe";
    }
    return "will_create";
  }
  if (!finalDirIsSafe(info)) {
    errors.push({
      code: "UNSAFE_STATE_DIR",
      message: "The state directory must be a real directory owned by this user with no group or world permissions.",
    });
    return "unsafe";
  }
  try {
    await fsp.access(stateDir, constants.R_OK | constants.W_OK | constants.X_OK);
  } catch {
    errors.push({ code: "STATE_DIR_UNUSABLE", message: "The state directory is not readable and writable by this user." });
    return "unsafe";
  }
  const operationsInfo = await optionalStat(path.join(stateDir, "operations"));
  if (operationsInfo !== undefined) {
    if (!finalDirIsSafe(operationsInfo)) {
      errors.push({
        code: "UNSAFE_STATE_DIR",
        message: "The operations state directory must be a real directory owned by this user with no group or world permissions.",
      });
      return "unsafe";
    }
    try {
      await fsp.access(path.join(stateDir, "operations"), constants.R_OK | constants.W_OK | constants.X_OK);
    } catch {
      errors.push({ code: "STATE_DIR_UNUSABLE", message: "The operations state directory is not readable and writable by this user." });
      return "unsafe";
    }
  }
  return "private";
}

export async function buildDoctorReport(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): Promise<DoctorReport> {
  const errors: DoctorReport["errors"] = [];
  const warnings: string[] = [];
  const report: DoctorReport = {
    name: SERVER_NAME,
    version: SERVER_VERSION,
    runtime: {
      node: process.version,
      platform: process.platform,
      supported: Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10) >= 20,
    },
    configuration: { valid: false, projectRoots: [] },
    providers: [],
    readyForLocalTools: false,
    readyForLiveChecks: false,
    approvalSupport: "must_be_verified_in_client",
    networkAccessed: false,
    filesChanged: false,
    errors,
    warnings,
  };

  if (!report.runtime.supported) {
    errors.push({ code: "UNSUPPORTED_NODE", message: "Node.js 20 or later is required." });
  }
  if (process.platform === "win32") {
    warnings.push("POSIX permission checks cannot be fully validated on Windows.");
  }

  let config: AppConfig | undefined;
  try {
    config = loadConfig(env, cwd);
    report.configuration.valid = true;
  } catch (err) {
    if (err instanceof AppError) {
      errors.push({ code: err.code, message: err.message });
    } else {
      errors.push({ code: "INVALID_CONFIG", message: "The local configuration could not be loaded." });
    }
  }

  let rootsHealthy = true;
  let stateHealthy = true;
  if (config) {
    for (const root of config.projectRoots) {
      try {
        const resolved = await resolveProjectPath(root, [root]);
        await fsp.access(resolved, constants.R_OK | constants.X_OK);
        report.configuration.projectRoots.push({ path: resolved, status: "ok" });
      } catch (err) {
        rootsHealthy = false;
        report.configuration.projectRoots.push({ path: root, status: "unavailable" });
        errors.push({
          code: err instanceof AppError ? err.code : "INVALID_PROJECT_PATH",
          message: err instanceof AppError ? err.message : "A configured project root is not accessible.",
        });
      }
    }

    let canonicalState: string | undefined;
    let stateStatus: "private" | "will_create" | "unsafe" = "unsafe";
    try {
      stateStatus = await inspectStateDir(config.stateDir, errors);
      try {
        canonicalState = await fsp.realpath(config.stateDir);
      } catch (err) {
        if (isEnoent(err)) {
          const ancestor = await deepestExistingAncestor(path.dirname(config.stateDir));
          if (ancestor !== undefined) {
            const canonicalAncestor = await fsp.realpath(ancestor).catch(() => undefined);
            if (canonicalAncestor !== undefined) {
              canonicalState = path.join(canonicalAncestor, path.relative(ancestor, config.stateDir));
            }
          }
        }
      }
    } catch (err) {
      if (err instanceof AppError) {
        errors.push({ code: err.code, message: err.message });
      } else {
        errors.push({ code: "STATE_DIR_UNUSABLE", message: "The state directory could not be inspected." });
      }
      stateStatus = "unsafe";
    }
    if (stateStatus === "unsafe") stateHealthy = false;
    report.configuration.stateDirectory = { path: config.stateDir, status: stateStatus };

    const compareState = canonicalState ?? config.stateDir;
    for (const root of config.projectRoots) {
      const canonicalRoot = await fsp.realpath(root).catch(() => root);
      if (compareState === canonicalRoot || config.stateDir === root) {
        errors.push({ code: "UNSAFE_STATE_DIR", message: "The state directory must not equal a project root." });
        stateHealthy = false;
      } else if (isContained(canonicalRoot, compareState) || isContained(root, config.stateDir)) {
        warnings.push("Keep the state directory outside each project you deploy.");
      }
    }
  }

  for (const requirement of REQUIRED_SETTINGS) {
    const missingSettings = requirement.names.filter((name) => env[name] === undefined || env[name] === "");
    report.providers.push({
      provider: requirement.provider,
      configured: missingSettings.length === 0,
      missingSettings,
      connectionVerified: false,
    });
  }
  const missingNames = report.providers.flatMap((provider) => provider.missingSettings);
  if (missingNames.length > 0) {
    warnings.push(`Missing provider credentials: ${missingNames.join(", ")}. Remote mutations stay unavailable until they are configured.`);
  }
  if (report.providers.every((provider) => provider.configured)) {
    warnings.push("Credentials are detected by presence only; their validity is not verified offline.");
  }

  report.readyForLocalTools =
    report.runtime.supported && report.configuration.valid && rootsHealthy && stateHealthy && errors.length === 0;
  report.readyForLiveChecks = report.readyForLocalTools && report.providers.every((provider) => provider.configured);
  return report;
}
