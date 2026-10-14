import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toolResult } from "../errors.js";
import { proposeInfraPlan } from "../planning.js";
import { proposeInfraPlanInput } from "../types/index.js";

export function registerProvisionTools(server: McpServer): void {
  server.registerTool(
    "propose_infra_plan",
    {
      description:
        "Compares infrastructure plan candidates from a reviewed static price catalog against stack requirements and a monthly budget. Estimates are baselines, not billing caps; nothing is provisioned.",
      inputSchema: proposeInfraPlanInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => toolResult(async () => proposeInfraPlan(args)),
  );
}
