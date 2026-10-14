import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import type { AppConfig, InstalledAdapter } from "../config.js";
import { AppError } from "../errors.js";
import { atomicWritePrivate, readProjectBytes } from "../utils/files.js";
import { manifestSchema, type Manifest, type Prepared, type Outcome, type Resource, type DomainQuote } from "./schema.js";

export interface AdapterRequest {
  protocolVersion: 2;
  method: "prepare" | "execute" | "reconcile" | "verify" | "quote" | "search";
  operationId: string;
  operation: string;
  parameters: Record<string, unknown>;
  prepared?: Prepared;
  resources?: Resource[];
  // The protocol intentionally omits projectPath; artifacts require a separate explicit capability.
}
export interface Adapter {
  manifest: Manifest;
  checksum: string;
  invoke(request: AdapterRequest, signal?: AbortSignal): Promise<unknown>;
  validate(): Promise<void>;
}
export type AdapterResponse = Prepared | Outcome | DomainQuote[];
const RESERVED_ENV = /^(?:NODE_|LD_|DYLD_|PATH$|HOME$|SHELL$|TMPDIR$|BASH_|ENV$|UV_|PYTHON)/;
export function credentialsFor(config: AppConfig): Record<string, string> {
  return Object.fromEntries(Object.entries({ ...config.providerEnvironment,
    VERCEL_TOKEN: config.credentials.vercelToken, VERCEL_TEAM_ID: config.credentials.vercelTeamId,
    SUPABASE_ACCESS_TOKEN: config.credentials.supabaseToken,
    CLOUDFLARE_API_TOKEN: config.credentials.cloudflareToken, CLOUDFLARE_ACCOUNT_ID: config.credentials.cloudflareAccountId,
  }).filter((pair): pair is [string, string] => typeof pair[1] === "string" && pair[1].length > 0));
}
export function assertPublic(value: unknown, credentials: Record<string, string>): void {
  const visit = (v: unknown, depth: number): void => {
    if (depth > 16) throw new AppError("UNSAFE_DATA", "Provider data exceeds the nesting limit.");
    if (typeof v === "string") {
      if (Object.values(credentials).some((s) => s.length >= 8 && v.includes(s)) || /-----BEGIN .*PRIVATE KEY-----|\b(?:sk_live_|ghp_|github_pat_)[a-zA-Z0-9_]+/.test(v))
        throw new AppError("UNSAFE_DATA", "Credential material is not permitted in public data.");
    } else if (Array.isArray(v)) v.forEach((x) => visit(x, depth + 1));
    else if (v && typeof v === "object") for (const [key, x] of Object.entries(v)) {
      if (/^(?:__proto__|prototype|constructor|password|secret|token|api_key|apikey|access_token|secretapikey|credentials|env|envVars)$/i.test(key))
        throw new AppError("UNSAFE_DATA", "Use credential setting names or secret references, never values in tool arguments or adapter output.");
      visit(x, depth + 1);
    }
  };
  visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(value)) > 2 * 1024 * 1024) throw new AppError("UNSAFE_DATA", "Public data exceeds the size limit.");
}
export async function pinnedFile(file: string, checksum: string, limit = 2 * 1024 * 1024): Promise<Buffer> {
  const bytes = await readProjectBytes(path.dirname(file), path.basename(file), limit);
  if (!bytes || createHash("sha256").update(bytes).digest("hex") !== checksum)
    throw new AppError("ADAPTER_CHANGED", "A configured adapter or manifest does not match its checksum.");
  return bytes;
}
export async function loadInstalled(spec: InstalledAdapter, config: AppConfig): Promise<{ manifest: Manifest; adapter?: Adapter }> {
  let manifest: Manifest;
  try { manifest = manifestSchema.parse(JSON.parse((await pinnedFile(spec.manifestPath, spec.manifestSha256)).toString("utf8"))); }
  catch (e) { if (e instanceof AppError) throw e; throw new AppError("INVALID_ADAPTER", "The installed adapter manifest is invalid."); }
  if (manifest.tier !== "executable") {
    if (spec.entrypoint || manifest.operations.length) throw new AppError("INVALID_ADAPTER", "A catalog manifest cannot declare executable operations.");
    return { manifest };
  }
  if (!spec.entrypoint || !spec.sha256) throw new AppError("INVALID_ADAPTER", "An executable adapter requires a pinned entrypoint.");
  if (manifest.artifactAccess) throw new AppError("UNSUPPORTED_CAPABILITY", "External adapter artifact access is not enabled. Use an immutable remote source reference.");
  const declared = [...manifest.credentials, ...manifest.accountSettings];
  if (declared.some((name) => RESERVED_ENV.test(name) || !spec.credentialNames.includes(name)))
    throw new AppError("INVALID_ADAPTER", "Adapter environment settings must be explicitly allowed and cannot alter the process runtime.");
  const validate = async () => {
    await pinnedFile(spec.manifestPath, spec.manifestSha256);
    await pinnedFile(spec.entrypoint!, spec.sha256!, 4 * 1024 * 1024);
  };
  await validate();
  const adapter: Adapter = {
    manifest, checksum: createHash("sha256").update(`${spec.manifestSha256}:${spec.sha256}`).digest("hex"), validate,
    async invoke(request, signal) {
      await validate();
      if (signal?.aborted) throw new AppError("CANCELLED", "The request was cancelled.");
      const all = credentialsFor(config);
      const environment = Object.fromEntries(declared.filter((k) => all[k]).map((k) => [k, all[k]!]));
      if (manifest.credentials.some((k) => !environment[k])) throw new AppError("MISSING_CREDENTIAL", "Configure the adapter's declared credentials before calling it.");
      assertPublic(request, all);
      const work = await mkdtemp(path.join(tmpdir(), "mcp-adapter-"));
      try {
        // A standalone bundle is copied to the isolated working directory. No project files are copied.
        const code = await pinnedFile(spec.entrypoint!, spec.sha256!, 4 * 1024 * 1024);
        const entry = path.join(work, "adapter.mjs");
        await atomicWritePrivate(entry, code.toString("utf8"));
        const raw = await new Promise<string>((resolve, reject) => {
          const child = spawn(process.execPath, [entry], { cwd: work, env: environment, stdio: ["pipe", "pipe", "pipe"], shell: false });
          let output = ""; let bytes = 0; let failed = false;
          const fail = (code: string) => { if (!failed) { failed = true; child.kill("SIGKILL"); reject(new AppError(code, "Adapter execution could not be completed safely; inspect the recorded operation before retrying.")); } };
          const timer = setTimeout(() => fail("ADAPTER_TIMEOUT"), 60_000);
          const abort = () => fail("CANCELLED"); signal?.addEventListener("abort", abort, { once: true });
          child.stdout.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) fail("ADAPTER_OUTPUT_LIMIT"); else output += chunk.toString("utf8"); });
          // Never forward provider or adapter stderr, including failed-command error objects.
          child.stderr.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) fail("ADAPTER_OUTPUT_LIMIT"); });
          child.on("error", () => fail("ADAPTER_FAILED"));
          child.stdin.on("error", () => fail("ADAPTER_FAILED"));
          child.on("close", (status) => { clearTimeout(timer); signal?.removeEventListener("abort", abort); if (failed) return; if (status !== 0) fail("ADAPTER_FAILED"); else resolve(output); });
          child.stdin.end(`${JSON.stringify(request)}\n`);
        });
        let response: unknown;
        try { response = JSON.parse(raw); } catch { throw new AppError("INVALID_ADAPTER_RESPONSE", "Adapter returned invalid JSON."); }
        assertPublic(response, all);
        return response;
      } finally { await rm(work, { recursive: true, force: true }); }
    },
  };
  return { manifest, adapter };
}

/** A standalone adapter can implement this request/response contract without importing server internals. */
export const adapterProtocolVersion = 2 as const;
