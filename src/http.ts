import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "./config.js";
import { AppError } from "./errors.js";
import { createServer } from "./server.js";

export interface HttpConfig {
  host: string;
  port: number;
  publicUrl: string;
  token: string;
}

export function loadHttpConfig(env: NodeJS.ProcessEnv = process.env): HttpConfig {
  const token = env.MCP_DEVOPS_HTTP_TOKEN ?? "";
  if (!/^[A-Za-z0-9_-]{43,256}$/.test(token)) {
    throw new AppError("INVALID_CONFIG", "MCP_DEVOPS_HTTP_TOKEN must be a private base64url token generated from at least 32 random bytes.");
  }
  let url: URL;
  try {
    url = new URL(env.MCP_DEVOPS_HTTP_PUBLIC_URL ?? (env.RENDER_EXTERNAL_URL ? `${env.RENDER_EXTERNAL_URL}/mcp` : ""));
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
        url.username || url.password || url.pathname !== "/mcp" || url.search || url.hash) throw new Error();
  } catch {
    throw new AppError("INVALID_CONFIG", "MCP_DEVOPS_HTTP_PUBLIC_URL must be an HTTPS URL ending in /mcp, without credentials, query or fragment. HTTP is allowed only for loopback tests.");
  }
  const port = env.PORT ?? "3000";
  const host = env.MCP_DEVOPS_HTTP_HOST ?? "127.0.0.1";
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535 ||
      !["127.0.0.1", "0.0.0.0", "::1", "::"].includes(host)) {
    throw new AppError("INVALID_CONFIG", "PORT must be between 1 and 65535. MCP_DEVOPS_HTTP_HOST must be a loopback or wildcard IP address.");
  }
  return { host, port: Number(port), publicUrl: url.href, token };
}

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_REQUESTS = 64;
const MAX_SESSIONS = 8;
const SESSION_IDLE_MS = 15 * 60_000;
const BODY_TIMEOUT_MS = 10_000;

function reply(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) { res.destroy(); return; }
  // Close rejected requests instead of leaving an unread body on a reusable socket.
  res.writeHead(status, { "Content-Type": "application/json", "Connection": "close" });
  res.end(JSON.stringify({ error: message }));
}

class RequestError extends Error {
  constructor(readonly status: number, readonly safeMessage: string) { super(safeMessage); }
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks: Buffer[] = [];
    const finish = (error?: RequestError) => {
      clearTimeout(timer);
      req.off("data", data);
      req.off("end", end);
      req.off("error", failed);
      req.off("aborted", failed);
      if (error) { req.pause(); reject(error); }
    };
    const data = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) finish(new RequestError(413, "Request body is too large."));
      else chunks.push(chunk);
    };
    const end = () => {
      finish();
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new RequestError(400, "Invalid JSON request.")); }
    };
    const failed = () => finish(new RequestError(400, "Request body was interrupted."));
    const timer = setTimeout(() => finish(new RequestError(408, "Request body timed out.")), BODY_TIMEOUT_MS);
    req.on("data", data);
    req.once("end", end);
    req.once("error", failed);
    req.once("aborted", failed);
  });
}

interface Session {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  touchedAt: number;
}

/** One operator, one process, shared allowed roots and private durable state. */
export function createHttpService(config: AppConfig, httpConfig: HttpConfig, options: {
  serverFactory?: () => McpServer;
  // Injectable clock permits idle-expiry tests without long waits.
  now?: () => number;
} = {}) {
  const publicUrl = new URL(httpConfig.publicUrl);
  const tokenHash = createHash("sha256").update(`Bearer ${httpConfig.token}`).digest();
  const now = options.now ?? Date.now;
  const sessions = new Set<Session>();
  const byId = new Map<string, Session>();
  let requests = 0;
  let stopping = false;
  let closePromise: Promise<void> | undefined;

  function forget(session: Session): void {
    sessions.delete(session);
    if (session.transport.sessionId) byId.delete(session.transport.sessionId);
  }
  async function dispose(session: Session): Promise<void> {
    forget(session);
    await session.server.close();
  }
  function sweep(): void {
    for (const session of sessions) if (now() - session.touchedAt >= SESSION_IDLE_MS) {
      void dispose(session).catch(() => {});
    }
  }
  const sweepTimer = setInterval(sweep, 30_000);
  sweepTimer.unref();

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (stopping) { reply(res, 503, "Service is stopping."); return; }
    // Health is public and contains no configuration or provider details.
    if (req.url === "/healthz" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"status":"ok"}');
      return;
    }
    if (req.headers.host !== publicUrl.host ||
        (req.headers.origin !== undefined && req.headers.origin !== publicUrl.origin)) {
      reply(res, 403, "Host or origin is not allowed."); return;
    }
    if (req.url !== "/mcp") { reply(res, 404, "Endpoint not found."); return; }
    const auth = req.headers.authorization ?? "";
    if (!timingSafeEqual(tokenHash, createHash("sha256").update(auth).digest())) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="mcp-devops-agent"');
      reply(res, 401, "Authentication is required."); return;
    }
    if (!["POST", "GET", "DELETE"].includes(req.method ?? "")) {
      res.setHeader("Allow", "POST, GET, DELETE");
      reply(res, 405, "Method is not allowed."); return;
    }
    if (requests >= MAX_REQUESTS) { reply(res, 429, "Too many active requests."); return; }
    requests++;
    let released = false;
    const release = () => { if (!released) { released = true; requests--; } };
    res.once("finish", release);
    res.once("close", release);
    sweep();

    let body: unknown;
    if (req.method === "POST") {
      if (req.headers["content-encoding"] !== undefined ||
          req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
        reply(res, 415, "Use uncompressed application/json requests."); return;
      }
      const length = req.headers["content-length"];
      if (length !== undefined && Number(length) > MAX_BODY_BYTES) {
        reply(res, 413, "Request body is too large."); return;
      }
      body = await readBody(req);
    }
    if (stopping) { reply(res, 503, "Service is stopping."); return; }
    const id = req.headers["mcp-session-id"];
    let session: Session;
    if (id !== undefined) {
      const found = typeof id === "string" ? byId.get(id) : undefined;
      if (!found) { reply(res, 404, "Session not found. Initialize a new session."); return; }
      session = found;
    } else {
      if (req.method !== "POST" || !isInitializeRequest(body)) {
        reply(res, 400, "Initialize a session first."); return;
      }
      if (sessions.size >= MAX_SESSIONS) { reply(res, 429, "Too many sessions."); return; }
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        maxRequestBodySize: MAX_BODY_BYTES,
        onsessioninitialized: (sessionId) => { byId.set(sessionId, session); },
      });
      const server = options.serverFactory?.() ?? createServer(config);
      session = { server, transport, touchedAt: now() };
      // Reserve the slot before any asynchronous initialization.
      sessions.add(session);
      try { await server.connect(transport); }
      catch { await dispose(session); throw new RequestError(500, "Session initialization failed."); }
      const onclose = transport.onclose;
      transport.onclose = () => { forget(session); onclose?.(); };
      if (stopping) { await dispose(session); reply(res, 503, "Service is stopping."); return; }
    }
    session.touchedAt = now();
    // An interrupted tool response must not leave an approval prompt actionable.
    res.once("close", () => {
      if (req.method === "POST" && !res.writableEnded) void dispose(session).catch(() => {});
    });
    try {
      await session.transport.handleRequest(req, res, body);
    } finally {
      if (!session.transport.sessionId) await dispose(session);
    }
  }

  const httpServer = createHttpServer({ maxHeaderSize: 16 * 1024 }, (req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (error instanceof RequestError) reply(res, error.status, error.safeMessage);
      else reply(res, 500, "An internal error occurred.");
    });
  });
  httpServer.maxHeadersCount = 64;
  httpServer.headersTimeout = 10_000;
  httpServer.requestTimeout = 15_000;
  httpServer.keepAliveTimeout = 5_000;
  httpServer.maxConnections = 128;

  return {
    httpServer,
    async listen(): Promise<void> {
      try {
        await new Promise<void>((resolve, reject) => {
          httpServer.once("error", reject);
          httpServer.listen(httpConfig.port, httpConfig.host, () => {
            httpServer.off("error", reject);
            resolve();
          });
        });
      } catch {
        clearInterval(sweepTimer);
        throw new AppError("HTTP_START_FAILED", "The HTTP listener could not start.");
      }
    },
    close(): Promise<void> {
      closePromise ??= (async () => {
        stopping = true;
        clearInterval(sweepTimer);
        const closed = new Promise<void>((resolve) => httpServer.close(() => resolve()));
        await Promise.allSettled([...sessions].map(dispose));
        httpServer.closeAllConnections();
        await closed;
      })();
      return closePromise;
    },
  };
}
