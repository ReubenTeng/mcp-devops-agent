import { parse as parseEnv } from "dotenv";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { AppError } from "../errors.js";
import type { EnvSecrets } from "../types/index.js";
import { atomicWritePrivate, readProjectFile, withFileLock } from "./files.js";

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_KEYS = 100;
const MAX_VALUE_BYTES = 64 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024;
const MAX_ENV_FILE_BYTES = 1024 * 1024;

const ASSIGNMENT_RE = /^(\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=)(.*)$/;

function validateKeyName(key: string): void {
  if (!KEY_PATTERN.test(key) || FORBIDDEN_KEYS.has(key)) {
    throw new AppError("INVALID_SECRET_KEY", "Secret keys must be portable environment variable names.");
  }
}

function validateSecrets(secrets: EnvSecrets): void {
  const keys = Object.keys(secrets);
  if (keys.length > MAX_KEYS) {
    throw new AppError("INVALID_SECRETS", "Too many keys in a single update.");
  }
  let totalBytes = 0;
  for (const key of keys) {
    validateKeyName(key);
    const value = secrets[key];
    if (typeof value !== "string" || value.includes(String.fromCharCode(0))) {
      throw new AppError("INVALID_SECRET_VALUE", "Secret values must be strings without NUL bytes.");
    }
    const size = Buffer.byteLength(value, "utf8");
    if (size > MAX_VALUE_BYTES) {
      throw new AppError("INVALID_SECRET_VALUE", "A secret value exceeds the supported size limit.");
    }
    totalBytes += Buffer.byteLength(key, "utf8") + size;
  }
  if (totalBytes > MAX_TOTAL_BYTES) {
    throw new AppError("INVALID_SECRETS", "The combined secrets payload exceeds the supported size limit.");
  }
}

function serializeEnvValue(key: string, value: string): string {
  let sentinelBefore = "_MCP_PROBE_BEFORE";
  while (sentinelBefore === key) sentinelBefore += "_X";
  let sentinelAfter = "_MCP_PROBE_AFTER";
  while (sentinelAfter === key || sentinelAfter === sentinelBefore) sentinelAfter += "_X";
  const candidates = [
    `'${value}'`,
    `\`${value}\``,
    `"${value.replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`,
    value,
  ];
  for (const candidate of candidates) {
    const probe = `${sentinelBefore}=1\n${key}=${candidate}\n${sentinelAfter}=2\n`;
    let parsed: Record<string, string>;
    try {
      parsed = parseEnv(probe);
    } catch {
      continue;
    }
    if (
      parsed[key] === value &&
      parsed[sentinelBefore] === "1" &&
      parsed[sentinelAfter] === "2" &&
      Object.keys(parsed).length === 3
    ) {
      return candidate;
    }
  }
  throw new AppError(
    "UNSUPPORTED_ENV_VALUE",
    "A secret value cannot be written to .env without changing its content. No changes were made.",
  );
}

interface EnvLine {
  text: string;
  eol: string;
}

interface EnvSpan {
  key: string;
  start: number;
  end: number;
  prefix: string;
  unterminated: boolean;
}

function findClosingQuote(text: string, quote: string, from: number): number {
  for (let i = from; i < text.length; i += 1) {
    if (text[i] === quote) {
      if (quote === '"') {
        let backslashes = 0;
        for (let j = i - 1; j >= 0 && text[j] === "\\"; j -= 1) backslashes += 1;
        if (backslashes % 2 === 1) continue;
      }
      return i;
    }
  }
  return -1;
}

export function mergeEnvContents(contents: string, secrets: EnvSecrets): string {
  validateSecrets(secrets);
  const keys = Object.keys(secrets);
  if (keys.length === 0) {
    return contents;
  }

  const lines: EnvLine[] = [];
  const newlineRe = /\r\n|\r|\n/g;
  let match: RegExpExecArray | null;
  let lastIndex = 0;
  while ((match = newlineRe.exec(contents)) !== null) {
    lines.push({ text: contents.slice(lastIndex, match.index), eol: match[0] });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < contents.length) {
    lines.push({ text: contents.slice(lastIndex), eol: "" });
  }
  const dominantEol = lines.find((line) => line.eol.length > 0)?.eol ?? "\n";

  const spans: EnvSpan[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line) break;
    const assignment = ASSIGNMENT_RE.exec(line.text);
    if (!assignment) {
      index += 1;
      continue;
    }
    const prefix = assignment[1] ?? "";
    const key = assignment[2] ?? "";
    const rest = assignment[3] ?? "";
    const trimmed = rest.replace(/^\s+/, "");
    let end = index;
    let unterminated = false;
    const quote = trimmed[0];
    if (quote === "'" || quote === '"' || quote === "`") {
      const quoteOffset = rest.indexOf(quote);
      let closing = findClosingQuote(rest, quote, quoteOffset + 1);
      let cursor = index;
      while (closing === -1) {
        cursor += 1;
        const next = lines[cursor];
        if (next === undefined) break;
        closing = findClosingQuote(next.text, quote, 0);
      }
      if (cursor < lines.length) {
        end = cursor;
      } else {
        end = lines.length - 1;
        unterminated = true;
      }
    }
    spans.push({ key, start: index, end, prefix, unterminated });
    index = end + 1;
  }

  const provided = new Set(keys);
  if (spans.some((span) => span.unterminated)) {
    throw new AppError(
      "MALFORMED_ENV",
      "The existing .env file contains an unterminated quoted value. No changes were made.",
    );
  }

  const serialized = new Map<string, string>();
  for (const key of keys) {
    serialized.set(key, serializeEnvValue(key, secrets[key] as string));
  }

  for (const span of [...spans].reverse()) {
    const replacement = serialized.get(span.key);
    if (replacement !== undefined) {
      const eol = lines[span.end]?.eol ?? dominantEol;
      lines.splice(span.start, span.end - span.start + 1, { text: `${span.prefix}${replacement}`, eol });
    }
  }

  const present = new Set(spans.map((span) => span.key));
  const missing = keys.filter((key) => !present.has(key));
  if (missing.length > 0) {
    if (lines.length > 0 && lines[lines.length - 1]?.eol === "") {
      lines[lines.length - 1]!.eol = dominantEol;
    }
    for (const key of missing.sort()) {
      lines.push({ text: `${key}=${serialized.get(key)}`, eol: dominantEol });
    }
  }

  const merged = lines.map((line) => line.text + line.eol).join("");
  if (Buffer.byteLength(merged, "utf8") > MAX_ENV_FILE_BYTES) {
    throw new AppError("ENV_MERGE_UNSAFE", "The merged .env content exceeds the supported size limit. No changes were made.");
  }

  let parsedMerged: Record<string, string>;
  let parsedOriginal: Record<string, string>;
  try {
    parsedMerged = parseEnv(merged);
    parsedOriginal = parseEnv(contents);
  } catch {
    throw new AppError("ENV_MERGE_UNSAFE", "The merged .env content could not be verified. No changes were made.");
  }
  for (const key of keys) {
    if (parsedMerged[key] !== secrets[key]) {
      throw new AppError("ENV_MERGE_UNSAFE", "The merged .env content could not be verified. No changes were made.");
    }
  }
  for (const key of Object.keys(parsedOriginal)) {
    if (provided.has(key)) continue;
    if (parsedMerged[key] !== parsedOriginal[key]) {
      throw new AppError("ENV_MERGE_UNSAFE", "The merged .env content could not be verified. No changes were made.");
    }
  }
  const expectedKeys = new Set([...Object.keys(parsedOriginal), ...keys]);
  if (Object.keys(parsedMerged).length !== expectedKeys.size || Object.keys(parsedMerged).some((k) => !expectedKeys.has(k))) {
    throw new AppError("ENV_MERGE_UNSAFE", "The merged .env content could not be verified. No changes were made.");
  }
  return merged;
}

export async function readSelectedEnv(root: string, keys: readonly string[]): Promise<EnvSecrets> {
  for (const key of keys) {
    validateKeyName(key);
  }
  const contents = await readProjectFile(root, ".env", MAX_ENV_FILE_BYTES);
  const parsed: Record<string, string> = contents === undefined ? {} : parseEnv(contents);
  const missing = keys.filter((key) => !Object.hasOwn(parsed, key));
  if (missing.length > 0) {
    throw new AppError(
      "MISSING_ENV_KEY",
      `Requested keys are missing from the project .env file: ${missing.sort().join(", ")}`,
    );
  }
  const selected: Record<string, string> = {};
  for (const key of keys) {
    selected[key] = parsed[key] as string;
  }
  return selected;
}

export async function updateEnvSecrets(projectPath: string, secrets: EnvSecrets): Promise<string[]> {
  validateSecrets(secrets);
  const keys = Object.keys(secrets).sort();
  if (keys.length === 0) {
    return [];
  }
  let projectInfo;
  try {
    projectInfo = await lstat(projectPath);
  } catch {
    throw new AppError("INVALID_PROJECT_PATH", "Project path does not exist or is not accessible.");
  }
  if (projectInfo.isSymbolicLink() || !projectInfo.isDirectory()) {
    throw new AppError("INVALID_PROJECT_PATH", "Project path must be a real directory.");
  }
  const envPath = join(projectPath, ".env");
  return withFileLock(envPath, async () => {
    let info;
    try {
      info = await lstat(envPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new AppError("FILE_READ_FAILED", "Could not inspect the project .env file.");
      }
      info = undefined;
    }
    if (info && (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1)) {
      throw new AppError("UNSAFE_ENV_FILE", "Refusing to modify a .env that is a symbolic link or hard-linked file.");
    }
    const existing = (await readProjectFile(projectPath, ".env", MAX_ENV_FILE_BYTES)) ?? "";
    const merged = mergeEnvContents(existing, secrets);
    await atomicWritePrivate(envPath, merged);
    return keys;
  });
}
