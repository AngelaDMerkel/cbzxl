import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const image = process.argv[2] ?? "cbzxl-migrate:rewrite";
const directory = await mkdtemp(join(tmpdir(), "cbzxl-container-migration-"));
const name = "cbzxl-migrate-test-" + randomUUID().slice(0, 8);
const source = join(directory, "legacy.db");
const db = new DatabaseSync(source);
db.exec(
  "CREATE TABLE converted_archives(path TEXT,original_size INTEGER,final_size INTEGER,status TEXT);INSERT INTO converted_archives VALUES('Book.cbz',1000,700,'processed')",
);
db.close();
function run(...args: string[]) {
  return JSON.parse(
    execFileSync(
      "docker",
      [
        "run",
        "--rm",
        "--read-only",
        "--name",
        name,
        "--user",
        String(process.getuid?.() ?? 1000) +
          ":" +
          String(process.getgid?.() ?? 1000),
        "--mount",
        "type=bind,src=" + directory + ",dst=/config",
        "-e",
        "DB_PATH=/config/new.db",
        image,
        "/config/legacy.db",
        ...args,
      ],
      { encoding: "utf8", timeout: 60000, maxBuffer: 1024 * 1024 },
    ),
  );
}
try {
  assert.equal(run("--dry-run").status, "dry_run");
  await stat(source);
  assert.equal(run().status, "completed");
  await assert.rejects(stat(source));
  const report = JSON.parse(
    await readFile(join(directory, "new.db.migration.json"), "utf8"),
  );
  assert.equal(report.sourceRemoved, true);
  assert.equal(run().sourceRemoved, true);
  const target = new DatabaseSync(join(directory, "new.db"), {
    readOnly: true,
  });
  assert.equal(
    target.prepare("SELECT count(*) AS n FROM archives").get()!["n"],
    1,
  );
  target.close();
  assert.equal(
    execFileSync(
      "docker",
      ["ps", "-a", "--filter", "name=" + name, "--format", "{{.ID}}"],
      { encoding: "utf8" },
    ).trim(),
    "",
  );
  console.log(
    "Migration container: dry run, import, source cleanup, repeat run and automatic removal passed.",
  );
} finally {
  try {
    execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
  } catch {}
  await rm(directory, { recursive: true, force: true });
}
