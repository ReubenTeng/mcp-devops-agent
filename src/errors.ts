export class AppError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AppError";
    this.code = code;
  }
}

export async function toolResult(fn: () => Promise<object>): Promise<{
  content: { type: "text"; text: string }[];
  structuredContent?: { [x: string]: unknown };
  isError?: boolean;
  [x: string]: unknown;
}> {
  try {
    const data = await fn();
    return {
      content: [{ type: "text", text: JSON.stringify(data) }],
      structuredContent: data as { [x: string]: unknown },
    };
  } catch (err) {
    const payload =
      err instanceof AppError
        ? { error: { code: err.code, message: err.message } }
        : { error: { code: "INTERNAL_ERROR", message: "An internal error occurred. No details are exposed." } };
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      structuredContent: payload,
      isError: true,
    };
  }
}
