import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import ignore from "ignore";
import path from "node:path";
import { AppError } from "../errors.js";
import { readProjectBytes, readProjectFile } from "./files.js";

export interface DeploymentFile {
  file: string;
  sha: string;
  size: number;
}

export interface DeploymentManifest {
  files: DeploymentFile[];
  totalBytes: number;
  digest: string;
  warnings: string[];
}

const MAX_FILES = 5000;
const MAX_ENTRIES = 20000;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_DEPTH = 20;

const DENIED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".turbo",
  ".devin",
  ".cursor",
  ".agents",
  ".vercel",
  ".mcp-devops-agent",
]);
const ALLOWED_DIRS = new Set([".well-known"]);
const DENIED_NAMES = new Set([".npmrc", ".yarnrc", ".yarnrc.yml", ".pypirc", ".netrc", ".git-credentials"]);
const ALLOWED_DOTFILES = new Set([".nvmrc", ".node-version", ".babelrc", ".browserslistrc"]);
const DENIED_EXTENSIONS = new Set([".pem", ".key", ".p12", ".pfx", ".sqlite", ".db", ".log"]);
const IGNORE_FILES = new Set([".gitignore", ".vercelignore"]);

function toPosix(rel: string): string {
  return rel.split(path.sep).join("/");
}

function deniedDir(name: string): boolean {
  if (DENIED_DIRS.has(name)) return true;
  if (ALLOWED_DIRS.has(name)) return false;
  if (name.startsWith(".")) return true;
  return false;
}

function deniedFile(name: string): boolean {
  if (DENIED_NAMES.has(name)) return true;
  if (ALLOWED_DOTFILES.has(name)) return false;
  if (IGNORE_FILES.has(name)) return true;
  if (name.startsWith(".env")) return true;
  if (name.startsWith(".")) return true;
  if (DENIED_EXTENSIONS.has(path.posix.extname(name).toLowerCase())) return true;
  return false;
}

export async function collectDeploymentManifest(root: string): Promise<DeploymentManifest> {
  const files: DeploymentFile[] = [];
  const warnings: string[] = [];
  let totalBytes = 0;
  let entryCount = 0;
  let credentialConfigSkipped = false;

  const matchers: { base: string; ig: ReturnType<typeof ignore> }[] = [];
  const ignoredBy = (relPosix: string, isDir: boolean): boolean => {
    let ignored = false;
    for (const matcher of matchers) {
      const rel = path.posix.relative(matcher.base, relPosix);
      if (rel === "" || rel.startsWith("..") || path.posix.isAbsolute(rel)) continue;
      const tested = isDir ? `${rel}/` : rel;
      const result = matcher.ig.test(tested);
      if (result.ignored) ignored = true;
      if (result.unignored) ignored = false;
    }
    return ignored;
  };

  const walk = async (relDir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) {
      throw new AppError("DEPLOYMENT_TOO_LARGE", "The project exceeds the supported deployment depth.");
    }
    const absDir = relDir === "" ? root : path.join(root, relDir);
    for (const ignoreFile of IGNORE_FILES) {
      const rel = relDir === "" ? ignoreFile : `${toPosix(relDir)}/${ignoreFile}`;
      let content: string | undefined;
      try {
        content = await readProjectFile(root, rel, 256 * 1024);
      } catch {
        throw new AppError("DEPLOYMENT_UNSAFE", "An ignore file could not be read; deployment was not prepared.");
      }
      if (content !== undefined) {
        try {
          matchers.push({ base: relDir === "" ? "." : toPosix(relDir), ig: ignore().add(content) });
        } catch {
          throw new AppError("DEPLOYMENT_UNSAFE", "An ignore file could not be parsed; deployment was not prepared.");
        }
      }
    }
    let listing;
    try {
      listing = await readdir(absDir, { withFileTypes: true });
    } catch {
      throw new AppError("DEPLOYMENT_UNSAFE", "A project directory could not be read; deployment was not prepared.");
    }
    listing.sort((a, b) => a.name.localeCompare(b.name));
    for (const item of listing) {
      entryCount += 1;
      if (entryCount > MAX_ENTRIES) {
        throw new AppError("DEPLOYMENT_TOO_LARGE", "The project exceeds the supported deployment entry limit.");
      }
      if (item.isSymbolicLink()) continue;
      const rel = relDir === "" ? item.name : `${toPosix(relDir)}/${item.name}`;
      if (item.isDirectory()) {
        if (deniedDir(item.name) || ignoredBy(rel, true)) continue;
        await walk(rel, depth + 1);
      } else if (item.isFile()) {
        if (DENIED_NAMES.has(item.name)) credentialConfigSkipped = true;
        if (deniedFile(item.name) || ignoredBy(rel, false)) continue;
        let info;
        try {
          info = await lstat(path.join(root, rel));
        } catch {
          throw new AppError("DEPLOYMENT_UNSAFE", "A project file could not be inspected; deployment was not prepared.");
        }
        if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
          throw new AppError("DEPLOYMENT_UNSAFE", "The project contains a file that cannot be deployed safely.");
        }
        if (info.size > MAX_FILE_BYTES) {
          throw new AppError("DEPLOYMENT_TOO_LARGE", "A project file exceeds the per-file deployment limit.");
        }
        if (files.length >= MAX_FILES || totalBytes + info.size > MAX_TOTAL_BYTES) {
          throw new AppError("DEPLOYMENT_TOO_LARGE", "The project exceeds the supported deployment size limit.");
        }
        const bytes = await readProjectBytes(root, rel, MAX_FILE_BYTES);
        if (bytes === undefined) {
          throw new AppError("DEPLOYMENT_UNSAFE", "A project file changed while reading; deployment was not prepared.");
        }
        totalBytes += bytes.byteLength;
        if (totalBytes > MAX_TOTAL_BYTES) {
          throw new AppError("DEPLOYMENT_TOO_LARGE", "The project exceeds the supported deployment size limit.");
        }
        files.push({ file: rel, sha: createHash("sha1").update(bytes).digest("hex"), size: bytes.byteLength });
      }
    }
  };

  await walk("", 0);
  if (files.length === 0) {
    throw new AppError("DEPLOYMENT_EMPTY", "The project contains no deployable files after ignore rules were applied.");
  }
  if (credentialConfigSkipped) {
    warnings.push("Package-manager credential files such as .npmrc were excluded; private registry installs are not supported.");
  }
  files.sort((a, b) => a.file.localeCompare(b.file));
  const digest = createHash("sha256").update(JSON.stringify(files)).digest("hex");
  return { files, totalBytes, digest, warnings };
}
