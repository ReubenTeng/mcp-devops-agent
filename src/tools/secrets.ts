import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { join } from "node:path";
import { requireApproval } from "../approval.js";
import type { AppConfig } from "../config.js";
import { AppError, toolResult } from "../errors.js";
import { writeEnvSecretsInput } from "../types/index.js";
import { mergeEnvContents, updateEnvSecrets } from "../utils/env.js";
import { readProjectFile, resolveProjectPath } from "../utils/files.js";

export function registerSecretsTools(server: McpServer, config: AppConfig): void {
  server.registerTool(
    "write_env_secrets",
    {
      description:
        "Appends or updates keys in the local project .env after explicit human approval, preserving unrelated keys. Secret values are never returned.",
      inputSchema: writeEnvSecretsInput,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args, extra) =>
      toolResult(async () => {
        const root = await resolveProjectPath(args.projectPath, config.projectRoots);
        const envPath = join(root, ".env");
        const keys = Object.keys(args.secrets).sort();
        if (keys.length === 0) {
          return { status: "no_changes", updatedKeys: [], file: envPath };
        }
        const existing = (await readProjectFile(root, ".env")) ?? "";
        mergeEnvContents(existing, args.secrets);
        await requireApproval(
          server,
          `Update ${envPath} with keys: ${keys.join(", ")}. Existing values for these keys will be replaced; unrelated keys will be preserved. Values will not be returned.`,
          extra.signal,
        );
        if (extra.signal.aborted) {
          throw new AppError("CANCELLED", "The request was cancelled before the write. No changes were made.");
        }
        const updatedKeys = await updateEnvSecrets(root, args.secrets);
        return { status: "updated", updatedKeys, file: envPath };
      }),
  );
}
