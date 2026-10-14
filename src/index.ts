#!/usr/bin/env node
import { runCli } from "./cli.js";
import { AppError } from "./errors.js";

runCli().catch((error: unknown) => {
  console.error(error instanceof AppError ? `${error.code}: ${error.message}` : "Failed to run mcp-devops-agent.");
  process.exitCode = 1;
});
