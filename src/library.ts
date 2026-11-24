import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Policy } from "./config.ts";
import type { Formats } from "./archive.ts";
import type { PageResult } from "./codec.ts";
import type { Identity } from "./files.ts";
import { json, now, setting, setSetting, transaction } from "./database.ts";

export interface Library {
  id: string;
  name: string;
  root_path: string;
  enabled: number;
}
export type Location = "source" | "converted" | "quarantine";
export type LossyState = "unprocessed" | "lossless" | "lossy" | "unknown";
export interface Archive {
  id: string;
  library_id: string;
  path: string;
  location: Location;
  status: string;
  baseline_size: number | null;
  size: number | null;
  fingerprint: string | null;
  identity_json: string | null;
  mtime_ms: number | null;
  lossy_state: LossyState;
  converted_pages: number;
  format_counts: string | null;
  legacy_json: string;
}
export interface Run {
  id: string;
  library_id: string;
  status: string;
  policy_json: string;
  scope: string;
  archive_id: string | null;
  found: number;
  checked: number;
  optimized: number;
  unchanged: number;
  failed: number;
  bytes_saved: number;
  cancel_requested: number;
}
export interface Outcome {
  runId: string;
  archiveId: string;
  path: string;
  outcome: string;
  mode: string | null;
  sourceSize: number;
  finalSize: number;
  bytesSaved: number;
  pages: PageResult[];
  error?: string;
  kind?: string;
}
export interface ArchiveUpdate {
  location: Location;
  status: string;
  size: number;
  fingerprint: string;
  identityJson: string;
  lossyState: LossyState;
  convertedPages: number;
  formats: Formats | null;
}
export interface TransferPayload {
  outcome: Outcome;
  update: ArchiveUpdate;
  stagedIdentity?: Identity;
  sourceIdentity?: Identity;
}

export function activeLibrary(db: DatabaseSync, source: string): Library {
  let library = db
    .prepare("SELECT * FROM libraries WHERE root_path=?")
    .get(source) as unknown as Library | undefined;
  if (library) return library;
  const existing = db
    .prepare("SELECT * FROM libraries")
    .all() as unknown as Library[];
  if (existing.length > 1)
    throw new Error(
      "SOURCE_DIR must match one imported library; use explicit migration path mappings",
    );
  if (existing.length === 1) {
    db.prepare("UPDATE libraries SET root_path=? WHERE id=?").run(
      source,
      existing[0]!.id,
    );
    return { ...existing[0]!, root_path: source };
  }
  const id = randomUUID();
  db.prepare("INSERT INTO libraries(id,name,root_path) VALUES (?,?,?)").run(
    id,
    "Comics",
    source,
  );
  return { id, name: "Comics", root_path: source, enabled: 1 };
}
export function archiveById(db: DatabaseSync, id: string): Archive | undefined {
  return db.prepare("SELECT * FROM archives WHERE id=?").get(id) as unknown as
    | Archive
    | undefined;
}
export function archiveAt(
  db: DatabaseSync,
  library: string,
  location: Location,
  path: string,
): Archive | undefined {
  return db
    .prepare(
      "SELECT * FROM archives WHERE library_id=? AND location=? AND path=? AND status<>'missing'",
    )
    .get(library, location, path) as unknown as Archive | undefined;
}
export function inheritedProtection(
  db: DatabaseSync,
  library: string,
  path: string,
  hash: string,
): LossyState {
  const history = db
    .prepare(
      "SELECT lossy_state FROM archives WHERE library_id=? AND (path=? OR fingerprint=?)",
    )
    .all(library, path, hash);
  if (history.some((row) => row["lossy_state"] === "lossy")) return "lossy";
  if (history.length) return "unknown";
  const orphan = db
    .prepare(
      "SELECT 1 FROM results r LEFT JOIN runs j ON j.id=r.run_id WHERE r.path=? AND (j.library_id=? OR j.library_id IS NULL) LIMIT 1",
    )
    .get(path, library);
  return orphan ? "unknown" : "unprocessed";
}
export function addIssue(
  db: DatabaseSync,
  archiveId: string,
  kind: string,
  message: string,
  details: unknown = {},
): void {
  const previous = db
    .prepare("SELECT id FROM issues WHERE archive_id=? AND kind=? AND state=?")
    .get(archiveId, kind, "needs_review");
  if (previous)
    db.prepare(
      "UPDATE issues SET message=?,updated_at=?,details_json=? WHERE id=?",
    ).run(message, now(), json(details), previous["id"]!);
  else
    db.prepare(
      "INSERT INTO issues(archive_id,kind,message,created_at,updated_at,details_json) VALUES (?,?,?,?,?,?)",
    ).run(archiveId, kind, message, now(), now(), json(details));
}
export function recordOutcome(
  db: DatabaseSync,
  outcome: Outcome,
  update?: ArchiveUpdate,
): void {
  if (update)
    db.prepare(
      "UPDATE archives SET location=?,status=?,size=?,fingerprint=?,identity_json=?,mtime_ms=?,lossy_state=?,converted_pages=?,format_counts=?,updated_at=? WHERE id=?",
    ).run(
      update.location,
      update.status,
      update.size,
      update.fingerprint,
      update.identityJson,
      Number(JSON.parse(update.identityJson).mtime) / 1e6,
      update.lossyState,
      update.convertedPages,
      update.formats === null ? null : json(update.formats),
      now(),
      outcome.archiveId,
    );
  const result = Number(
    db
      .prepare(
        "INSERT INTO results(run_id,archive_id,path,outcome,mode,source_size,final_size,bytes_saved,created_at,details_json) VALUES (?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        outcome.runId,
        outcome.archiveId,
        outcome.path,
        outcome.outcome,
        outcome.mode,
        outcome.sourceSize,
        outcome.finalSize,
        outcome.bytesSaved,
        now(),
        json({ error: outcome.error }),
      ).lastInsertRowid,
  );
  const statement = db.prepare(
    "INSERT INTO pages(result_id,archive_id,entry_path,source_format,outcome,mode,distance,effort,source_size,final_size,created_at,details_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
  );
  for (const page of outcome.pages)
    statement.run(
      result,
      outcome.archiveId,
      page.entry,
      page.sourceFormat,
      page.outcome,
      page.mode ?? null,
      page.distance ?? null,
      page.effort ?? null,
      page.sourceSize,
      page.finalSize,
      now(),
      json(page),
    );
  const failed = ["failed", "quarantined", "blocked", "deferred"].includes(
    outcome.outcome,
  );
  db.prepare(
    "UPDATE runs SET checked=checked+1,optimized=optimized+?,unchanged=unchanged+?,failed=failed+?,bytes_saved=bytes_saved+? WHERE id=?",
  ).run(
    outcome.outcome === "optimized" ? 1 : 0,
    failed || outcome.outcome === "optimized" ? 0 : 1,
    failed ? 1 : 0,
    outcome.bytesSaved,
    outcome.runId,
  );
  if (outcome.error)
    addIssue(
      db,
      outcome.archiveId,
      outcome.kind ?? "processing_failed",
      outcome.error,
    );
}
export function enqueue(
  db: DatabaseSync,
  library: Library,
  policy: Policy,
  scope: string,
  path: string | null = null,
): string {
  if (!library.enabled) throw new Error("The library is disabled");
  if (!["changed", "all"].includes(scope))
    throw new Error("scope must be changed or all");
  const queued = Number(
    db
      .prepare(
        "SELECT count(*) AS n FROM runs WHERE status IN ('queued','running')",
      )
      .get()!["n"],
  );
  if (queued >= 20) throw new Error("The job queue is full");
  const id = randomUUID();
  db.prepare(
    "INSERT INTO runs(id,library_id,source,status,policy_json,scope,archive_id,queued_at) VALUES (?,?,'manual','queued',?,?,?,?)",
  ).run(id, library.id, json(policy), scope, path, now());
  return id;
}
export function nextRun(db: DatabaseSync): Run | undefined {
  return transaction(db, () => {
    const run = db
      .prepare(
        "SELECT * FROM runs WHERE status='queued' ORDER BY queued_at,id LIMIT 1",
      )
      .get() as unknown as Run | undefined;
    if (run)
      db.prepare(
        "UPDATE runs SET status='running',started_at=? WHERE id=?",
      ).run(now(), run.id);
    return run;
  });
}
export function totals(db: DatabaseSync, library: string) {
  const counts = db
    .prepare(
      "SELECT count(*) AS archives,coalesce(sum(size),0) AS currentBytes,coalesce(sum(CASE WHEN converted_pages>0 THEN 1 ELSE 0 END),0) AS optimizedArchives,coalesce(sum(converted_pages),0) AS optimizedPages,sum(CASE WHEN format_counts IS NULL THEN 1 ELSE 0 END) AS unknownFormats FROM archives WHERE library_id=? AND location<>'quarantine' AND status<>'missing'",
    )
    .get(library)!;
  const saved = Number(
    db
      .prepare(
        "SELECT coalesce(sum(r.bytes_saved),0) AS saved FROM results r JOIN runs j ON j.id=r.run_id WHERE j.library_id=? AND j.source<>'import' AND r.outcome='optimized'",
      )
      .get(library)!["saved"],
  );
  const needs = Number(
    db
      .prepare(
        "SELECT count(*) AS n FROM issues i LEFT JOIN archives a ON a.id=i.archive_id WHERE (a.library_id=? OR i.archive_id IS NULL) AND i.state='needs_review'",
      )
      .get(library)!["n"],
  );
  return {
    archives: Number(counts["archives"]),
    currentBytes: Number(counts["currentBytes"]),
    optimizedArchives: Number(counts["optimizedArchives"]),
    optimizedPages: Number(counts["optimizedPages"]),
    unknownFormats: Number(counts["unknownFormats"] ?? 0),
    savedBytes: setting<number>(db, "imported_savings:" + library, 0) + saved,
    needsAttention: needs,
  };
}
export function snapshot(db: DatabaseSync, library: string): void {
  const data = totals(db, library),
    formats: Formats = {};
  for (const row of db
    .prepare(
      "SELECT format_counts FROM archives WHERE library_id=? AND location<>'quarantine' AND status<>'missing' AND format_counts IS NOT NULL",
    )
    .iterate(library)) {
    for (const [format, count] of Object.entries(
      JSON.parse(String(row["format_counts"])) as Formats,
    ))
      formats[format as keyof Formats] =
        (formats[format as keyof Formats] ?? 0) + count!;
  }
  const formatsJson = Number(data.unknownFormats) > 0 ? null : json(formats);
  const previous = db
    .prepare(
      "SELECT * FROM snapshots WHERE library_id=? ORDER BY id DESC LIMIT 1",
    )
    .get(library);
  if (
    previous &&
    String(previous["recorded_at"]).slice(0, 10) === now().slice(0, 10) &&
    previous["archive_count"] === data.archives &&
    previous["current_bytes"] === data.currentBytes &&
    previous["saved_bytes"] === data.savedBytes &&
    previous["formats_json"] === formatsJson
  )
    return;
  db.prepare(
    "INSERT INTO snapshots(library_id,recorded_at,archive_count,current_bytes,saved_bytes,formats_json) VALUES (?,?,?,?,?,?)",
  ).run(
    library,
    now(),
    Number(data.archives),
    Number(data.currentBytes),
    data.savedBytes,
    formatsJson,
  );
}
export function settings(db: DatabaseSync, library: Library, effort: number) {
  return { library, effort: setting<number>(db, "effort", effort) };
}
export function updateSettings(
  db: DatabaseSync,
  library: Library,
  name: string,
  enabled: boolean,
  effort: number,
): void {
  transaction(db, () => {
    db.prepare("UPDATE libraries SET name=?,enabled=? WHERE id=?").run(
      name,
      enabled ? 1 : 0,
      library.id,
    );
    setSetting(db, "effort", effort);
  });
}
