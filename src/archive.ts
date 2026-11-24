import yauzl from "yauzl";
import yazl from "yazl";
import { crc32 } from "node:zlib";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { Transform, Writable, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { relativePath } from "./files.ts";
import type { Config } from "./config.ts";

export type Format =
  | "JPEG"
  | "PNG"
  | "TIFF"
  | "BMP"
  | "JPEG XL"
  | "WebP"
  | "GIF"
  | "Other";
export type Formats = Partial<Record<Format, number>>;
export class ArchiveError extends Error {
  kind: "invalid" | "unsupported" | "resource" | "changed" | "verification";
  constructor(kind: ArchiveError["kind"], message: string) {
    super(message);
    this.name = "ArchiveError";
    this.kind = kind;
  }
}
export interface ArchiveEntry {
  name: string;
  path?: string;
  directory: boolean;
  size: number;
  hash: string;
  format: Format;
  mtime: Date;
  mode: number;
  compressed: boolean;
  comment: string;
}
export interface ArchiveContents {
  entries: ArchiveEntry[];
  formats: Formats;
  comment: string;
}

export function imageFormat(header: Buffer): Format {
  if (header.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return "JPEG";
  if (
    header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "PNG";
  if (
    header.subarray(0, 4).equals(Buffer.from([73, 73, 42, 0])) ||
    header.subarray(0, 4).equals(Buffer.from([77, 77, 0, 42])) ||
    header.subarray(0, 4).equals(Buffer.from([73, 73, 43, 0])) ||
    header.subarray(0, 4).equals(Buffer.from([77, 77, 0, 43]))
  )
    return "TIFF";
  if (header.subarray(0, 2).toString() === "BM") return "BMP";
  if (
    header.subarray(0, 2).equals(Buffer.from([255, 10])) ||
    header
      .subarray(0, 12)
      .equals(Buffer.from([0, 0, 0, 12, 74, 88, 76, 32, 13, 10, 135, 10]))
  )
    return "JPEG XL";
  if (
    header.subarray(0, 4).toString() === "RIFF" &&
    header.subarray(8, 12).toString() === "WEBP"
  )
    return "WebP";
  if (["GIF87a", "GIF89a"].includes(header.subarray(0, 6).toString()))
    return "GIF";
  return "Other";
}
const extensions: Record<Format, string> = {
  JPEG: ".jpg",
  PNG: ".png",
  TIFF: ".tif",
  BMP: ".bmp",
  "JPEG XL": ".jxl",
  WebP: ".webp",
  GIF: ".gif",
  Other: ".bin",
};

export async function readArchive(
  path: string,
  config: Config,
  signal?: AbortSignal,
  destination?: string,
): Promise<ArchiveContents> {
  let zip: yauzl.ZipFile | undefined;
  try {
    zip = await yauzl.openPromise(path, {
      autoClose: false,
      validateEntrySizes: true,
      strictFileNames: true,
    });
    if (zip.entryCount > config.maxEntries)
      throw new ArchiveError("resource", "Archive exceeds the entry limit");
    if (destination) await mkdir(destination, { recursive: true });
    const entries: ArchiveEntry[] = [],
      names = new Set<string>();
    const formats: Formats = {};
    let expanded = 0;
    for await (const entry of zip.eachEntry()) {
      signal?.throwIfAborted();
      if (entries.length >= config.maxEntries)
        throw new ArchiveError("resource", "Archive exceeds the entry limit");
      const directory = entry.fileName.endsWith("/");
      const name = directory ? entry.fileName.slice(0, -1) : entry.fileName;
      try {
        relativePath(name);
      } catch {
        throw new ArchiveError(
          "invalid",
          "Archive contains an unsafe entry path",
        );
      }
      if (names.has(name))
        throw new ArchiveError(
          "invalid",
          "Archive contains duplicate entry names",
        );
      names.add(name);
      const type = (entry.externalFileAttributes >>> 16) & 0o170000;
      if (type && type !== (directory ? 0o040000 : 0o100000))
        throw new ArchiveError(
          "invalid",
          "Archive contains a symbolic link or special file",
        );
      if (!entry.canDecodeFileData())
        throw new ArchiveError(
          "unsupported",
          "Encrypted or unsupported ZIP compression; original kept",
        );
      expanded += entry.uncompressedSize;
      if (!Number.isSafeInteger(expanded) || expanded > config.maxArchiveBytes)
        throw new ArchiveError(
          "resource",
          "Archive exceeds the expanded-size limit",
        );
      const record: ArchiveEntry = {
        name,
        directory,
        size: 0,
        hash: "",
        format: "Other",
        mtime: entry.getLastModDate(),
        mode: entry.externalFileAttributes >>> 16 || 0o100644,
        compressed: entry.compressionMethod !== 0,
        comment: entry.fileComment,
      };
      if (directory) {
        if (entry.uncompressedSize !== 0 || entry.crc32 !== 0)
          throw new ArchiveError(
            "invalid",
            "Directory entry contains unexpected data",
          );
        entries.push(record);
        continue;
      }
      const input = await zip.openReadStreamPromise(entry);
      let checksum = 0,
        bytes = 0,
        header = Buffer.alloc(0);
      const hash = createHash("sha256");
      const inspect = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          bytes += chunk.length;
          if (
            bytes > entry.uncompressedSize ||
            bytes > config.maxArchiveBytes
          ) {
            done(
              new ArchiveError(
                "invalid",
                "Archive entry exceeds its declared size",
              ),
            );
            return;
          }
          checksum = crc32(chunk, checksum);
          hash.update(chunk);
          if (header.length < 32)
            header = Buffer.concat([
              header,
              chunk.subarray(0, 32 - header.length),
            ]);
          done(null, chunk);
        },
      });
      const outputPath = destination
        ? join(destination, String(entries.length) + ".input")
        : undefined;
      const output = outputPath
        ? createWriteStream(outputPath, { flags: "wx", mode: 0o600 })
        : new Writable({
            write(_chunk, _encoding, done) {
              done();
            },
          });
      await pipeline(input, inspect, output, { signal });
      if (bytes !== entry.uncompressedSize || checksum !== entry.crc32 >>> 0)
        throw new ArchiveError(
          "invalid",
          "Archive CRC or size verification failed for " + name,
        );
      record.size = bytes;
      record.hash = hash.digest("hex");
      record.format = imageFormat(header);
      if (outputPath) {
        record.path = join(
          destination!,
          String(entries.length) + extensions[record.format],
        );
        await rename(outputPath, record.path);
      }
      if (
        record.format !== "Other" ||
        /\.(jpe?g|png|tiff?|bmp|jxl|webp|gif)$/i.test(name)
      )
        formats[record.format] = (formats[record.format] ?? 0) + 1;
      entries.push(record);
    }
    return { entries, formats, comment: zip.comment };
  } catch (error) {
    if (
      error instanceof ArchiveError ||
      (error as Error).name === "AbortError" ||
      (error as NodeJS.ErrnoException).code?.startsWith("E")
    )
      throw error;
    throw new ArchiveError(
      "invalid",
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    zip?.close();
  }
}

export async function writeArchive(
  path: string,
  entries: ArchiveEntry[],
  comment: string,
  signal?: AbortSignal,
): Promise<void> {
  const zip = new yazl.ZipFile();
  const output = zip.outputStream as Readable;
  const completed = pipeline(
    output,
    createWriteStream(path, { flags: "wx", mode: 0o600 }),
    { signal },
  );
  zip.on("error", (error) => output.destroy(error));
  try {
    for (const entry of entries) {
      signal?.throwIfAborted();
      const options = {
        mtime: entry.mtime,
        mode: (entry.directory ? 0o040000 : 0o100000) | (entry.mode & 0o777),
        compress: entry.compressed,
        fileComment: entry.comment,
      };
      if (entry.directory) zip.addEmptyDirectory(entry.name, options);
      else {
        if (!entry.path) throw new Error("Archive entry has no workspace file");
        zip.addFile(entry.path, entry.name, options);
      }
    }
    zip.end({ comment, forceZip64Format: false });
    await completed;
  } catch (error) {
    output.destroy(error as Error);
    await completed.catch(() => {});
    throw error;
  }
}

export async function verifyArchive(
  path: string,
  expected: ArchiveEntry[],
  config: Config,
  signal?: AbortSignal,
): Promise<ArchiveContents> {
  const actual = await readArchive(path, config, signal);
  if (actual.entries.length !== expected.length)
    throw new ArchiveError(
      "verification",
      "Rebuilt archive lost or added entries",
    );
  const byName = new Map(expected.map((entry) => [entry.name, entry]));
  for (const entry of actual.entries) {
    const original = byName.get(entry.name);
    if (
      !original ||
      entry.directory !== original.directory ||
      (!entry.directory &&
        (entry.hash !== original.hash || entry.size !== original.size))
    )
      throw new ArchiveError(
        "verification",
        "Rebuilt archive content verification failed",
      );
  }
  if (!(await stat(path)).isFile())
    throw new ArchiveError("verification", "Rebuilt archive is unavailable");
  return actual;
}
