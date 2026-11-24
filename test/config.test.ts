import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configFromEnv,
  parsePolicy,
  prepareDirectories,
} from "../src/config.ts";
import { openDatabase, transaction, verifyDatabase } from "../src/database.ts";

test("optional paths enable routing, defaults are lossless, and aliases cannot route into the source", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cbzxl-config-"));
  try {
    const source = join(dir, "source");
    await mkdir(source);
    const config = configFromEnv({
      SOURCE_DIR: source,
      SCRATCH_DIR: join(dir, "work"),
      CONVERTED_DIR: " ",
    });
    assert.equal(config.converted, undefined);
    assert.deepEqual(parsePolicy({ mode: "lossless", distance: 3 }), {
      mode: "lossless",
      effort: 7,
      distance: 0,
    });
    assert.throws(() => parsePolicy({ mode: "lossy", distance: NaN }));
    assert.throws(() => parsePolicy({ effort: true }));
    assert.throws(() => configFromEnv({ CPU_LIMIT: "Infinity" }));
    await prepareDirectories(config);
    await symlink(source, join(dir, "alias"));
    await assert.rejects(
      prepareDirectories({ ...config, converted: join(dir, "alias") }),
      /must not equal/,
    );
    const routed = await prepareDirectories({
      ...config,
      converted: join(dir, "converted"),
      quarantine: join(dir, "quarantine"),
    });
    assert.ok(routed.converted && routed.quarantine);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("schema constraints and transactions preserve data after failed writes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cbzxl-db-"));
  const db = openDatabase(join(dir, "app.sqlite3"));
  try {
    db.prepare("INSERT INTO libraries(id,name,root_path) VALUES (?,?,?)").run(
      "main",
      "Comics",
      "/data/source",
    );
    assert.throws(() =>
      transaction(db, () => {
        db.prepare("INSERT INTO meta VALUES ('test','before')").run();
        db.prepare(
          "INSERT INTO libraries(id,name,root_path) VALUES ('main','Duplicate','/data')",
        ).run();
      }),
    );
    assert.equal(
      db.prepare("SELECT * FROM meta WHERE key='test'").get(),
      undefined,
    );
    verifyDatabase(db);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
