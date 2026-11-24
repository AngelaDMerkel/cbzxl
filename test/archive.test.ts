import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configFromEnv } from "../src/config.ts";
import {
  ArchiveError,
  imageFormat,
  readArchive,
  verifyArchive,
  writeArchive,
} from "../src/archive.ts";
import type { ArchiveEntry, Format } from "../src/archive.ts";
import { convertPage, findTools } from "../src/codec.ts";
import { hashFile } from "../src/files.ts";

test("real codecs preserve lossless JPEG, PNG, TIFF and BMP and never encode existing JXL", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cbzxl-codecs-"));
  const config = configFromEnv({
    SOURCE_DIR: dir,
    SCRATCH_DIR: join(dir, "work"),
    CPU_LIMIT: "1",
    ENCODER_EFFORT: "1",
  });
  await mkdir(config.scratch);
  try {
    const tools = await findTools(config);
    for (const [extension, format] of [
      ["jpg", "JPEG"],
      ["png", "PNG"],
      ["tif", "TIFF"],
      ["bmp", "BMP"],
    ] as const) {
      const input = join(dir, "page." + extension),
        output = join(dir, "page-" + extension + ".jxl");
      execFileSync(
        tools.imagemagick,
        ["-size", "256x256", "gradient:#0a2540-#eff8ff", "-depth", "8", input],
        { timeout: 30000 },
      );
      const entry: ArchiveEntry = {
        name: "Book/page." + extension,
        path: input,
        directory: false,
        size: (await stat(input)).size,
        hash: await hashFile(input),
        format,
        mtime: new Date(),
        mode: 0o100644,
        compressed: false,
        comment: "",
      };
      const converted = await convertPage(
        entry,
        output,
        { mode: "lossless", effort: 1, distance: 0 },
        tools,
        config,
      );
      assert.equal(
        converted.result.outcome,
        "converted",
        extension + ": " + converted.result.reason,
      );
      assert.ok(converted.entry.size < entry.size);
      assert.equal(await hashFile(input), entry.hash);
      assert.equal(
        imageFormat((await readFile(output)).subarray(0, 32)),
        "JPEG XL",
      );
      const skipped = await convertPage(
        converted.entry,
        join(dir, "never-created-" + extension),
        { mode: "lossy", effort: 10, distance: 3 },
        tools,
        config,
      );
      assert.equal(skipped.result.outcome, "unchanged");
      await assert.rejects(stat(join(dir, "never-created-" + extension)));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("lossless conversion preserves 16-bit transparency and an embedded ICC profile", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cbzxl-colour-"));
  const config = configFromEnv({
    SOURCE_DIR: dir,
    SCRATCH_DIR: join(dir, "work"),
    CPU_LIMIT: "1",
  });
  await mkdir(config.scratch);
  try {
    const tools = await findTools(config);
    for (const extension of ["png", "tif"]) {
      const input = join(dir, "alpha." + extension);
      execFileSync(
        tools.imagemagick,
        [
          "-size",
          "128x128",
          "gradient:transparent-blue",
          "-depth",
          "16",
          "-profile",
          new URL("./fixtures/srgb.icc", import.meta.url).pathname,
          input,
        ],
        { timeout: 30000 },
      );
      const original = await entry(
        input,
        "alpha." + extension,
        extension === "png" ? "PNG" : "TIFF",
      );
      const result = await convertPage(
        original,
        join(dir, extension + ".jxl"),
        { mode: "lossless", effort: 1, distance: 0 },
        tools,
        config,
      );
      assert.equal(
        result.result.outcome,
        "converted",
        extension + ": " + result.result.reason,
      );
      assert.equal(await hashFile(input), original.hash);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function entry(
  path: string,
  name: string,
  format: Format = "Other",
): Promise<ArchiveEntry> {
  return {
    path,
    name,
    format,
    directory: false,
    size: (await stat(path)).size,
    hash: await hashFile(path),
    mtime: new Date("2026-01-01"),
    mode: 0o100644,
    compressed: false,
    comment: "preserved",
  };
}

test("ZIP round trip preserves all bytes, paths and comments, and detects corruption and unsafe paths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cbzxl-zip-"));
  const config = configFromEnv({
    SOURCE_DIR: dir,
    SCRATCH_DIR: join(dir, "work"),
  });
  try {
    const source = join(dir, "metadata.xml");
    await writeFile(
      source,
      "<ComicInfo><Title>Safe &amp; unchanged</Title></ComicInfo>",
    );
    const entries = [await entry(source, "safe/01.jpg")];
    const archive = join(dir, "book.cbz");
    await writeArchive(archive, entries, "Archive comment");
    const verified = await verifyArchive(archive, entries, config);
    assert.equal(verified.comment, "Archive comment");
    assert.equal(verified.entries[0]!.comment, "preserved");
    const original = await readFile(archive);
    const corrupt = Buffer.from(original),
      central = corrupt.indexOf(Buffer.from([0x50, 0x4b, 1, 2]));
    corrupt[central + 16] = corrupt[central + 16]! ^ 1;
    const bad = join(dir, "crc.cbz");
    await writeFile(bad, corrupt);
    await assert.rejects(
      readArchive(bad, config),
      (error) => error instanceof ArchiveError && error.kind === "invalid",
    );
    const unsafe = Buffer.from(original);
    let offset = unsafe.indexOf("safe/01.jpg");
    while (offset !== -1) {
      Buffer.from("../evil.jpg").copy(unsafe, offset);
      offset = unsafe.indexOf("safe/01.jpg", offset + 1);
    }
    const traversal = join(dir, "unsafe.cbz");
    await writeFile(traversal, unsafe);
    await assert.rejects(
      readArchive(traversal, config),
      (error) => error instanceof ArchiveError && error.kind === "invalid",
    );
    const unsupported = Buffer.from(original);
    unsupported.writeUInt16LE(12, central + 10);
    const compressed = join(dir, "unsupported.cbz");
    await writeFile(compressed, unsupported);
    await assert.rejects(
      readArchive(compressed, config),
      (error) => error instanceof ArchiveError && error.kind === "unsupported",
    );
    await assert.rejects(
      readArchive(archive, { ...config, maxArchiveBytes: 1 }),
      (error) => error instanceof ArchiveError && error.kind === "resource",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
