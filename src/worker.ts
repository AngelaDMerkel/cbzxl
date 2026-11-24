import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  opendir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, relative } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  ArchiveError,
  readArchive,
  verifyArchive,
  writeArchive,
} from "./archive.ts";
import { convertPage } from "./codec.ts";
import type { Tools } from "./codec.ts";
import { contains, parsePolicy } from "./config.ts";
import type { Config } from "./config.ts";
import { hashFile, identity, safePath, sameIdentity } from "./files.ts";
import { json, now, transaction } from "./database.ts";
import {
  activeLibrary,
  addIssue,
  archiveAt,
  archiveById,
  inheritedProtection,
  nextRun,
  recordOutcome,
  snapshot,
} from "./library.ts";
import type {
  Archive,
  ArchiveUpdate,
  Library,
  Location,
  Outcome,
  Run,
} from "./library.ts";
import { publish, recoverTransfers, unchanged } from "./transfers.ts";

export interface Progress {
  runId: string;
  stage: string;
  total: number;
  checked: number;
  fraction: number;
  startedAt: number;
}
interface Discovered {
  path: string;
  location: Location;
  absolute: string;
}
const imageName = /\.(jpe?g|png|tiff?|bmp|jxl|webp|gif|avif|heic|jp2)$/i;

export class Worker {
  db: DatabaseSync;
  config: Config;
  tools: Tools;
  current: Progress | null = null;
  error: string | null = null;
  private task: Promise<void> | null = null;
  private abort: AbortController | null = null;
  private closing = false;

  constructor(db: DatabaseSync, config: Config, tools: Tools) {
    this.db = db;
    this.config = config;
    this.tools = tools;
  }

  async initialize(): Promise<void> {
    this.db
      .prepare(
        "UPDATE runs SET status='interrupted',finished_at=?,error='Application stopped before this run completed' WHERE status IN ('running','stopping')",
      )
      .run(now());
    await recoverTransfers(this.db, this.config);
    await mkdir(this.config.scratch, { recursive: true });
    for await (const entry of await opendir(this.config.scratch)) {
      if (!entry.name.startsWith("archive-") || !entry.isDirectory()) continue;
      const path = join(this.config.scratch, entry.name);
      try {
        if (
          (await readFile(join(path, ".cbzxl-workspace"), "utf8")) === "cbzxl-6"
        )
          await rm(path, { recursive: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  wake(): void {
    if (this.task || this.closing) return;
    let failed = false;
    this.task = this.drain()
      .catch((error) => {
        failed = true;
        this.error = error instanceof Error ? error.message : String(error);
        console.error(this.error);
      })
      .finally(() => {
        this.task = null;
        if (
          !failed &&
          !this.closing &&
          this.db
            .prepare("SELECT 1 FROM runs WHERE status='queued' LIMIT 1")
            .get()
        )
          this.wake();
      });
  }
  async idle(): Promise<void> {
    while (this.task) await this.task;
  }
  cancel(id: string): boolean {
    const row = this.db
      .prepare(
        "UPDATE runs SET cancel_requested=1,status=CASE WHEN status='queued' THEN 'cancelled' ELSE 'stopping' END,finished_at=CASE WHEN status='queued' THEN ? ELSE finished_at END WHERE id=? AND status IN ('queued','running','stopping')",
      )
      .run(now(), id);
    if (this.current?.runId === id) this.abort?.abort();
    return Number(row.changes) > 0;
  }
  async close(): Promise<void> {
    this.closing = true;
    this.abort?.abort();
    await this.idle();
  }

  private async drain(): Promise<void> {
    while (!this.closing) {
      const run = nextRun(this.db);
      if (!run) return;
      this.abort = new AbortController();
      this.error = null;
      this.current = {
        runId: run.id,
        stage: "Scanning library",
        total: 0,
        checked: 0,
        fraction: 0,
        startedAt: Date.now(),
      };
      try {
        await this.execute(run, this.abort.signal);
        const result = this.db
          .prepare("SELECT failed FROM runs WHERE id=?")
          .get(run.id)!;
        this.db
          .prepare("UPDATE runs SET status=?,finished_at=? WHERE id=?")
          .run(
            Number(result["failed"]) ? "partial" : "succeeded",
            now(),
            run.id,
          );
      } catch (error) {
        const cancelled = this.abort.signal.aborted;
        const message = error instanceof Error ? error.message : String(error);
        this.db
          .prepare("UPDATE runs SET status=?,finished_at=?,error=? WHERE id=?")
          .run(cancelled ? "cancelled" : "interrupted", now(), message, run.id);
        if (!cancelled) this.error = message;
      } finally {
        try {
          snapshot(this.db, run.library_id);
        } catch (error) {
          console.error("Snapshot failed: " + String(error));
        }
        this.current = null;
        this.abort = null;
      }
    }
  }

  private async discover(signal: AbortSignal): Promise<Discovered[]> {
    const found: Discovered[] = [];
    const roots: [Location, string | undefined][] = [
      ["source", this.config.source],
      ["converted", this.config.converted],
    ];
    for (const [location, root] of roots) {
      if (!root) continue;
      const walk = async (directory: string): Promise<void> => {
        signal.throwIfAborted();
        for await (const entry of await opendir(directory)) {
          signal.throwIfAborted();
          const path = join(directory, entry.name);
          if (entry.isSymbolicLink()) continue;
          if (
            location === "source" &&
            [this.config.converted, this.config.quarantine].some(
              (excluded) => excluded && contains(excluded, path),
            )
          )
            continue;
          if (entry.isDirectory()) await walk(path);
          else if (entry.isFile() && /\.cbz$/i.test(entry.name))
            found.push({
              path: relative(root, path).replaceAll("\\", "/"),
              location,
              absolute: path,
            });
        }
      };
      await walk(root);
    }
    return found.sort(
      (a, b) =>
        a.path.localeCompare(b.path) || a.location.localeCompare(b.location),
    );
  }

  private async index(
    library: Library,
    file: Discovered,
    signal: AbortSignal,
  ): Promise<{ archive: Archive; changed: boolean }> {
    const root =
      file.location === "source" ? this.config.source : this.config.converted!;
    const path = await safePath(root, file.path);
    const stamp = await identity(path),
      stored = archiveAt(this.db, library.id, file.location, file.path);
    if (
      stored?.identity_json &&
      sameIdentity(JSON.parse(stored.identity_json), stamp)
    )
      return { archive: stored, changed: false };
    const fingerprint = await hashFile(path, signal);
    await unchanged(path, stamp, fingerprint);
    if (
      stored &&
      (stored.fingerprint === fingerprint ||
        (!stored.fingerprint && stored.size === stamp.size))
    ) {
      this.db
        .prepare(
          "UPDATE archives SET fingerprint=?,identity_json=?,mtime_ms=?,size=? WHERE id=?",
        )
        .run(
          fingerprint,
          json(stamp),
          Number(stamp.mtime) / 1e6,
          stamp.size,
          stored.id,
        );
      return {
        archive: archiveById(this.db, stored.id)!,
        changed: !stored.format_counts,
      };
    }
    const protection = inheritedProtection(
      this.db,
      library.id,
      file.path,
      fingerprint,
    );
    const id = randomUUID();
    transaction(this.db, () => {
      if (stored)
        this.db
          .prepare(
            "UPDATE archives SET status='missing',updated_at=? WHERE id=?",
          )
          .run(now(), stored.id);
      this.db
        .prepare(
          "INSERT INTO archives(id,library_id,path,location,status,baseline_size,size,fingerprint,identity_json,mtime_ms,lossy_state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          id,
          library.id,
          file.path,
          file.location,
          "new",
          file.location === "source" ? stamp.size : null,
          stamp.size,
          fingerprint,
          json(stamp),
          Number(stamp.mtime) / 1e6,
          file.location === "converted" && protection === "unprocessed"
            ? "unknown"
            : protection,
          now(),
          now(),
        );
    });
    return { archive: archiveById(this.db, id)!, changed: true };
  }

  private async execute(run: Run, signal: AbortSignal): Promise<void> {
    const library = activeLibrary(this.db, this.config.source);
    if (library.id !== run.library_id || !library.enabled)
      throw new Error("The queued library is no longer active");
    const blocked = await recoverTransfers(this.db, this.config);
    const files = await this.discover(signal),
      seen = new Set<string>();
    const candidates: Archive[] = [];
    for (const file of files) {
      signal.throwIfAborted();
      if (blocked.has(file.absolute)) continue;
      const indexed = await this.index(library, file, signal);
      seen.add(indexed.archive.id);
      const eligible = run.archive_id
        ? indexed.archive.id === run.archive_id
        : file.location === "source"
          ? run.scope === "all" ||
            indexed.changed ||
            !["optimized", "retained", "unchanged"].includes(
              indexed.archive.status,
            )
          : indexed.changed || !indexed.archive.format_counts;
      if (eligible) candidates.push(indexed.archive);
    }
    transaction(this.db, () => {
      for (const row of this.db
        .prepare(
          "SELECT id,path,location FROM archives WHERE library_id=? AND status<>'missing' AND location<>'quarantine'",
        )
        .all(library.id)) {
        const root =
          row["location"] === "source"
            ? this.config.source
            : this.config.converted;
        if (
          root &&
          !seen.has(String(row["id"])) &&
          !blocked.has(join(root, String(row["path"])))
        )
          this.db
            .prepare(
              "UPDATE archives SET status='missing',updated_at=? WHERE id=?",
            )
            .run(now(), row["id"]!);
      }
      this.db
        .prepare("UPDATE runs SET found=? WHERE id=?")
        .run(candidates.length, run.id);
    });
    if (run.archive_id && !candidates.length)
      throw new Error(
        "The selected archive is unavailable or has an unresolved transfer",
      );
    snapshot(this.db, library.id);
    this.current!.total = candidates.length;
    for (const archive of candidates) {
      signal.throwIfAborted();
      this.current!.fraction = 0;
      await this.process(run, archive, signal);
      this.current!.checked = Number(
        this.db.prepare("SELECT checked FROM runs WHERE id=?").get(run.id)![
          "checked"
        ],
      );
    }
  }

  private async process(
    run: Run,
    archive: Archive,
    signal: AbortSignal,
  ): Promise<void> {
    const policy = parsePolicy(JSON.parse(run.policy_json), this.config.effort);
    const root =
      archive.location === "source"
        ? this.config.source
        : this.config.converted!;
    const source = await safePath(root, archive.path);
    const sourceIdentity = await identity(source);
    const sourceHash = await hashFile(source, signal);
    const outcome: Outcome = {
      runId: run.id,
      archiveId: archive.id,
      path: archive.path,
      outcome: "failed",
      mode: policy.mode,
      sourceSize: sourceIdentity.size,
      finalSize: sourceIdentity.size,
      bytesSaved: 0,
      pages: [],
    };
    let workspace: string | undefined;
    try {
      if (
        !archive.identity_json ||
        !archive.fingerprint ||
        !sameIdentity(JSON.parse(archive.identity_json), sourceIdentity) ||
        archive.fingerprint !== sourceHash
      )
        throw new ArchiveError(
          "changed",
          "Archive changed after discovery; scan it again before processing",
        );
      if (
        Date.now() - Number(sourceIdentity.mtime) / 1e6 <
        this.config.stableSeconds * 1000
      )
        throw new ArchiveError(
          "changed",
          "Archive is not yet stable; try again after it finishes changing",
        );
      if (sourceIdentity.size > this.config.maxArchiveBytes)
        throw new ArchiveError(
          "resource",
          "Archive exceeds the configured size limit",
        );
      workspace = await mkdtemp(join(this.config.scratch, "archive-"));
      await writeFile(join(workspace, ".cbzxl-workspace"), "cbzxl-6");
      this.current!.stage = "Validating archives";
      const contents = await readArchive(
        source,
        this.config,
        signal,
        join(workspace, "input"),
      );
      await unchanged(source, sourceIdentity, sourceHash);
      const pages = contents.entries.filter(
        (entry) =>
          !entry.directory &&
          (entry.format !== "Other" || imageName.test(entry.name)),
      );
      const inventoryOnly = archive.location === "converted" && !run.archive_id;
      const eligible = pages.filter((entry) =>
        ["JPEG", "PNG", "TIFF", "BMP"].includes(entry.format),
      );
      if (
        !inventoryOnly &&
        eligible.length &&
        policy.mode === "lossy" &&
        ["lossy", "unknown"].includes(archive.lossy_state)
      ) {
        throw Object.assign(
          new Error(
            "Lossy conversion is blocked by this archive’s conversion history",
          ),
          { kind: "lossy_protection" },
        );
      }
      const names = new Set(contents.entries.map((entry) => entry.name));
      const rewritten = contents.entries.slice();
      for (const [index, entry] of contents.entries.entries()) {
        signal.throwIfAborted();
        if (entry.directory || !pages.includes(entry)) continue;
        this.current!.stage = inventoryOnly
          ? "Indexing converted archives"
          : "Converting images";
        this.current!.fraction = index / Math.max(1, contents.entries.length);
        if (inventoryOnly) {
          outcome.pages.push({
            entry: entry.name,
            outputEntry: entry.name,
            sourceFormat: entry.format,
            sourceSize: entry.size,
            finalSize: entry.size,
            outcome: "unchanged",
          });
          continue;
        }
        const targetName = entry.name.replace(/\.[^/.]+$/, "") + ".jxl";
        if (
          eligible.includes(entry) &&
          targetName !== entry.name &&
          names.has(targetName)
        )
          throw new ArchiveError(
            "unsupported",
            "Output page name would collide with an existing entry: " +
              targetName,
          );
        if (entry.format === "Other" && imageName.test(entry.name))
          throw new ArchiveError(
            "unsupported",
            "Image format could not be identified: " + entry.name,
          );
        const converted = await convertPage(
          entry,
          join(workspace, "page-" + index + ".jxl"),
          policy,
          this.tools,
          this.config,
          signal,
        );
        if (converted.result.outcome === "failed")
          throw new ArchiveError(
            "unsupported",
            converted.result.reason ?? "Image needs review",
          );
        rewritten[index] = converted.entry;
        outcome.pages.push(converted.result);
        if (converted.result.outcome === "converted") {
          names.delete(entry.name);
          names.add(converted.entry.name);
        }
      }
      const converted = outcome.pages.filter(
        (page) => page.outcome === "converted",
      ).length;
      const update: ArchiveUpdate = {
        location: archive.location,
        status: "unchanged",
        size: sourceIdentity.size,
        fingerprint: sourceHash,
        identityJson: json(sourceIdentity),
        lossyState: archive.lossy_state,
        convertedPages: archive.converted_pages,
        formats: contents.formats,
      };
      if (!converted) {
        outcome.outcome = outcome.pages.some(
          (page) => page.outcome === "retained",
        )
          ? "retained"
          : "unchanged";
        update.status = outcome.outcome;
        await unchanged(source, sourceIdentity, sourceHash);
        transaction(this.db, () => recordOutcome(this.db, outcome, update));
        return;
      }
      this.current!.stage = "Verifying rebuilt archives";
      const candidate = join(workspace, "candidate.cbz");
      await writeArchive(candidate, rewritten, contents.comment, signal);
      const checked = await verifyArchive(
        candidate,
        rewritten,
        this.config,
        signal,
      );
      const size = (await identity(candidate)).size;
      if (size >= sourceIdentity.size) {
        outcome.outcome = "retained";
        update.status = "retained";
        outcome.pages = outcome.pages.map((page) =>
          page.outcome === "converted"
            ? {
                ...page,
                outcome: "retained",
                outputEntry: page.entry,
                finalSize: page.sourceSize,
                reason: "Rebuilt archive was not smaller",
              }
            : page,
        );
        await unchanged(source, sourceIdentity, sourceHash);
        transaction(this.db, () => recordOutcome(this.db, outcome, update));
        return;
      }
      signal.throwIfAborted();
      outcome.outcome = "optimized";
      outcome.finalSize = size;
      outcome.bytesSaved = sourceIdentity.size - size;
      update.status = "optimized";
      update.size = size;
      update.fingerprint = await hashFile(candidate, signal);
      update.formats = checked.formats;
      update.convertedPages += converted;
      if (update.lossyState !== "lossy" && update.lossyState !== "unknown")
        update.lossyState = policy.mode === "lossy" ? "lossy" : "lossless";
      const destination =
        this.config.converted && archive.location === "source"
          ? await safePath(this.config.converted, archive.path, true)
          : source;
      update.location =
        this.config.converted && archive.location === "source"
          ? "converted"
          : archive.location;
      this.current!.stage = "Saving verified results";
      await publish(
        this.db,
        source,
        destination,
        candidate,
        sourceIdentity,
        sourceHash,
        { outcome, update },
      );
    } catch (error) {
      if (signal.aborted) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (
        this.db
          .prepare("SELECT 1 FROM transfers WHERE archive_id=?")
          .get(archive.id)
      ) {
        addIssue(this.db, archive.id, "transfer_conflict", message);
        throw error;
      }
      const kind =
        error instanceof ArchiveError
          ? error.kind
          : (error as { kind?: string }).kind;
      outcome.error = message;
      outcome.kind =
        kind === "invalid"
          ? "source_invalid"
          : kind === "changed"
            ? "source_changed"
            : kind === "resource"
              ? "resource_limit"
              : kind === "verification"
                ? "verification_failed"
                : kind === "unsupported"
                  ? "unsupported"
                  : kind === "lossy_protection"
                    ? "lossy_protection"
                    : "processing_failed";
      outcome.outcome =
        kind === "changed"
          ? "deferred"
          : kind === "lossy_protection"
            ? "blocked"
            : "failed";
      outcome.finalSize = outcome.sourceSize;
      outcome.bytesSaved = 0;
      outcome.pages = outcome.pages.map((page) =>
        page.outcome === "converted"
          ? {
              ...page,
              outcome: "retained",
              outputEntry: page.entry,
              finalSize: page.sourceSize,
              reason: "Archive was not replaced",
            }
          : page,
      );
      if (kind === "changed") {
        transaction(this.db, () => {
          this.db
            .prepare(
              "UPDATE archives SET status='deferred',format_counts=NULL,updated_at=? WHERE id=?",
            )
            .run(now(), archive.id);
          recordOutcome(this.db, outcome);
        });
        return;
      }
      const update: ArchiveUpdate = {
        location: archive.location,
        status: outcome.outcome,
        size: sourceIdentity.size,
        fingerprint: sourceHash,
        identityJson: json(sourceIdentity),
        lossyState: archive.lossy_state,
        convertedPages: archive.converted_pages,
        formats: null,
      };
      if (
        kind === "invalid" &&
        archive.location === "source" &&
        this.config.quarantine
      ) {
        try {
          const destination = await safePath(
            this.config.quarantine,
            archive.path,
            true,
          );
          outcome.outcome = "quarantined";
          update.location = "quarantine";
          update.status = "quarantined";
          await publish(
            this.db,
            source,
            destination,
            source,
            sourceIdentity,
            sourceHash,
            { outcome, update },
          );
        } catch (moveError) {
          if (
            this.db
              .prepare("SELECT 1 FROM transfers WHERE archive_id=?")
              .get(archive.id)
          )
            throw moveError;
          outcome.outcome = "failed";
          update.location = archive.location;
          update.status = "failed";
          outcome.error += "; Quarantine failed: " + String(moveError);
          transaction(this.db, () => recordOutcome(this.db, outcome, update));
        }
      } else
        transaction(this.db, () => recordOutcome(this.db, outcome, update));
    } finally {
      if (workspace)
        await rm(workspace, { recursive: true, force: true }).catch((error) =>
          console.warn("Workspace cleanup failed: " + String(error)),
        );
    }
  }
}
