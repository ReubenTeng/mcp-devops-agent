import { constants } from "node:fs";
import { randomBytes } from "node:crypto";
import * as fsp from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { z } from "zod";
import { AppError } from "../errors.js";
import { atomicWritePrivate, readProjectBytes } from "../utils/files.js";
import { operationSchema, type Operation } from "./types.js";

const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OP_FILE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/;
const MAX_OPERATION_BYTES = 2 * 1024 * 1024;
const MAX_VAULT_BYTES = 64 * 1024;
const MAX_LOCK_BYTES = 4 * 1024;

const lockMetaSchema = z
  .object({
    pid: z.number().int().positive().safe(),
    hostname: z.string().min(1).max(255),
    nonce: z.string().regex(/^[a-f0-9]{24}$/),
  })
  .strict();

const vaultSchema = z.object({ password: z.string().min(1).max(1024) }).strict();

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as NodeJS.ErrnoException).code === "ENOENT";
}

export class OperationStore {
  private canonicalStateDir: string | undefined;

  constructor(private readonly stateDir: string) {}

  private operationsDir(): string {
    return path.join(this.canonicalStateDir ?? path.resolve(this.stateDir), "operations");
  }

  private checkDirIdentity(info: { isSymbolicLink(): boolean; isDirectory(): boolean; uid: number; mode: number }): void {
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new AppError("UNSAFE_STATE_DIR", "The state directory contains an unsafe path component.");
    }
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
      throw new AppError("UNSAFE_STATE_DIR", "The state directory is not owned by the current user.");
    }
    if ((info.mode & 0o077) !== 0) {
      throw new AppError("UNSAFE_STATE_DIR", "The state directory has unsafe permissions; use a private directory.");
    }
  }

  private async ensureOwnedDir(dir: string): Promise<void> {
    let info;
    try {
      info = await fsp.lstat(dir);
    } catch (err) {
      if (!isEnoent(err)) throw new AppError("STATE_UNAVAILABLE", "The state directory is not accessible.");
      try {
        await fsp.mkdir(dir, { mode: 0o700 });
      } catch (mkdirErr) {
        if ((mkdirErr as NodeJS.ErrnoException).code !== "EEXIST") {
          throw new AppError("STATE_UNAVAILABLE", "The state directory could not be created.");
        }
      }
      info = await fsp.lstat(dir).catch(() => undefined);
      if (!info) throw new AppError("STATE_UNAVAILABLE", "The state directory could not be created.");
    }
    this.checkDirIdentity(info);
  }

  private async ensureStateDirs(): Promise<string> {
    const lexical = path.resolve(this.stateDir);
    let ancestor = lexical;
    while (true) {
      try {
        await fsp.lstat(ancestor);
        break;
      } catch (err) {
        if (!isEnoent(err)) throw new AppError("STATE_UNAVAILABLE", "The state directory is not accessible.");
        const parent = path.dirname(ancestor);
        if (parent === ancestor) {
          throw new AppError("STATE_UNAVAILABLE", "The state directory is not accessible.");
        }
        ancestor = parent;
      }
    }
    const canonicalAncestor = await fsp.realpath(ancestor).catch(() => {
      throw new AppError("STATE_UNAVAILABLE", "The state directory is not accessible.");
    });
    const rel = path.relative(ancestor, lexical);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new AppError("UNSAFE_STATE_DIR", "The state directory path is not resolvable.");
    }
    let current = canonicalAncestor;
    for (const segment of rel === "" ? [] : rel.split(path.sep)) {
      current = path.join(current, segment);
      let info;
      try {
        info = await fsp.lstat(current);
      } catch (err) {
        if (!isEnoent(err)) throw new AppError("STATE_UNAVAILABLE", "The state directory is not accessible.");
        try {
          await fsp.mkdir(current, { mode: 0o700 });
        } catch (mkdirErr) {
          if ((mkdirErr as NodeJS.ErrnoException).code !== "EEXIST") {
            throw new AppError("STATE_UNAVAILABLE", "The state directory could not be created.");
          }
        }
        continue;
      }
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new AppError("UNSAFE_STATE_DIR", "The state directory contains an unsafe path component.");
      }
    }
    const lexicalInfo = await fsp.lstat(lexical).catch(() => undefined);
    if (!lexicalInfo || lexicalInfo.isSymbolicLink() || !lexicalInfo.isDirectory()) {
      throw new AppError("UNSAFE_STATE_DIR", "The state directory contains an unsafe path component.");
    }
    const canonical = await fsp.realpath(current).catch(() => {
      throw new AppError("STATE_UNAVAILABLE", "The state directory is not accessible.");
    });
    if (this.canonicalStateDir !== undefined && this.canonicalStateDir !== canonical) {
      throw new AppError("UNSAFE_STATE_DIR", "The state directory identity changed while in use.");
    }
    this.canonicalStateDir = canonical;
    await this.ensureOwnedDir(canonical);
    await this.ensureOwnedDir(this.operationsDir());
    return canonical;
  }

  async init(): Promise<void> {
    await this.ensureStateDirs();
  }

  private async readStateFile(relative: string, maxBytes: number): Promise<Buffer | undefined> {
    const root = this.canonicalStateDir ?? path.resolve(this.stateDir);
    try {
      return await readProjectBytes(root, relative, maxBytes);
    } catch (err) {
      if (err instanceof AppError && err.code === "UNSAFE_PATH") {
        throw new AppError("UNSAFE_STATE_DIR", "The operation state contains an unsafe file.");
      }
      if (err instanceof AppError) {
        throw new AppError("STATE_UNAVAILABLE", "The operation state could not be read.");
      }
      throw err;
    }
  }

  async withLock<T>(run: () => Promise<T>): Promise<T> {
    await this.init();
    const lockPath = path.join(this.operationsDir(), "operations.lock");
    const nonce = randomBytes(12).toString("hex");
    const payload = JSON.stringify({ pid: process.pid, hostname: hostname(), nonce });
    let ownIno: number | undefined;
    let acquired = false;
    for (let attempt = 0; attempt < 2 && !acquired; attempt += 1) {
      try {
        const handle = await fsp.open(
          lockPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
          0o600,
        );
        try {
          await handle.writeFile(payload, "utf8");
          await handle.sync();
          ownIno = (await handle.stat()).ino;
        } finally {
          await handle.close();
        }
        acquired = true;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") {
          if (code === "ELOOP") throw new AppError("UNSAFE_PATH", "Refusing to use a symbolic link lock file.");
          throw new AppError("LOCK_FAILED", "Could not acquire the operations lock.");
        }
        const existing = await fsp.lstat(lockPath).catch(() => undefined);
        if (!existing || existing.isSymbolicLink() || !existing.isFile() || existing.nlink !== 1) {
          throw new AppError("FILE_BUSY", "Another process holds the operations lock.");
        }
        let meta;
        try {
          const raw = await this.readStateFile("operations/operations.lock", MAX_LOCK_BYTES);
          if (!raw) throw new Error("missing");
          meta = lockMetaSchema.parse(JSON.parse(raw.toString("utf8")));
        } catch {
          throw new AppError("FILE_BUSY", "Another process holds the operations lock.");
        }
        if (meta.hostname !== hostname()) {
          throw new AppError("FILE_BUSY", "Another process holds the operations lock.");
        }
        let alive = true;
        try {
          process.kill(meta.pid, 0);
        } catch (killErr) {
          alive = (killErr as NodeJS.ErrnoException).code !== "ESRCH";
        }
        if (alive) {
          throw new AppError("FILE_BUSY", "Another process holds the operations lock.");
        }
        const recheck = await fsp.lstat(lockPath).catch(() => undefined);
        if (
          recheck &&
          !recheck.isSymbolicLink() &&
          recheck.ino === existing.ino &&
          recheck.dev === existing.dev
        ) {
          await fsp.unlink(lockPath).catch(() => {});
        }
      }
    }
    if (!acquired) {
      throw new AppError("FILE_BUSY", "Another process holds the operations lock.");
    }
    try {
      return await run();
    } finally {
      const current = await fsp.lstat(lockPath).catch(() => undefined);
      if (current && !current.isSymbolicLink() && current.ino === ownIno) {
        const content = await fsp.readFile(lockPath, "utf8").catch(() => "");
        if (content === payload) {
          await fsp.unlink(lockPath).catch(() => {});
        }
      }
    }
  }

  private parseOperation(raw: Buffer, id: string): Operation {
    let parsed: Operation;
    try {
      parsed = operationSchema.parse(JSON.parse(raw.toString("utf8")));
    } catch {
      throw new AppError("CORRUPT_STATE", "The stored operation is corrupted and cannot be used.");
    }
    if (parsed.id !== id) {
      throw new AppError("CORRUPT_STATE", "The stored operation is corrupted and cannot be used.");
    }
    return parsed;
  }

  async load(id: string): Promise<Operation> {
    await this.init();
    if (!ID_PATTERN.test(id)) {
      throw new AppError("NOT_FOUND", "Operation not found.");
    }
    const raw = await this.readStateFile(`operations/${id}.json`, MAX_OPERATION_BYTES);
    if (raw === undefined) {
      throw new AppError("NOT_FOUND", "Operation not found.");
    }
    return this.parseOperation(raw, id);
  }

  async save(op: Operation): Promise<void> {
    await this.init();
    try {
      operationSchema.parse(op);
    } catch {
      throw new AppError("CORRUPT_STATE", "Refusing to persist an invalid operation record.");
    }
    await atomicWritePrivate(path.join(this.operationsDir(), `${op.id}.json`), JSON.stringify(op));
  }

  async listAll(): Promise<Operation[]> {
    await this.init();
    let names: string[];
    try {
      names = await fsp.readdir(this.operationsDir());
    } catch (err) {
      if (isEnoent(err)) return [];
      throw new AppError("STATE_UNAVAILABLE", "The operation state could not be listed.");
    }
    const ops: Operation[] = [];
    for (const name of names) {
      if (!OP_FILE_PATTERN.test(name)) continue;
      const id = name.slice(0, -".json".length);
      const raw = await this.readStateFile(`operations/${name}`, MAX_OPERATION_BYTES);
      if (raw === undefined) {
        throw new AppError("CORRUPT_STATE", "The stored operation is corrupted and cannot be used.");
      }
      ops.push(this.parseOperation(raw, id));
    }
    ops.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return ops;
  }

  async listForProject(projectPath: string): Promise<Operation[]> {
    const all = await this.listAll();
    return all.filter((op) => op.projectPath === projectPath);
  }

  async writeVault(id: string, secret: { password: string }): Promise<void> {
    await this.init();
    if (!ID_PATTERN.test(id)) {
      throw new AppError("NOT_FOUND", "Operation not found.");
    }
    await atomicWritePrivate(path.join(this.operationsDir(), `${id}.secret.json`), JSON.stringify(secret));
  }

  async readVault(id: string): Promise<{ password: string } | undefined> {
    await this.init();
    if (!ID_PATTERN.test(id)) return undefined;
    const raw = await this.readStateFile(`operations/${id}.secret.json`, MAX_VAULT_BYTES);
    if (raw === undefined) return undefined;
    try {
      const parsed = vaultSchema.parse(JSON.parse(raw.toString("utf8")));
      return { password: parsed.password };
    } catch {
      throw new AppError("CORRUPT_STATE", "The stored operation credential is corrupted.");
    }
  }
}

export function aggregateCosts(
  operations: readonly Operation[],
  now: Date,
): { monthlyCents: number; upfrontCents: number } {
  const recurring = new Map<string, number>();
  let upfrontCents = 0;
  for (const op of operations) {
    if (op.status === "cancelled" || (op.status === "failed" && !op.costCommitted)) continue;
    if (op.status === "prepared" && Date.parse(op.expiresAt) < now.getTime()) continue;
    for (const item of op.estimate.recurringItems) {
      recurring.set(item.key, Math.max(recurring.get(item.key) ?? 0, item.cents));
    }
    upfrontCents += op.estimate.upfrontCents;
  }
  return { monthlyCents: [...recurring.values()].reduce((a, b) => a + b, 0), upfrontCents };
}
