import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "./config.js";
import { SERVER_NAME, SERVER_VERSION } from "./metadata.js";
import { registerV2Tools } from "./v2/tools.js";
import { registerSecretsTools } from "./tools/secrets.js";
import type { HealthProbe } from "./v2/health.js";

export type { AppConfig } from "./config.js";
export { loadConfig } from "./config.js";

export function createServer(config: AppConfig, deps: { fetch?: typeof fetch; healthProbe?: HealthProbe } = {}): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerV2Tools(server, config, deps);
  registerSecretsTools(server, config);
  return server;
}
