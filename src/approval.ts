import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AppError } from "./errors.js";

const APPROVAL_TIMEOUT_MS = 120_000;

export async function requireApproval(server: McpServer, message: string, signal?: AbortSignal): Promise<void> {
  if (!server.server.getClientCapabilities()?.elicitation?.form) {
    throw new AppError(
      "APPROVAL_UNAVAILABLE",
      "This action requires an MCP client with form elicitation support. No changes were made.",
    );
  }
  if (signal?.aborted) {
    throw new AppError("CANCELLED", "The request was cancelled before approval. No changes were made.");
  }
  let result;
  try {
    result = await server.server.elicitInput(
      {
        mode: "form",
        message,
        requestedSchema: {
          type: "object",
          properties: {
            approve: { type: "boolean", title: "Approve this exact operation", default: false },
          },
          required: ["approve"],
        },
      },
      { timeout: APPROVAL_TIMEOUT_MS, signal },
    );
  } catch (err) {
    if (signal?.aborted) {
      throw new AppError("CANCELLED", "The request was cancelled before approval. No changes were made.");
    }
    throw new AppError(
      "APPROVAL_UNAVAILABLE",
      "The approval prompt could not be completed. No changes were made.",
    );
  }
  if (signal?.aborted) {
    throw new AppError("CANCELLED", "The request was cancelled before the change started. No changes were made.");
  }
  if (result.action !== "accept" || result.content?.approve !== true) {
    throw new AppError("APPROVAL_DECLINED", "The operation was not approved. No changes were made.");
  }
}
