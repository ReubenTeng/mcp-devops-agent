import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "./config.js";
import { SERVER_NAME, SERVER_VERSION } from "./metadata.js";
import { registerOperationTools } from "./tools/operations.js";
import { registerProvisionTools } from "./tools/provision.js";
import { registerScanTools } from "./tools/scan.js";
import { registerSecretsTools } from "./tools/secrets.js";

export type { AppConfig } from "./config.js";
export { loadConfig } from "./config.js";

export function createServer(config: AppConfig, deps: { fetch?: typeof fetch } = {}): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerScanTools(server, config);
  registerProvisionTools(server);
  registerSecretsTools(server, config);
  registerOperationTools(server, config, deps);
  return server;
}
