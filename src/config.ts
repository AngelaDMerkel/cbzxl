import { availableParallelism } from "node:os";
import { resolve, relative, isAbsolute, sep } from "node:path";
import { access, mkdir, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";

export interface Config {
  source: string;
  converted?: string;
  quarantine?: string;
  database: string;
  scratch: string;
  host: string;
  port: number;
  token?: string;
  threads: number;
  memoryMb: number;
  effort: number;
  stableSeconds: number;
  maxArchiveBytes: number;
  maxEntries: number;
  commandSeconds: number;
}

export function numberSetting(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number {
  if (value === undefined || value === "") return fallback;
  if (typeof value !== "number" && typeof value !== "string")
    throw new Error(name + " must be a number");
  const result = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max)
    throw new Error(
      name + " must be an integer between " + min + " and " + max,
    );
  return result;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Config {
  const optionalPath = (key: string) =>
    env[key]?.trim() ? resolve(env[key]!.trim()) : undefined;
  return {
    source: resolve(env.SOURCE_DIR?.trim() || "./comics"),
    converted: optionalPath("CONVERTED_DIR"),
    quarantine: optionalPath("QUARANTINE_DIR"),
    database: resolve(env.DB_PATH?.trim() || "./data/cbzxl.sqlite3"),
    scratch: resolve(env.SCRATCH_DIR?.trim() || "./data/work"),
    host: env.HOST?.trim() || "127.0.0.1",
    port: numberSetting(env.PORT, 5000, 1, 65535, "PORT"),
    token: env.API_TOKEN?.trim() || undefined,
    threads: numberSetting(
      env.CPU_LIMIT,
      Math.min(2, availableParallelism()),
      1,
      64,
      "CPU_LIMIT",
    ),
    memoryMb: numberSetting(
      env.MEMORY_LIMIT_MB,
      2048,
      128,
      65536,
      "MEMORY_LIMIT_MB",
    ),
    effort: numberSetting(env.ENCODER_EFFORT, 7, 1, 10, "ENCODER_EFFORT"),
    stableSeconds: numberSetting(
      env.ARCHIVE_STABLE_SECONDS,
      2,
      0,
      3600,
      "ARCHIVE_STABLE_SECONDS",
    ),
    maxArchiveBytes:
      numberSetting(env.MAX_ARCHIVE_MB, 8192, 1, 65536, "MAX_ARCHIVE_MB") *
      1024 ** 2,
    maxEntries: numberSetting(
      env.MAX_ARCHIVE_ENTRIES,
      10000,
      1,
      100000,
      "MAX_ARCHIVE_ENTRIES",
    ),
    commandSeconds: numberSetting(
      env.COMMAND_TIMEOUT_SECONDS,
      600,
      1,
      86400,
      "COMMAND_TIMEOUT_SECONDS",
    ),
  };
}

export function contains(root: string, path: string): boolean {
  const rel = relative(root, path);
  return (
    rel === "" ||
    (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep))
  );
}

export async function prepareDirectories(config: Config): Promise<Config> {
  if (!(await stat(config.source)).isDirectory())
    throw new Error("SOURCE_DIR must be a directory");
  await access(config.source, constants.R_OK | constants.W_OK);
  const source = await realpath(config.source);
  for (const path of [config.converted, config.quarantine, config.scratch])
    if (path) await mkdir(path, { recursive: true });
  const converted = config.converted
    ? await realpath(config.converted)
    : undefined;
  const quarantine = config.quarantine
    ? await realpath(config.quarantine)
    : undefined;
  const scratch = await realpath(config.scratch);
  for (const [name, path] of [
    ["CONVERTED_DIR", converted],
    ["QUARANTINE_DIR", quarantine],
  ] as const) {
    if (!path) continue;
    if (contains(path, source))
      throw new Error(name + " must not equal or contain SOURCE_DIR");
    await access(path, constants.R_OK | constants.W_OK);
  }
  if (
    converted &&
    quarantine &&
    (contains(converted, quarantine) || contains(quarantine, converted))
  ) {
    throw new Error("CONVERTED_DIR and QUARANTINE_DIR must not overlap");
  }
  if (
    [source, converted, quarantine].some(
      (path) => path && (contains(path, scratch) || contains(scratch, path)),
    )
  ) {
    throw new Error(
      "SCRATCH_DIR must be separate from the library directories",
    );
  }
  return { ...config, source, converted, quarantine, scratch };
}

export interface Policy {
  mode: "lossless" | "lossy";
  effort: number;
  distance: number;
}
export function parsePolicy(value: unknown, defaultEffort = 7): Policy {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("A conversion policy is required");
  const input = value as Record<string, unknown>;
  const mode = input.mode ?? "lossless";
  if (mode !== "lossless" && mode !== "lossy")
    throw new Error("mode must be lossless or lossy");
  const effort = numberSetting(input.effort, defaultEffort, 1, 10, "effort");
  const distance = mode === "lossless" ? 0 : (input.distance ?? 0.5);
  if (
    typeof distance !== "number" ||
    !Number.isFinite(distance) ||
    distance < 0 ||
    distance > 3 ||
    (mode === "lossy" && distance === 0)
  ) {
    throw new Error("Lossy distance must be greater than 0 and at most 3");
  }
  return { mode, effort, distance };
}
