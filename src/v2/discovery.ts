import type { AppConfig } from "../config.js";
import { AppError } from "../errors.js";
import { manifestSchema, type Capability, type Manifest } from "./schema.js";
import type { Registry } from "./registry.js";

/** Discovery is GET-only against explicitly configured official document origins. */
export async function discover(registry: Registry, config: AppConfig, requirements: Capability[], allowNetwork: boolean, fetchImpl: typeof fetch = fetch): Promise<object> {
  const found = [...registry.manifests.values()].filter((m) => requirements.every((c) => m.capabilities.includes(c)));
  const advisory: Manifest[] = []; const errors: { source: string; code: string }[] = [];
  if (allowNetwork) {
    const origins = new Set([...registry.manifests.values()].flatMap((m) => m.documentation.map((u) => new URL(u).origin)));
    const results = await Promise.allSettled((config.discoverySources ?? []).map(async (source) => {
      const url = new URL(source);
      if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash || !origins.has(url.origin)) throw new AppError("UNTRUSTED_DISCOVERY_SOURCE", "Discovery URLs must use an official documentation origin declared by an installed manifest.");
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 15_000);
      try {
        const response = await fetchImpl(url, { method: "GET", redirect: "error", credentials: "omit", referrerPolicy: "no-referrer", signal: controller.signal, headers: { accept: "application/json" } });
        if (!response.ok || !response.body) throw new AppError("DISCOVERY_FAILED", "The official metadata endpoint could not be read.");
        let bytes = 0; const chunks: Buffer[] = [];
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) { controller.abort(); throw new AppError("DISCOVERY_LIMIT", "Discovery metadata exceeded the response limit."); } chunks.push(Buffer.from(chunk)); }
        const parsed = manifestSchema.array().max(64).safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        if (!parsed.success) throw new AppError("INVALID_DISCOVERY", "The metadata endpoint must return declarative provider manifests.");
        return parsed.data.filter((m) => requirements.every((c) => m.capabilities.includes(c))).map((m) => ({ ...m, tier: "advisory" as const, operations: [], teardown: false, credentials: [], accountSettings: [], documentation: [source] }));
      } finally { clearTimeout(timer); }
    }));
    results.forEach((r, i) => r.status === "fulfilled" ? advisory.push(...r.value) : errors.push({ source: config.discoverySources![i]!, code: r.reason instanceof AppError ? r.reason.code : "DISCOVERY_FAILED" }));
  }
  return { providers: [...found, ...advisory], errors, networkAllowed: allowNetwork, networkSources: allowNetwork ? config.discoverySources ?? [] : [], explanation: "Discovered providers are advisory. Executable code is never downloaded or installed automatically." };
}
