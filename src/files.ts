import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { contains } from "./config.ts";

export interface Identity {
  dev: string;
  ino: string;
  size: number;
  mtime: string;
  ctime: string;
}
export async function identity(path: string): Promise<Identity> {
  const info = await lstat(path, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error("Expected a regular file: " + path);
  const size = Number(info.size);
  if (!Number.isSafeInteger(size))
    throw new Error("File is too large to index safely");
  return {
    dev: String(info.dev),
    ino: String(info.ino),
    size,
    mtime: String(info.mtimeNs),
    ctime: String(info.ctimeNs),
  };
}
export function sameIdentity(a: Identity, b: Identity): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtime === b.mtime &&
    a.ctime === b.ctime
  );
}
export async function hashFile(
  path: string,
  signal?: AbortSignal,
): Promise<string> {
  const hash = createHash("sha256");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    for await (const chunk of handle.createReadStream({ signal }))
      hash.update(chunk);
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}
export async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
export async function syncFile(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
export async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + "." + randomUUID() + ".tmp";
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value, null, 2) + "\n");
    await handle.sync();
  } catch (error) {
    await handle.close();
    await rm(temporary, { force: true });
    throw error;
  }
  await handle.close();
  await rename(temporary, path);
  await syncDirectory(dirname(path));
}
export function relativePath(value: string): string {
  if (
    !value ||
    isAbsolute(value) ||
    value.includes("\0") ||
    value.includes("\\") ||
    /^[A-Za-z]:/.test(value)
  )
    throw new Error("Unsafe relative path");
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === ".."))
    throw new Error("Unsafe relative path");
  return value;
}
export async function safePath(
  root: string,
  relative: string,
  createParents = false,
): Promise<string> {
  const parts = relativePath(relative).split("/");
  let current = await realpath(root);
  if (current !== resolve(root))
    throw new Error("Configured directory changed through a symbolic link");
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error(
          "Archive path traverses a non-directory or symbolic link",
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !createParents)
        throw error;
      await mkdir(current);
    }
    if (!contains(root, await realpath(current)))
      throw new Error("Archive path leaves its configured directory");
  }
  const target = join(current, parts.at(-1)!);
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isFile())
      throw new Error("Archive target is not a regular file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return target;
}
export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
export async function canonicalDestination(path: string): Promise<string> {
  await mkdir(dirname(resolve(path)), { recursive: true });
  return join(
    await realpath(dirname(resolve(path))),
    path.split(/[\\/]/).at(-1)!,
  );
}
