import { lookup } from "node:dns/promises";
import { request } from "node:https";

export interface HealthResult { status: "passed" | "failed" | "unverified"; detail: string }
export type HealthProbe = (url: string) => Promise<HealthResult>;
function publicIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b, c] = octets as [number, number, number, number];
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0 || b === 2) || a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
}
/** Resolve once, reject private networks, pin the connection, verify TLS, never redirect. */
export const probeHttps: HealthProbe = async (input) => {
  let url: URL;
  try { url = new URL(input); } catch { return { status: "unverified", detail: "No valid HTTPS application URL is available." }; }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash) return { status: "unverified", detail: "Health probes require a plain public HTTPS URL." };
  const timeout = new Promise<undefined>((resolve) => { const timer = setTimeout(() => resolve(undefined), 5_000); timer.unref(); });
  const addresses = await Promise.race([lookup(url.hostname, { family: 4, all: true }).catch(() => undefined), timeout]);
  if (!addresses?.length || addresses.some((a) => !publicIpv4(a.address))) return { status: "unverified", detail: "The application URL did not resolve exclusively to supported public addresses." };
  return new Promise<HealthResult>((resolve) => {
    let settled = false;
    const finish = (status: HealthResult["status"], detail: string) => { if (!settled) { settled = true; resolve({ status, detail }); } };
    const req = request({ hostname: url.hostname, servername: url.hostname, path: url.pathname, port: 443, method: "GET", family: 4, agent: false, lookup: (_host, options, callback) => options.all ? callback(null, [{ address: addresses[0]!.address, family: 4 }]) : callback(null, addresses[0]!.address, 4), headers: { accept: "text/html,application/json", "user-agent": "mcp-devops-agent/2 health-probe" } }, (response) => {
      let bytes = 0;
      response.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 64 * 1024) { finish("unverified", "The health response exceeded the supported size limit."); req.destroy(); } });
      response.on("error", () => finish("unverified", "The HTTPS health response could not be completed."));
      response.on("end", () => { const status = response.statusCode ?? 0; finish(status >= 200 && status < 300 ? "passed" : status >= 400 ? "failed" : "unverified", `Application HTTPS endpoint returned status ${status}. Response contents are not returned.`); });
    });
    const timer = setTimeout(() => { finish("unverified", "The HTTPS health probe timed out."); req.destroy(); }, 5_000);
    req.on("close", () => clearTimeout(timer));
    req.on("error", () => finish("unverified", "The HTTPS health probe could not establish a verified public connection."));
    req.end();
  });
};
