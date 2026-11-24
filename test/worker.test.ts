import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configFromEnv,
  prepareDirectories,
  parsePolicy,
} from "../src/config.ts";
import { openDatabase, verifyDatabase } from "../src/database.ts";
import { readArchive, writeArchive } from "../src/archive.ts";
import { findTools } from "../src/codec.ts";
import { activeLibrary, enqueue, totals } from "../src/library.ts";
import { exists, hashFile } from "../src/files.ts";
import { recoverTransfers } from "../src/transfers.ts";
import { Worker } from "../src/worker.ts";
import yauzl from "yauzl";

async function fixture(routing = false) {
  const dir = await fs.mkdtemp(join(tmpdir(), "cbzxl-worker-"));
  await fs.mkdir(join(dir, "source"));
  const config = await prepareDirectories(
    configFromEnv({
      SOURCE_DIR: join(dir, "source"),
      SCRATCH_DIR: join(dir, "work"),
      DB_PATH: join(dir, "app.sqlite3"),
      ...(routing
        ? {
            CONVERTED_DIR: join(dir, "converted"),
            QUARANTINE_DIR: join(dir, "quarantine"),
          }
        : {}),
      CPU_LIMIT: "1",
      ENCODER_EFFORT: "1",
      ARCHIVE_STABLE_SECONDS: "0",
    }),
  );
  const db = openDatabase(config.database),
    tools = await findTools(config),
    library = activeLibrary(db, config.source),
    worker = new Worker(db, config, tools);
  await worker.initialize();
  async function book(name: string, image = true, gradient = "blue-white") {
    const path = join(config.source, name);
    await fs.mkdir(join(path, ".."), { recursive: true });
    const page = join(dir, "page.bmp");
    if (image)
      execFileSync(tools.imagemagick, [
        "-size",
        "256x256",
        "gradient:" + gradient,
        "-depth",
        "8",
        page,
      ]);
    else await fs.writeFile(page, "<ComicInfo>Keep every byte</ComicInfo>");
    await writeArchive(
      path,
      [
        {
          name: image ? "folder/01.bmp" : "ComicInfo.xml",
          path: page,
          directory: false,
          size: (await fs.stat(page)).size,
          hash: await hashFile(page),
          format: image ? "BMP" : "Other",
          mtime: new Date(),
          mode: 0o100644,
          compressed: false,
          comment: "",
        },
      ],
      "Book comment",
    );
    return path;
  }
  async function run(
    mode: "lossless" | "lossy" = "lossless",
    scope = "changed",
    id: string | null = null,
  ) {
    const runId = enqueue(
      db,
      library,
      parsePolicy({ mode, effort: 1 }),
      scope,
      id,
    );
    worker.wake();
    await worker.idle();
    return db.prepare("SELECT * FROM runs WHERE id=?").get(runId)!;
  }
  return {
    dir,
    config,
    db,
    tools,
    library,
    worker,
    book,
    run,
    async close() {
      await worker.close();
      db.close();
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

test("corrupt candidate output never quarantines a valid source", async (t) => {
  const f = await fixture(true);
  const originalOpen = yauzl.openPromise;
  const failure = t.mock.method(
    yauzl,
    "openPromise",
    async (path: string, options?: Parameters<typeof yauzl.openPromise>[1]) => {
      if (path.endsWith("/candidate.cbz"))
        await fs.writeFile(path, "corrupt generated candidate");
      return originalOpen(path, options);
    },
  );
  try {
    const source = await f.book("valid.cbz"),
      original = await hashFile(source);
    const run = await f.run();
    assert.equal(run["failed"], 1);
    assert.equal(run["bytes_saved"], 0);
    assert.equal(await hashFile(source), original);
    assert.equal(await exists(join(f.config.quarantine!, "valid.cbz")), false);
    assert.equal(await exists(join(f.config.converted!, "valid.cbz")), false);
    assert.equal(
      f.db.prepare("SELECT kind FROM issues").get()!["kind"],
      "verification_failed",
    );
  } finally {
    failure.mock.restore();
    await f.close();
  }
});

test("a source changed after discovery is deferred and re-inherits its lossy protection", async () => {
  const f = await fixture();
  try {
    await f.book("a-first.cbz");
    const victim = await f.book("b-replaced.cbz", false);
    const protectedSource = await f.book("c-protected.cbz", true, "red-white");
    f.worker.tools = {
      ...f.tools,
      encoder: join(f.dir, "unavailable-encoder"),
    };
    await f.run();
    const priorHash = await hashFile(victim),
      protectedHash = await hashFile(protectedSource);
    f.db
      .prepare(
        "UPDATE archives SET lossy_state='lossy' WHERE path='c-protected.cbz'",
      )
      .run();
    const wrapper = join(f.dir, "replace-during-encoding.mjs"),
      marker = join(f.dir, "replaced-once");
    await fs.writeFile(
      wrapper,
      "#!" +
        process.execPath +
        "\n" +
        "import{existsSync,copyFileSync,writeFileSync}from'node:fs';import{spawnSync}from'node:child_process';" +
        "if(!existsSync(" +
        JSON.stringify(marker) +
        ")){copyFileSync(" +
        JSON.stringify(protectedSource) +
        "," +
        JSON.stringify(victim) +
        ");writeFileSync(" +
        JSON.stringify(marker) +
        ",'done');}" +
        "const result=spawnSync(" +
        JSON.stringify(f.tools.encoder) +
        ",process.argv.slice(2),{stdio:'inherit'});process.exit(result.status??1);",
      { mode: 0o700 },
    );
    f.worker.tools = { ...f.tools, encoder: wrapper };
    await f.run("lossy", "all");
    assert.equal(await hashFile(victim), protectedHash);
    const deferred = f.db
      .prepare(
        "SELECT * FROM archives WHERE path='b-replaced.cbz' AND status<>'missing'",
      )
      .get()!;
    assert.equal(deferred["status"], "deferred");
    assert.equal(
      deferred["fingerprint"],
      priorHash,
      "a stale archive record must not adopt the replacement's identity",
    );
    f.worker.tools = f.tools;
    await f.run("lossy", "all");
    const guarded = f.db
      .prepare(
        "SELECT * FROM archives WHERE path='b-replaced.cbz' AND status<>'missing'",
      )
      .get()!;
    assert.equal(guarded["lossy_state"], "lossy");
    assert.equal(guarded["status"], "blocked");
    assert.equal(await hashFile(victim), protectedHash);
    assert.equal(
      f.db
        .prepare(
          "SELECT count(*) AS n FROM results WHERE path='b-replaced.cbz' AND outcome='optimized'",
        )
        .get()!["n"],
      0,
    );
  } finally {
    await f.close();
  }
});

test("in-place conversion is verified, counted once, and preserves page history", async () => {
  const f = await fixture();
  try {
    const source = await f.book("nested/book.cbz"),
      before = (await fs.stat(source)).size;
    const first = await f.run();
    assert.equal(first["status"], "succeeded");
    assert.equal(first["optimized"], 1);
    const after = await readArchive(source, f.config);
    assert.equal(after.entries[0]!.format, "JPEG XL");
    const stats = totals(f.db, f.library.id);
    assert.equal(stats.archives, 1);
    assert.equal(stats.optimizedPages, 1);
    assert.equal(stats.savedBytes, before - (await fs.stat(source)).size);
    assert.equal(
      f.db.prepare("SELECT mode FROM pages").get()!["mode"],
      "lossless",
    );
    assert.equal((await f.run())["found"], 0);
    assert.equal((await f.run("lossy", "all"))["optimized"], 0);
    assert.equal(totals(f.db, f.library.id).savedBytes, stats.savedBytes);
    assert.deepEqual(
      JSON.parse(
        String(
          f.db
            .prepare(
              "SELECT formats_json FROM snapshots ORDER BY id DESC LIMIT 1",
            )
            .get()!["formats_json"],
        ),
      ),
      { "JPEG XL": 1 },
    );
    verifyDatabase(f.db);
  } finally {
    await f.close();
  }
});

test("routing moves only optimized or corrupt sources and never overwrites a destination", async () => {
  const f = await fixture(true);
  try {
    const optimized = await f.book("nested/smaller.cbz"),
      unchanged = await f.book("metadata.cbz", false),
      collision = await f.book("collision.cbz");
    const collisionHash = await hashFile(collision);
    await fs.writeFile(
      join(f.config.converted!, "collision.cbz"),
      "unrelated destination",
    );
    const invalid = join(f.config.source, "invalid.cbz");
    await fs.writeFile(invalid, "not a zip");
    const invalidHash = await hashFile(invalid);
    await f.run();
    assert.equal(await exists(optimized), false);
    assert.equal(
      await exists(join(f.config.converted!, "nested/smaller.cbz")),
      true,
    );
    assert.equal(await exists(unchanged), true);
    assert.equal(
      await exists(join(f.config.converted!, "metadata.cbz")),
      false,
    );
    assert.equal(await hashFile(collision), collisionHash);
    assert.equal(
      await fs.readFile(join(f.config.converted!, "collision.cbz"), "utf8"),
      "unrelated destination",
    );
    assert.equal(await exists(invalid), false);
    assert.equal(
      await hashFile(join(f.config.quarantine!, "invalid.cbz")),
      invalidHash,
    );
    const rejected = f.db
      .prepare(
        "SELECT * FROM results WHERE path='collision.cbz' AND outcome='failed'",
      )
      .get()!;
    assert.equal(rejected["bytes_saved"], 0);
    assert.equal(rejected["source_size"], rejected["final_size"]);
    assert.ok(totals(f.db, f.library.id).needsAttention >= 2);
    const count = totals(f.db, f.library.id).needsAttention;
    await fs.unlink(join(f.config.converted!, "collision.cbz"));
    await f.run();
    assert.equal(
      totals(f.db, f.library.id).needsAttention,
      count,
      "successful retry does not dismiss accumulated review items",
    );
    assert.equal(
      f.db
        .prepare(
          "SELECT count(*) AS n FROM archives WHERE location='quarantine'",
        )
        .get()!["n"],
      1,
    );
  } finally {
    await f.close();
  }
});

test("lossy protection survives retries and only an accepted conversion establishes lossy history", async () => {
  const f = await fixture(true);
  try {
    const source = await f.book("book.cbz"),
      hash = await hashFile(source);
    f.worker.tools = {
      ...f.tools,
      encoder: join(f.dir, "unavailable-encoder"),
    };
    assert.equal((await f.run("lossy"))["failed"], 1);
    let archive = f.db.prepare("SELECT * FROM archives").get()!;
    assert.equal(archive["lossy_state"], "unprocessed");
    assert.equal(await hashFile(source), hash);
    assert.equal(await exists(join(f.config.quarantine!, "book.cbz")), false);
    f.worker.tools = f.tools;
    f.db.prepare("UPDATE archives SET lossy_state='unknown'").run();
    assert.equal((await f.run("lossy", "all"))["failed"], 1);
    assert.equal(await hashFile(source), hash);
    assert.equal(
      f.db
        .prepare("SELECT outcome FROM results ORDER BY id DESC LIMIT 1")
        .get()!["outcome"],
      "blocked",
    );
    f.db.prepare("UPDATE archives SET lossy_state='lossy'").run();
    assert.equal((await f.run("lossy", "all"))["failed"], 1);
    assert.equal((await f.run("lossless", "all"))["optimized"], 1);
    archive = f.db.prepare("SELECT * FROM archives").get()!;
    assert.equal(archive["lossy_state"], "lossy");
    assert.ok(
      f.db
        .prepare(
          "SELECT 1 FROM issues WHERE kind='lossy_protection' AND state='needs_review'",
        )
        .get(),
    );
  } finally {
    await f.close();
  }
});

test("interrupted destination publication recovers exactly once and rejects a changed source", async () => {
  for (const changed of [false, true]) {
    const f = await fixture(true);
    const originalUnlink = fs.unlink;
    try {
      const source = await f.book("book.cbz");
      fs.unlink = async (path) => {
        if (String(path) === source)
          throw Object.assign(new Error("simulated removal failure"), {
            code: "EACCES",
          });
        return originalUnlink(path);
      };
      const run = await f.run();
      assert.equal(run["status"], "interrupted");
      assert.equal(run["checked"], 0);
      assert.equal(await exists(source), true);
      assert.equal(await exists(join(f.config.converted!, "book.cbz")), true);
      assert.equal(
        f.db.prepare("SELECT count(*) AS n FROM transfers").get()!["n"],
        1,
      );
      fs.unlink = originalUnlink;
      if (changed) await fs.appendFile(source, "changed");
      const blocked = await recoverTransfers(f.db, f.config);
      if (changed) {
        assert.ok(blocked.has(source));
        assert.equal(await exists(source), true);
        assert.equal(
          f.db.prepare("SELECT count(*) AS n FROM results").get()!["n"],
          0,
        );
      } else {
        assert.equal(blocked.size, 0);
        assert.equal(await exists(source), false);
        await recoverTransfers(f.db, f.config);
        assert.equal(
          f.db.prepare("SELECT count(*) AS n FROM results").get()!["n"],
          1,
        );
        assert.equal(
          f.db.prepare("SELECT checked FROM runs").get()!["checked"],
          1,
        );
        assert.equal(totals(f.db, f.library.id).archives, 1);
      }
      verifyDatabase(f.db);
    } finally {
      fs.unlink = originalUnlink;
      await f.close();
    }
  }
});

test("cancellation terminates codec work without replacing the source and restart preserves queued jobs", async () => {
  const f = await fixture();
  try {
    const source = await f.book("book.cbz"),
      hash = await hashFile(source),
      slow = join(f.dir, "slow-encoder");
    await fs.writeFile(slow, "#!/bin/sh\nsleep 30\n", { mode: 0o700 });
    f.worker.tools = { ...f.tools, encoder: slow };
    const id = enqueue(f.db, f.library, parsePolicy({ effort: 1 }), "all");
    f.worker.wake();
    for (
      let i = 0;
      i < 500 && f.worker.current?.stage !== "Converting images";
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(f.worker.current?.stage, "Converting images");
    assert.equal(f.worker.cancel(id), true);
    await f.worker.idle();
    assert.equal(await hashFile(source), hash);
    assert.equal(
      f.db.prepare("SELECT status FROM runs WHERE id=?").get(id)!["status"],
      "cancelled",
    );
    const queued = enqueue(f.db, f.library, parsePolicy({ effort: 1 }), "all");
    await f.worker.initialize();
    assert.equal(
      f.db.prepare("SELECT status FROM runs WHERE id=?").get(queued)!["status"],
      "queued",
    );
    f.worker.tools = f.tools;
    f.worker.wake();
    await f.worker.idle();
    assert.equal(
      f.db.prepare("SELECT status FROM runs WHERE id=?").get(queued)!["status"],
      "succeeded",
    );
  } finally {
    await f.close();
  }
});
