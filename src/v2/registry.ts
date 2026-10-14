import type { AppConfig } from "../config.js";
import { AppError } from "../errors.js";
import { catalogManifests, legacyManifests } from "./catalog.js";
import { loadInstalled, credentialsFor, type Adapter } from "./adapter.js";
import { digest, type Manifest } from "./schema.js";

export class Registry {
  readonly manifests = new Map<string, Manifest>();
  readonly adapters = new Map<string, Adapter>();
  constructor(readonly config: AppConfig) {}
  async init(): Promise<this> {
    if (this.manifests.size) return this;
    const manifests = new Map([...catalogManifests(), ...legacyManifests()].map((m) => [m.id, m]));
    const installedIds = new Set<string>();
    for (const spec of this.config.adapters ?? []) {
      const { manifest, adapter } = await loadInstalled(spec, this.config);
      if (installedIds.has(manifest.id) || ["vercel", "supabase", "cloudflare"].includes(manifest.id)) throw new AppError("DUPLICATE_ADAPTER", "Installed adapters must have unique IDs and cannot replace bundled executable adapters.");
      installedIds.add(manifest.id); manifests.set(manifest.id, manifest);
      if (adapter) this.adapters.set(manifest.id, adapter);
    }
    for (const [id, manifest] of manifests) this.manifests.set(id, manifest);
    return this;
  }
  get(id: string): Manifest {
    const manifest = this.manifests.get(id);
    if (!manifest) throw new AppError("ADAPTER_UNAVAILABLE", "The selected provider is not installed.");
    return manifest;
  }
  checksum(id: string): string { return this.adapters.get(id)?.checksum ?? digest(this.get(id)); }
  missing(id: string): string[] {
    const env = credentialsFor(this.config); const m = this.get(id);
    return [...m.credentials, ...m.accountSettings].filter((k) => !env[k]);
  }
  async validate(id: string, checksum: string): Promise<void> {
    if (this.checksum(id) !== checksum) throw new AppError("ADAPTER_CHANGED", "The plan's adapter version or checksum changed; propose a new plan.");
    await this.adapters.get(id)?.validate();
  }
}
