import { AppError } from "../errors.js";

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = [100, 250];
const MAX_RETRY_AFTER_MS = 2_000;

export type ProviderOrigin = "https://api.vercel.com" | "https://api.supabase.com" | "https://api.cloudflare.com";

const PROVIDER_NAMES: Record<ProviderOrigin, string> = {
  "https://api.vercel.com": "Vercel",
  "https://api.supabase.com": "Supabase",
  "https://api.cloudflare.com": "Cloudflare",
};

export class ProviderError extends AppError {
  readonly status: number | undefined;
  readonly ambiguous: boolean;

  constructor(code: string, message: string, status: number | undefined, ambiguous: boolean) {
    super(code, message);
    this.status = status;
    this.ambiguous = ambiguous;
  }
}

export interface RequestOptions {
  body?: unknown;
  bytes?: Buffer;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  readOnly?: boolean;
  allowEmpty?: boolean;
  signal?: AbortSignal;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function combinedSignal(timeoutMs: number, caller: AbortSignal | undefined): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (caller) {
    if (caller.aborted) {
      controller.abort();
    } else {
      caller.addEventListener("abort", onAbort, { once: true });
    }
  }
  return {
    signal: controller.signal,
    cancel: () => {
      clearTimeout(timer);
      caller?.removeEventListener("abort", onAbort);
    },
  };
}

async function readBoundedBody(response: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
  const body = response.body;
  if (!body) return "";
  const reader = body.getReader();
  let abortResolve: (() => void) | undefined;
  const aborted = new Promise<"aborted">((resolve) => {
    abortResolve = () => resolve("aborted");
  });
  const onAbort = () => {
    abortResolve?.();
    reader.cancel().catch(() => {});
  };
  if (signal.aborted) {
    reader.releaseLock();
    throw new RangeError("body read aborted");
  }
  signal.addEventListener("abort", onAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const raced = await Promise.race([
        reader.read().then((result) => ({ kind: "read" as const, result })),
        aborted.then((kind) => ({ kind })),
      ]);
      if (raced.kind === "aborted") {
        throw new RangeError("body read aborted");
      }
      const { done, value } = raced.result;
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          throw new RangeError("body too large");
        }
        chunks.push(value);
      }
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

export class ProviderHttp {
  constructor(
    readonly origin: ProviderOrigin,
    private readonly token: string | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs: number = REQUEST_TIMEOUT_MS,
    private readonly defaultSignal: AbortSignal | undefined = undefined,
  ) {}

  private providerName(): string {
    return PROVIDER_NAMES[this.origin];
  }

  async request(
    method: "GET" | "POST" | "PUT" | "PATCH",
    path: string,
    options: RequestOptions = {},
  ): Promise<unknown> {
    if (!this.token) {
      throw new ProviderError(
        "MISSING_CREDENTIAL",
        `${this.providerName()} credential is not configured.`,
        undefined,
        false,
      );
    }
    if (!path.startsWith("/") || path.startsWith("//")) {
      throw new AppError("INTERNAL_ERROR", "Invalid provider request path.");
    }
    const url = new URL(path, this.origin);
    if (url.origin !== this.origin) {
      throw new AppError("INTERNAL_ERROR", "Invalid provider request path.");
    }
    for (const [key, value] of Object.entries(options.query ?? {})) {
      url.searchParams.set(key, value);
    }

    const mutation = method !== "GET" && options.readOnly !== true;
    const retryableStatus = new Set([429, 502, 503, 504]);
    const canRetry = !mutation;
    const callerSignal = options.signal ?? this.defaultSignal;

    const checkAborted = () => {
      if (callerSignal?.aborted) {
        throw new ProviderError(
          "CANCELLED",
          `${this.providerName()} request was cancelled.`,
          undefined,
          mutation,
        );
      }
    };

    let lastError: ProviderError | undefined;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      checkAborted();
      const { signal, cancel } = combinedSignal(this.timeoutMs, callerSignal);
      const headers: Record<string, string> = {
        authorization: `Bearer ${this.token}`,
        accept: "application/json",
        ...options.headers,
      };
      let body: BodyInit | undefined;
      if (options.bytes !== undefined) {
        body = new Uint8Array(options.bytes);
      } else if (options.body !== undefined) {
        body = JSON.stringify(options.body);
        headers["content-type"] = "application/json";
      }
      let response: Response;
      try {
        response = await this.fetchImpl(url.toString(), {
          method,
          headers,
          body,
          redirect: "error",
          signal,
        });
      } catch {
        cancel();
        if (callerSignal?.aborted) {
          throw new ProviderError("CANCELLED", `${this.providerName()} request was cancelled.`, undefined, mutation);
        }
        lastError = new ProviderError(
          "PROVIDER_REQUEST_FAILED",
          `${this.providerName()} request failed or timed out.`,
          undefined,
          mutation,
        );
        if (canRetry && attempt < MAX_RETRIES) {
          await sleep(RETRY_DELAY_MS[attempt] ?? 250);
          continue;
        }
        throw lastError;
      }

      const status = response.status;
      if (status < 200 || status >= 300) {
        await response.body?.cancel().catch(() => {});
        cancel();
        if (canRetry && retryableStatus.has(status) && attempt < MAX_RETRIES) {
          checkAborted();
          const retryAfterHeader = response.headers.get("retry-after");
          let delay = RETRY_DELAY_MS[attempt] ?? 250;
          if (retryAfterHeader !== null) {
            const seconds = Number(retryAfterHeader);
            if (Number.isFinite(seconds) && seconds >= 0) {
              delay = Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
            }
          }
          await sleep(delay);
          continue;
        }
        if (status === 401 || status === 403) {
          throw new ProviderError(
            "AUTH_REQUIRED",
            `${this.providerName()} rejected the configured credentials.`,
            status,
            false,
          );
        }
        if (status === 429) {
          throw new ProviderError("RATE_LIMITED", `${this.providerName()} rate limit was reached.`, status, mutation);
        }
        const ambiguous = mutation
          ? !(status >= 400 && status < 500 && status !== 408)
          : status === 408;
        throw new ProviderError(
          "PROVIDER_REQUEST_FAILED",
          `${this.providerName()} request failed with status ${status}.`,
          status,
          ambiguous,
        );
      }

      let raw: string;
      try {
        raw = await readBoundedBody(response, MAX_RESPONSE_BYTES, signal);
      } catch (err) {
        cancel();
        await response.body?.cancel().catch(() => {});
        if (callerSignal?.aborted) {
          throw new ProviderError("CANCELLED", `${this.providerName()} request was cancelled.`, undefined, mutation);
        }
        if (err instanceof RangeError) {
          throw new ProviderError(
            "PROVIDER_RESPONSE_INVALID",
            `${this.providerName()} returned an unexpectedly large response.`,
            status,
            mutation,
          );
        }
        lastError = new ProviderError(
          "PROVIDER_RESPONSE_INVALID",
          `${this.providerName()} response could not be read.`,
          status,
          mutation,
        );
        if (canRetry && attempt < MAX_RETRIES) {
          await sleep(RETRY_DELAY_MS[attempt] ?? 250);
          continue;
        }
        throw lastError;
      }
      cancel();

      if (raw.length === 0) {
        if (options.allowEmpty) return undefined;
        throw new ProviderError(
          "PROVIDER_RESPONSE_INVALID",
          `${this.providerName()} returned an empty response.`,
          status,
          mutation,
        );
      }
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        throw new ProviderError(
          "PROVIDER_RESPONSE_INVALID",
          `${this.providerName()} returned a malformed response.`,
          status,
          mutation,
        );
      }
    }
    throw lastError ?? new ProviderError("PROVIDER_REQUEST_FAILED", `${this.providerName()} request failed.`, undefined, mutation);
  }
}
