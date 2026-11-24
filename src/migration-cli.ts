import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { configFromEnv } from "./config.ts";
import { migrate } from "./migrate.ts";

export async function migrationMain(
  args = process.argv.slice(2),
): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      "dry-run": { type: "boolean" },
      target: { type: "string" },
      "source-root": { type: "string" },
      map: { type: "string", multiple: true },
    },
  });
  if (positionals.length !== 1)
    throw new Error(
      "Usage: migrate SOURCE [--dry-run] [--target PATH] [--source-root PATH] [--map OLD_ROOT=NEW_ROOT]",
    );
  const config = configFromEnv();
  const maps: Record<string, string> = {};
  for (const mapping of values.map ?? []) {
    const split = mapping.indexOf("=");
    if (split <= 0 || split === mapping.length - 1)
      throw new Error("--map must be OLD_ROOT=NEW_ROOT");
    maps[mapping.slice(0, split)] = resolve(mapping.slice(split + 1));
  }
  const report = await migrate({
    source: positionals[0]!,
    target: values.target ?? config.database,
    sourceRoot: values["source-root"] ?? config.source,
    maps,
    dryRun: values["dry-run"] ?? false,
  });
  console.log(JSON.stringify(report, null, 2));
}

if (import.meta.main)
  migrationMain().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
