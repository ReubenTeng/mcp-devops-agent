import { PRICING_REVIEWED_AT } from "../planning.js";
import { manifestSchema, type Manifest, type Capability } from "./schema.js";

// Catalog entries are discovery leads, not claims of working provisioning or verified pricing.
const catalog: [string, string, Capability[], string, string[]][] = [
  ["github-pages", "GitHub Pages", ["static"], "https://docs.github.com/en/pages", ["GITHUB_TOKEN"]],
  ["netlify", "Netlify", ["static", "serverless"], "https://docs.netlify.com/", ["NETLIFY_AUTH_TOKEN"]],
  ["cloudflare-pages", "Cloudflare Pages", ["static", "edge"], "https://developers.cloudflare.com/pages/", ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]],
  ["cloudflare-workers", "Cloudflare Workers", ["edge", "cron", "websocket"], "https://developers.cloudflare.com/workers/", ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]],
  ["render", "Render", ["static", "server", "container", "worker", "cron", "websocket", "disk", "postgres", "redis"], "https://render.com/docs", ["RENDER_API_KEY", "RENDER_OWNER_ID"]],
  ["railway", "Railway", ["server", "container", "worker", "cron", "websocket", "disk", "postgres", "mysql", "redis"], "https://docs.railway.com/", ["RAILWAY_API_TOKEN"]],
  ["fly", "Fly.io", ["container", "server", "websocket", "disk", "postgres"], "https://fly.io/docs/", ["FLY_API_TOKEN"]],
  ["digitalocean", "DigitalOcean App Platform", ["static", "server", "container", "worker", "postgres", "mysql", "redis"], "https://docs.digitalocean.com/products/app-platform/", ["DIGITALOCEAN_TOKEN"]],
  ["firebase", "Firebase", ["static", "serverless", "document-db", "auth", "storage"], "https://firebase.google.com/docs", ["GOOGLE_APPLICATION_CREDENTIALS"]],
  ["neon", "Neon", ["postgres"], "https://neon.com/docs", ["NEON_API_KEY"]],
  ["cloudflare-data", "Cloudflare D1, KV and R2", ["sqlite", "storage"], "https://developers.cloudflare.com/", ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]],
  ["porkbun", "Porkbun", ["registrar", "dns"], "https://porkbun.com/api/json/v3/documentation", ["PORKBUN_API_KEY", "PORKBUN_SECRET_API_KEY"]],
  ["namecheap", "Namecheap", ["registrar", "dns"], "https://www.namecheap.com/support/api/intro/", ["NAMECHEAP_API_USER", "NAMECHEAP_API_KEY", "NAMECHEAP_CLIENT_IP"]],
  ["gandi", "Gandi", ["registrar", "dns"], "https://api.gandi.net/docs/", ["GANDI_TOKEN"]],
  ["aws", "AWS", ["static", "serverless", "container", "server", "worker", "cron", "network", "postgres", "mysql", "redis", "storage", "dns", "registrar", "websocket", "disk"], "https://docs.aws.amazon.com/", ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION"]],
  ["gcp", "Google Cloud", ["static", "serverless", "container", "server", "worker", "cron", "network", "postgres", "mysql", "redis", "storage", "dns", "websocket", "disk"], "https://cloud.google.com/docs", ["GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT"]],
  ["azure", "Azure", ["static", "serverless", "container", "server", "worker", "cron", "network", "postgres", "mysql", "redis", "storage", "dns", "websocket", "disk"], "https://learn.microsoft.com/azure/", ["ARM_CLIENT_ID", "ARM_CLIENT_SECRET", "ARM_TENANT_ID", "ARM_SUBSCRIPTION_ID"]],
  ["heroku", "Heroku", ["server", "worker", "postgres", "redis"], "https://devcenter.heroku.com/", ["HEROKU_API_KEY"]],
  ["koyeb", "Koyeb", ["container", "server"], "https://www.koyeb.com/docs", ["KOYEB_TOKEN"]],
  ["northflank", "Northflank", ["container", "server", "worker", "postgres", "redis"], "https://northflank.com/docs", ["NORTHFLANK_API_TOKEN"]],
  ["deno", "Deno Deploy", ["edge", "serverless"], "https://docs.deno.com/deploy/", ["DENO_DEPLOY_TOKEN"]],
  ["fastly", "Fastly Compute", ["edge", "static"], "https://www.fastly.com/documentation/", ["FASTLY_API_TOKEN"]],
  ["akamai", "Akamai", ["container", "server", "storage"], "https://techdocs.akamai.com/", ["AKAMAI_TOKEN"]],
  ["planetscale", "PlanetScale", ["mysql", "postgres"], "https://planetscale.com/docs", ["PLANETSCALE_TOKEN"]],
  ["cockroachdb", "CockroachDB", ["postgres"], "https://www.cockroachlabs.com/docs/", ["COCKROACH_API_KEY"]],
  ["mongodb-atlas", "MongoDB Atlas", ["document-db"], "https://www.mongodb.com/docs/atlas/", ["MONGODB_ATLAS_PUBLIC_KEY", "MONGODB_ATLAS_PRIVATE_KEY"]],
  ["upstash", "Upstash", ["redis"], "https://upstash.com/docs", ["UPSTASH_EMAIL", "UPSTASH_API_KEY"]],
  ["redis-cloud", "Redis Cloud", ["redis"], "https://redis.io/docs/latest/operate/rc/", ["REDIS_CLOUD_API_KEY"]],
  ["backblaze", "Backblaze B2", ["storage"], "https://www.backblaze.com/docs", ["B2_APPLICATION_KEY_ID", "B2_APPLICATION_KEY"]],
  ["wasabi", "Wasabi", ["storage"], "https://docs.wasabi.com/", ["WASABI_ACCESS_KEY", "WASABI_SECRET_KEY"]],
  ["dynadot", "Dynadot", ["registrar", "dns"], "https://www.dynadot.com/domain/api", ["DYNADOT_API_KEY"]],
  ["godaddy", "GoDaddy", ["registrar", "dns"], "https://developer.godaddy.com/", ["GODADDY_API_KEY", "GODADDY_API_SECRET"]],
];

export function catalogManifests(): Manifest[] {
  return catalog.map(([id, name, capabilities, documentation, credentials]) => manifestSchema.parse({
    protocolVersion: 2, id, version: "2.0.0", name, tier: "catalog", capabilities,
    runtimes: [], frameworks: [], regions: [], compliance: [], commercialUse: "unverified", reliability: "unverified",
    credentials, accountSettings: [], operations: [], teardown: false, reconciliation: "manual", artifactAccess: false,
    pricing: { monthlyCents: null, upfrontCents: null, reviewedAt: null, source: documentation, assumptions: ["Provider capabilities and commercial terms require adapter validation; price is unknown."] },
    documentation: [documentation], limits: ["Recommendation lead only. Install a validated adapter before preparing mutations."],
  }));
}

export function legacyManifests(): Manifest[] {
  const make = (id: string, capabilities: Capability[], credentials: string[], operations: string[], monthlyCents: number | null, source: string): Manifest => manifestSchema.parse({
    protocolVersion: 2, id, name: id, version: "2.0.0", tier: "executable", capabilities,
    runtimes: ["node", "static"], frameworks: [], regions: [], compliance: [], commercialUse: "allowed", reliability: "production",
    credentials, accountSettings: [], operations, teardown: false, reconciliation: "identity", artifactAccess: id === "vercel",
    pricing: { monthlyCents, upfrontCents: 0, reviewedAt: PRICING_REVIEWED_AT, source, assumptions: ["Baseline only. Actual account plan is checked at prepare; usage, taxes and unrelated spend excluded."] }, documentation: [source], limits: [],
  });
  return [
    make("vercel", ["static", "serverless"], ["VERCEL_TOKEN", "VERCEL_TEAM_ID"], ["create_vercel_project", "deploy_vercel", "sync_env_to_vercel", "connect_vercel_domain", "verify_vercel_domain", "rollback_vercel"], 2000, "https://vercel.com/pricing"),
    make("supabase", ["postgres", "auth", "storage"], ["SUPABASE_ACCESS_TOKEN"], ["create_supabase_project", "sync_supabase_env"], 3500, "https://supabase.com/pricing"),
    make("cloudflare", ["dns", "registrar"], ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"], ["register_domain", "create_cloudflare_zone", "upsert_dns_record"], 0, "https://developers.cloudflare.com/dns/"),
  ];
}
