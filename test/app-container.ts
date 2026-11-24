import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const image = process.argv[2] ?? "cbzxl:rewrite";
const directory = await mkdtemp(join(tmpdir(), "cbzxl-container-app-"));
const name = "cbzxl-app-test-" + randomUUID().slice(0, 8);
const user =
  String(process.getuid?.() ?? 1000) + ":" + String(process.getgid?.() ?? 1000);
const docker = (...args: string[]) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    timeout: 90000,
    maxBuffer: 1024 * 1024,
  }).trim();
const headers = {
  Authorization: "Bearer synthetic-test-token",
  "Content-Type": "application/json",
  "X-CBZXL-Request": "1",
};
async function waitFor<T>(
  fn: () => Promise<T | undefined>,
  seconds = 30,
): Promise<T> {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    const result = await fn();
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Container readiness or job completion timed out");
}
async function start() {
  docker(
    "run",
    "--rm",
    "--detach",
    "--name",
    name,
    "--user",
    user,
    "--read-only",
    "--tmpfs",
    "/tmp:size=128m",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--mount",
    "type=bind,src=" + directory + ",dst=/qa",
    "-p",
    "127.0.0.1::5000",
    "-e",
    "SOURCE_DIR=/qa/library/source",
    "-e",
    "CONVERTED_DIR=/qa/library/converted",
    "-e",
    "QUARANTINE_DIR=/qa/library/quarantine",
    "-e",
    "DB_PATH=/qa/config/app.sqlite3",
    "-e",
    "SCRATCH_DIR=/qa/work",
    "-e",
    "ENCODER_EFFORT=1",
    "-e",
    "ARCHIVE_STABLE_SECONDS=0",
    "-e",
    "API_TOKEN=synthetic-test-token",
    image,
  );
  const address = docker("port", name, "5000/tcp");
  assert.match(address, /^127\.0\.0\.1:\d+$/);
  const base = "http://" + address;
  await waitFor(async () => {
    try {
      return (
        await fetch(base + "/health", { signal: AbortSignal.timeout(1000) })
      ).ok
        ? true
        : undefined;
    } catch {
      return undefined;
    }
  });
  return base;
}
try {
  for (const folder of [
    "library/source",
    "library/converted",
    "library/quarantine",
    "config",
    "work",
  ])
    await mkdir(join(directory, folder), { recursive: true });
  const program =
    "import {execFileSync} from 'node:child_process';import {writeFile,stat} from 'node:fs/promises';import {writeArchive} from './src/archive.ts';import {hashFile} from './src/files.ts';import {configFromEnv} from './src/config.ts';import {findTools} from './src/codec.ts';" +
    "const config=configFromEnv({SOURCE_DIR:'/qa/library/source',SCRATCH_DIR:'/tmp',CPU_LIMIT:'1'}),tools=await findTools(config);execFileSync(tools.imagemagick,['-size','256x256','gradient:blue-white','-depth','8','/tmp/page.bmp']);" +
    "for(const image of [true,false]){const path=image?'/tmp/page.bmp':'/tmp/ComicInfo.xml';if(!image)await writeFile(path,'<ComicInfo>Retain unchanged</ComicInfo>');await writeArchive('/qa/library/source/'+(image?'book':'metadata')+'.cbz',[{name:image?'01.bmp':'ComicInfo.xml',path,directory:false,size:(await stat(path)).size,hash:await hashFile(path),format:image?'BMP':'Other',mtime:new Date(),mode:33188,compressed:false,comment:''}],'');}await writeFile('/qa/library/source/corrupt.cbz','synthetic corrupt archive');";
  docker(
    "run",
    "--rm",
    "--read-only",
    "--user",
    user,
    "--tmpfs",
    "/tmp:size=128m",
    "--mount",
    "type=bind,src=" + directory + ",dst=/qa",
    "--entrypoint",
    "node",
    image,
    "--input-type=module",
    "-e",
    program,
  );
  const originalSize = (await stat(join(directory, "library/source/book.cbz")))
    .size;
  let base = await start();
  assert.equal((await fetch(base + "/api/overview")).status, 401);
  assert.equal((await fetch(base + "/")).status, 200);
  assert.equal((await fetch(base + "/app.js")).status, 200);
  const queued = await fetch(base + "/api/runs", {
    method: "POST",
    headers,
    body: "{}",
  });
  assert.equal(queued.status, 202);
  const completed = await waitFor(async () => {
    const data = await (
      await fetch(base + "/api/overview", { headers })
    ).json();
    return data.previous && !data.current ? data : undefined;
  });
  assert.equal(completed.previous.status, "partial");
  assert.equal(completed.previous.optimized, 1);
  assert.equal(completed.previous.failed, 1);
  assert.equal(completed.totals.archives, 2);
  assert.equal(completed.totals.needsAttention, 1);
  assert.equal(
    completed.totals.savedBytes,
    originalSize -
      (await stat(join(directory, "library/converted/book.cbz"))).size,
  );
  await assert.rejects(stat(join(directory, "library/source/book.cbz")));
  assert.equal(
    await readFile(join(directory, "library/quarantine/corrupt.cbz"), "utf8"),
    "synthetic corrupt archive",
  );
  await stat(join(directory, "library/source/metadata.cbz"));
  await assert.rejects(stat(join(directory, "library/converted/metadata.cbz")));
  const trends = await (await fetch(base + "/api/trends", { headers })).json();
  assert.equal(trends.points.at(-1).formats["JPEG XL"], 1);
  docker("stop", "--time", "10", name);
  base = await start();
  const restarted = await (
    await fetch(base + "/api/overview", { headers })
  ).json();
  assert.equal(restarted.totals.savedBytes, completed.totals.savedBytes);
  assert.equal(restarted.totals.needsAttention, 1);
  assert.equal(docker("exec", name, "id", "-u"), user.split(":")[0]);
  console.log(
    "App container: authenticated HTTP, real conversion, directory routing, unchanged retention, durable statistics, review history, and restart passed.",
  );
} catch (error) {
  try {
    console.error(docker("logs", name));
  } catch {}
  throw error;
} finally {
  try {
    execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
  } catch {}
  await rm(directory, { recursive: true, force: true });
}
