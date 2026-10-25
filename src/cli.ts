import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { config as loadDotenv } from "dotenv";
import { loadConfig } from "./config.js";
import { buildDoctorReport, type DoctorReport } from "./doctor.js";
import { SERVER_NAME, SERVER_VERSION } from "./metadata.js";
import { createServer } from "./server.js";
import { createHttpService, loadHttpConfig } from "./http.js";
import { AppError } from "./errors.js";

const HELP = `${SERVER_NAME} ${SERVER_VERSION}

Usage:
  mcp-devops-agent              Start the MCP server on stdio (default).
  mcp-devops-agent serve        Start the MCP server on stdio.
  mcp-devops-agent serve-http   Start the MCP HTTP service for one operator.
  mcp-devops-agent doctor       Run offline local diagnostics (no API calls).
  mcp-devops-agent doctor --json
  mcp-devops-agent --help, -h   Show this help.
  mcp-devops-agent --version, -v

Stdio is the default. HTTP mode requires private bearer authentication.
Environment:
  MCP_DEVOPS_HTTP_TOKEN     Private random base64url token (at least 32 bytes).
  MCP_DEVOPS_HTTP_PUBLIC_URL
                          Public HTTPS URL ending in /mcp.
  MCP_DEVOPS_HTTP_HOST      Bind address (default: 127.0.0.1).
  PORT                    HTTP port (default: 3000).
  MCP_DEVOPS_PROJECT_ROOTS  JSON array of absolute project directories the
                            server may access. Defaults to the working directory.
  MCP_DEVOPS_STATE_DIR      Private state directory (default:
                            ~/.local/state/mcp-devops-agent).
  MCP_DEVOPS_ADAPTERS       JSON array of explicitly installed manifest/entrypoint
                            paths with SHA-256 pins and allowed credential names.
  MCP_DEVOPS_DISCOVERY_SOURCES
                          Optional official JSON manifest catalog URLs; used
                          only when a tool explicitly enables network discovery.
  VERCEL_TOKEN, VERCEL_TEAM_ID
  SUPABASE_ACCESS_TOKEN
  CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID
  GITHUB_TOKEN             GitHub Pages for eligible public repositories.
  RENDER_API_KEY, RENDER_OWNER_ID, RENDER_MCP_HTTP_TOKEN
                          Render account and private token for the hosted MCP service.
                          Provider credentials are loaded from the process
                          environment or the server working directory .env;
                          never pass them as arguments.
Cloud mutations and local .env writes require an MCP client that supports form
elicitation. There is no flag or boolean approval bypass.
The doctor command is fully offline: it validates the runtime, configuration
paths, and credential presence only. It makes no provider API calls and writes
no files.
`;

function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push(`${report.name} ${report.version}`);
  lines.push(`Node: ${report.runtime.node} (${report.runtime.platform})${report.runtime.supported ? "" : " - unsupported, Node 20+ required"}`);
  lines.push(`Configuration: ${report.configuration.valid ? "valid" : "invalid"}`);
  for (const root of report.configuration.projectRoots) {
    lines.push(`Project root: ${root.path} [${root.status}]`);
  }
  if (report.configuration.stateDirectory) {
    lines.push(`State directory: ${report.configuration.stateDirectory.path} [${report.configuration.stateDirectory.status}]`);
  }
  for (const provider of report.providers) {
    const detail = provider.configured ? "configured" : `missing: ${provider.missingSettings.join(", ")}`;
    lines.push(`Provider ${provider.provider}: ${detail} (connection not verified offline)`);
  }
  lines.push(`Provider github-pages: ${report.adapters.githubPagesConfigured ? "configured" : "missing GITHUB_TOKEN"} (repository access verified during prepare)`);
  lines.push(`Approval support: ${report.approvalSupport}`);
  for (const warning of report.warnings) {
    lines.push(`Warning: ${warning}`);
  }
  for (const error of report.errors) {
    lines.push(`Error [${error.code}]: ${error.message}`);
  }
  lines.push(`Ready for local tools: ${report.readyForLocalTools ? "yes" : "no"}`);
  lines.push(`Ready for live checks: ${report.readyForLiveChecks ? "yes" : "no"}`);
  lines.push(`Network accessed: ${report.networkAccessed ? "yes" : "no"}`);
  lines.push(`Files changed: ${report.filesChanged ? "yes" : "no"}`);
  return `${lines.join("\n")}\n`;
}

export async function runCli(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    process.stdout.write(HELP);
    return;
  }
  if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) {
    process.stdout.write(`${SERVER_NAME} ${SERVER_VERSION}\n`);
    return;
  }
  if (args.length === 1 && args[0] === "doctor") {
    loadDotenv({ quiet: true });
    const report = await buildDoctorReport(process.env, process.cwd());
    process.stdout.write(formatDoctorReport(report));
    if (!report.readyForLocalTools) {
      process.exitCode = 1;
    }
    return;
  }
  if (args.length === 2 && args[0] === "doctor" && args[1] === "--json") {
    loadDotenv({ quiet: true });
    const report = await buildDoctorReport(process.env, process.cwd());
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.readyForLocalTools) {
      process.exitCode = 1;
    }
    return;
  }
  if (args.length === 0 || (args.length === 1 && args[0] === "serve")) {
    loadDotenv({ quiet: true });
    const appConfig = loadConfig();
    const server = createServer(appConfig);
    await server.connect(new StdioServerTransport());
    return;
  }
  if (args.length === 1 && args[0] === "serve-http") {
    loadDotenv({ quiet: true });
    const httpConfig = loadHttpConfig();
    const report = await buildDoctorReport(process.env, process.cwd());
    if (!report.readyForLocalTools) {
      throw new AppError("HTTP_NOT_READY", "HTTP startup requires valid project roots and a private, accessible state directory. Run doctor.");
    }
    const service = createHttpService(loadConfig(), httpConfig);
    await service.listen();
    const shutdown = () => {
      void service.close().catch(() => {
        process.stderr.write("HTTP shutdown failed. Reconcile interrupted operations before retrying.\n");
        process.exitCode = 1;
      });
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
    process.stderr.write("MCP HTTP service started.\n");
    return;
  }
  process.stderr.write("Unknown command or option. Run mcp-devops-agent --help.\n");
  process.exitCode = 2;
}
