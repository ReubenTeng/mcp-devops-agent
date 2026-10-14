import { constants } from "node:fs";
import { randomBytes } from "node:crypto";
import * as fsp from "node:fs/promises";
import path from "node:path";
import { AppError } from "../errors.js";

const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const NON_BLOCK = constants.O_NONBLOCK ?? 0;
const DEFAULT_MAX_BYTES = 1024 * 1024;

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as NodeJS.ErrnoException).code === "ENOENT";
}

function isContained(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

async function lexicalComponentsSymlinkFree(
  lexicalRoot: string,
  canonicalRoot: string,
  projectPath: string,
  resolved: string,
): Promise<boolean> {
  let rel: string;
  if (isContained(lexicalRoot, projectPath)) {
    rel = path.relative(lexicalRoot, projectPath);
  } else if (isContained(canonicalRoot, projectPath)) {
    rel = path.relative(canonicalRoot, projectPath);
  } else {
    rel = path.relative(canonicalRoot, resolved);
  }
  if (rel === "") return true;
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return true;
  let current = canonicalRoot;
  for (const segment of rel.split(path.sep)) {
    current = path.join(current, segment);
    let info;
    try {
      info = await fsp.lstat(current);
    } catch {
      return false;
    }
    if (info.isSymbolicLink()) return false;
  }
  return true;
}

export async function resolveProjectPath(projectPath: string, roots: readonly string[]): Promise<string> {
  if (typeof projectPath !== "string" || projectPath.length === 0 || !path.isAbsolute(projectPath)) {
    throw new AppError("INVALID_PROJECT_PATH", "Project path must be an absolute path inside an allowed project root.");
  }
  let resolved: string;
  try {
    resolved = await fsp.realpath(projectPath);
  } catch {
    throw new AppError("INVALID_PROJECT_PATH", "Project path does not exist or is not accessible.");
  }
  let info;
  try {
    info = await fsp.stat(resolved);
  } catch {
    throw new AppError("INVALID_PROJECT_PATH", "Project path does not exist or is not accessible.");
  }
  if (!info.isDirectory()) {
    throw new AppError("INVALID_PROJECT_PATH", "Project path must be a directory.");
  }
  for (const root of roots) {
    let canonicalRoot: string;
    try {
      canonicalRoot = await fsp.realpath(root);
    } catch {
      continue;
    }
    if (!isContained(canonicalRoot, resolved)) continue;
    if (!(await lexicalComponentsSymlinkFree(root, canonicalRoot, projectPath, resolved))) {
      throw new AppError("UNSAFE_PATH", "Project path contains a symbolic link inside an allowed root.");
    }
    return resolved;
  }
  throw new AppError("PATH_NOT_ALLOWED", "Project path is outside the allowed project roots.");
}

export async function readProjectBytes(
  root: string,
  relativePath: string,
  maxBytes: number = DEFAULT_MAX_BYTES,
): Promise<Buffer | undefined> {
  if (relativePath.length === 0 || path.isAbsolute(relativePath)) {
    throw new AppError("INVALID_FILE_PATH", "File path must be a relative path inside the project.");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 64 * 1024 * 1024) {
    throw new AppError("INVALID_FILE_PATH", "File size limit must be a supported non-negative size.");
  }
  const segments = relativePath.split(/[\\/]+/).filter((segment) => segment.length > 0);
  if (segments.length === 0 || segments.some((segment) => segment === "." || segment === "..")) {
    throw new AppError("INVALID_FILE_PATH", "File path must be a relative path inside the project.");
  }
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    let info;
    try {
      info = await fsp.lstat(current);
    } catch (err) {
      if (isEnoent(err)) return undefined;
      throw new AppError("FILE_READ_FAILED", "Could not read the project file.");
    }
    if (info.isSymbolicLink()) {
      throw new AppError("UNSAFE_PATH", "Refusing to follow symbolic links inside the project.");
    }
    if (!info.isDirectory()) {
      return undefined;
    }
  }
  const filePath = path.join(current, segments[segments.length - 1] as string);
  let info;
  try {
    info = await fsp.lstat(filePath);
  } catch (err) {
    if (isEnoent(err)) return undefined;
    throw new AppError("FILE_READ_FAILED", "Could not read the project file.");
  }
  if (info.isSymbolicLink()) {
    throw new AppError("UNSAFE_PATH", "Refusing to follow symbolic links inside the project.");
  }
  if (!info.isFile() || info.nlink !== 1) {
    throw new AppError("UNSAFE_PATH", "The requested path is not a plain regular file.");
  }
  if (info.size > maxBytes) {
    throw new AppError("FILE_TOO_LARGE", "The project file exceeds the supported size limit.");
  }
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(filePath, constants.O_RDONLY | NO_FOLLOW | NON_BLOCK);
  } catch (err) {
    if (isEnoent(err)) return undefined;
    if ((err as NodeJS.ErrnoException).code === "ELOOP") {
      throw new AppError("UNSAFE_PATH", "Refusing to follow symbolic links inside the project.");
    }
    throw new AppError("FILE_READ_FAILED", "Could not read the project file.");
  }
  try {
    const openInfo = await handle.stat();
    if (!openInfo.isFile() || openInfo.nlink !== 1) {
      throw new AppError("UNSAFE_PATH", "The requested path is not a plain regular file.");
    }
    const out = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset < out.length) {
      const { bytesRead } = await handle.read(out, offset, out.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maxBytes) {
      throw new AppError("FILE_TOO_LARGE", "The project file exceeds the supported size limit.");
    }
    return Buffer.from(out.subarray(0, offset));
  } finally {
    await handle.close();
  }
}

export async function readProjectFile(
  root: string,
  relativePath: string,
  maxBytes: number = DEFAULT_MAX_BYTES,
): Promise<string | undefined> {
  const bytes = await readProjectBytes(root, relativePath, maxBytes);
  return bytes === undefined ? undefined : bytes.toString("utf8");
}

export async function withFileLock<T>(filePath: string, run: () => Promise<T>): Promise<T> {
  const lockPath = `${filePath}.lock`;
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW, 0o600);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      throw new AppError(
        "FILE_BUSY",
        "This file is being updated by another process. Verify the writer has exited before removing the lock file manually.",
      );
    }
    if (code === "ELOOP") {
      throw new AppError("UNSAFE_PATH", "Refusing to use a symbolic link lock file.");
    }
    throw new AppError("LOCK_FAILED", "Could not acquire the file lock.");
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1) {
      throw new AppError("UNSAFE_PATH", "The lock file is not a regular exclusive file.");
    }
    return await run();
  } finally {
    await handle.close().catch(() => {});
    await fsp.unlink(lockPath).catch(() => {});
  }
}

export async function atomicWritePrivate(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  let canonicalDir: string;
  try {
    canonicalDir = await fsp.realpath(dir);
  } catch {
    throw new AppError("INVALID_PROJECT_PATH", "The target directory does not exist or is not accessible.");
  }
  const dirIdentity = await fsp.stat(canonicalDir);
  const targetPath = path.join(canonicalDir, base);
  const tempPath = path.join(canonicalDir, `.${base}.${randomBytes(8).toString("hex")}.tmp`);
  let handle: fsp.FileHandle | undefined;
  try {
    handle = await fsp.open(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW, 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    let existing;
    try {
      existing = await fsp.lstat(targetPath);
    } catch (err) {
      if (!isEnoent(err)) throw err;
      existing = undefined;
    }
    if (existing && (existing.isSymbolicLink() || !existing.isFile() || existing.nlink !== 1)) {
      throw new AppError("UNSAFE_PATH", "Refusing to replace a symbolic link or hard-linked file.");
    }
    const dirIdentityNow = await fsp.stat(canonicalDir);
    if (dirIdentityNow.dev !== dirIdentity.dev || dirIdentityNow.ino !== dirIdentity.ino) {
      throw new AppError("WRITE_FAILED", "The target directory changed while writing. The original file was left unchanged.");
    }
    try {
      await fsp.rename(tempPath, targetPath);
    } catch {
      throw new AppError("WRITE_FAILED", "Could not write the file safely. The original file was left unchanged.");
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError("WRITE_FAILED", "Could not write the file safely. The original file was left unchanged.");
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fsp.unlink(tempPath).catch(() => {});
  }
  let dirHandle: fsp.FileHandle | undefined;
  try {
    dirHandle = await fsp.open(canonicalDir, constants.O_RDONLY);
    await dirHandle.sync();
  } catch {
    throw new AppError("SYNC_FAILED", "File was written but directory metadata could not be synced.");
  } finally {
    if (dirHandle) await dirHandle.close().catch(() => {});
  }
}
