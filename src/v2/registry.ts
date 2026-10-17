import type { AppConfig } from "../config.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AppError } from "../errors.js";
import { catalogManifests, legacyManifests } from "./catalog.js";
import { loadInstalled, credentialsFor, type Adapter } from "./adapter.js";
import { digest, type Manifest } from "./schema.js";
import { readProjectBytes } from "../utils/files.js";
import { githubPagesAdapter, githubPagesManifest } from "./github-pages.js";

export class Registry {
  readonly manifests = new Map<string, Manifest>();
  readonly adapters = new Map<string, Adapter>();
  private readonly bundledChecksums = new Map<string, string>();
  constructor(readonly config: AppConfig, readonly deps: { fetch?: typeof fetch } = {}) {}
  async init(): Promise<this> {
    if (this.manifests.size) return this;
    const manifests = new Map([...catalogManifests(), ...legacyManifests(), githubPagesManifest].map((m) => [m.id, m]));
    const adapters = new Map<string, Adapter>();
    const here = path.dirname(fileURLToPath(import.meta.url));
    const extension = path.extname(fileURLToPath(import.meta.url));
    const code: string[] = [];
    for (const file of ["v2/adapter", "v2/engine", "v2/schema", "v2/native", "v2/github-pages", "operations/service", "operations/store", "operations/types", "providers/http", "providers/vercel", "providers/supabase", "providers/cloudflare", "providers/status", "utils/env", "utils/files", "utils/deployment", "approval"]) {
      const bytes = await readProjectBytes(path.dirname(here), `${file}${extension}`, 2 * 1024 * 1024);
      if (!bytes) throw new AppError("INVALID_INSTALLATION", "A bundled provider module is missing. Reinstall the package.");
      code.push(digest(bytes.toString("utf8")));
    }
    const codeDigest = digest(code);
    for (const id of ["vercel", "supabase", "cloudflare", "github-pages"]) this.bundledChecksums.set(id, digest({ manifest: manifests.get(id), codeDigest }));
    adapters.set("github-pages", githubPagesAdapter(this.config, this.bundledChecksums.get("github-pages")!, this.deps.fetch));
    const installedIds = new Set<string>();
    for (const spec of this.config.adapters ?? []) {
      const { manifest, adapter } = await loadInstalled(spec, this.config);
      if (installedIds.has(manifest.id) || ["vercel", "supabase", "cloudflare", "github-pages"].includes(manifest.id)) throw new AppError("DUPLICATE_ADAPTER", "Installed adapters must have unique IDs and cannot replace bundled executable adapters.");
      installedIds.add(manifest.id); manifests.set(manifest.id, manifest);
      if (adapter) adapters.set(manifest.id, adapter);
    }
    for (const [id, manifest] of manifests) this.manifests.set(id, manifest);
    for (const [id, adapter] of adapters) this.adapters.set(id, adapter);
    return this;
  }
  get(id: string): Manifest {
    const manifest = this.manifests.get(id);
    if (!manifest) throw new AppError("ADAPTER_UNAVAILABLE", "The selected provider is not installed.");
    return manifest;
  }
  checksum(id: string): string { return this.adapters.get(id)?.checksum ?? this.bundledChecksums.get(id) ?? digest(this.get(id)); }
  missing(id: string): string[] {
    const env = credentialsFor(this.config); const m = this.get(id);
    return [...m.credentials, ...m.accountSettings].filter((k) => !env[k]);
  }
  privateValues(): Record<string, string> {
    const env = credentialsFor(this.config);
    return Object.fromEntries([...new Set([...this.manifests.values()].flatMap((m) => m.credentials))].filter((k) => env[k]).map((k) => [k, env[k]!]));
  }
  async validate(id: string, checksum: string): Promise<void> {
    if (this.checksum(id) !== checksum) throw new AppError("ADAPTER_CHANGED", "The plan's adapter version or checksum changed. Restore the recorded adapter version to reconcile uncertain resources; use a fresh plan only for new work.");
    await this.adapters.get(id)?.validate();
  }
}
