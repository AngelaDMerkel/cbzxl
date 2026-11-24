import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  activeLibrary,
  archiveById,
  enqueue,
  settings,
  totals,
  updateSettings,
} from "./library.ts";
import { numberSetting, parsePolicy } from "./config.ts";
import type { Config } from "./config.ts";
import { json, now, setting } from "./database.ts";
import type { Worker } from "./worker.ts";

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
function send(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(json(value));
}
function authorized(request: IncomingMessage, token?: string): boolean {
  if (!token) return true;
  const actual = Buffer.from(request.headers.authorization ?? ""),
    expected = Buffer.from("Bearer " + token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
async function body(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  if (
    request.headers["content-type"]?.split(";")[0] !== "application/json" ||
    request.headers["x-cbzxl-request"] !== "1"
  )
    throw new HttpError(415, "Use JSON and the X-CBZXL-Request: 1 header");
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 32768) throw new HttpError(413, "Request is too large");
    chunks.push(chunk);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HttpError(400, "A JSON object is required");
  return value as Record<string, unknown>;
}
function page(url: URL) {
  return {
    limit: numberSetting(
      url.searchParams.get("limit") ?? undefined,
      50,
      1,
      200,
      "limit",
    ),
    offset: numberSetting(
      url.searchParams.get("offset") ?? undefined,
      0,
      0,
      10000000,
      "offset",
    ),
  };
}
function text(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new HttpError(
      400,
      name + " is required (at most " + max + " characters)",
    );
  return value.trim();
}

export function applicationServer(
  db: DatabaseSync,
  config: Config,
  worker: Worker,
  staticDirectory = resolve("dist"),
) {
  return createServer(async (request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    try {
      const host = request.headers.host ?? "";
      if (!host || /[\s/\\]/.test(host))
        throw new HttpError(400, "Invalid host");
      const url = new URL(request.url ?? "/", "http://" + host);
      if (
        ["127.0.0.1", "localhost", "::1"].includes(config.host) &&
        !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      )
        throw new HttpError(403, "Host is not allowed");
      if (request.headers.origin) {
        let origin: URL;
        try {
          origin = new URL(request.headers.origin);
        } catch {
          throw new HttpError(403, "Origin is not allowed");
        }
        if (
          origin.host !== host ||
          !["http:", "https:"].includes(origin.protocol)
        )
          throw new HttpError(403, "Origin is not allowed");
      }
      const method = request.method ?? "GET",
        path = url.pathname;
      if (method === "GET" && path === "/health") {
        send(response, 200, { status: "ready" });
        return;
      }
      if (!path.startsWith("/api/")) {
        if (method !== "GET" && method !== "HEAD")
          throw new HttpError(405, "Method is not allowed");
        const files: Record<string, [string, string]> = {
          "/": ["index.html", "text/html"],
          "/app.js": ["app.js", "text/javascript"],
          "/app.css": ["app.css", "text/css"],
          "/favicon.svg": ["favicon.svg", "image/svg+xml"],
        };
        const file = files[path];
        if (!file) throw new HttpError(404, "Not found");
        let content: Buffer;
        try {
          content = await readFile(join(staticDirectory, file[0]));
        } catch {
          throw new HttpError(
            503,
            "Build the web interface before starting CBZXL",
          );
        }
        response.writeHead(200, {
          "Content-Type": file[1] + "; charset=utf-8",
          "Cache-Control": "no-cache",
        });
        response.end(method === "HEAD" ? undefined : content);
        return;
      }
      if (!authorized(request, config.token))
        throw new HttpError(401, "API token required");
      const library = activeLibrary(db, config.source);
      const input = ["POST", "PATCH", "DELETE"].includes(method)
        ? await body(request)
        : {};
      if (method === "GET" && path === "/api/overview") {
        const current =
          db
            .prepare(
              "SELECT * FROM runs WHERE library_id=? AND status IN ('running','stopping') ORDER BY started_at DESC LIMIT 1",
            )
            .get(library.id) ?? null;
        const previous =
          db
            .prepare(
              "SELECT * FROM runs WHERE library_id=? AND status NOT IN ('queued','running','stopping') ORDER BY coalesce(finished_at,started_at,queued_at) DESC LIMIT 1",
            )
            .get(library.id) ?? null;
        const queued = Number(
          db
            .prepare(
              "SELECT count(*) AS n FROM runs WHERE library_id=? AND status='queued'",
            )
            .get(library.id)!["n"],
        );
        send(response, 200, {
          library,
          totals: totals(db, library.id),
          current,
          previous,
          queued,
          progress: worker.current,
          error: worker.error,
        });
        return;
      }
      if (method === "GET" && path === "/api/trends") {
        const days = numberSetting(
          url.searchParams.get("days") ?? undefined,
          90,
          1,
          3650,
          "days",
        );
        const since = new Date(Date.now() - days * 86400000).toISOString();
        // Keep the last genuine measurement per day; do not invent points for missing dates.
        const points = db
          .prepare(
            "SELECT * FROM snapshots WHERE library_id=? AND recorded_at>=? AND id IN (SELECT max(id) FROM snapshots WHERE library_id=? AND recorded_at>=? GROUP BY substr(recorded_at,1,10)) ORDER BY recorded_at",
          )
          .all(library.id, since, library.id, since);
        send(response, 200, {
          since,
          until: now(),
          points: points.map((point) => ({
            ...point,
            formats: point["formats_json"]
              ? JSON.parse(String(point["formats_json"]))
              : null,
          })),
        });
        return;
      }
      if (method === "GET" && path === "/api/settings") {
        send(response, 200, {
          ...settings(db, library, config.effort),
          paths: {
            source: config.source,
            converted: config.converted ?? null,
            quarantine: config.quarantine ?? null,
          },
          limits: { threads: config.threads, memoryMb: config.memoryMb },
        });
        return;
      }
      if (method === "PATCH" && path === "/api/settings") {
        const name = text(input.name, "Library name", 100),
          effort = numberSetting(input.effort, config.effort, 1, 10, "effort");
        if (typeof input.enabled !== "boolean")
          throw new HttpError(400, "enabled must be a boolean");
        updateSettings(db, library, name, input.enabled, effort);
        send(response, 200, { ok: true });
        return;
      }
      if (method === "POST" && path === "/api/runs") {
        const policy = parsePolicy(
          input.policy ?? {},
          setting<number>(db, "effort", config.effort),
        );
        const scope = input.scope ?? "changed";
        if (scope !== "changed" && scope !== "all")
          throw new HttpError(400, "scope must be changed or all");
        let archiveId: string | null = null;
        if (input.archiveId !== undefined) {
          archiveId = text(input.archiveId, "Archive ID", 200);
          const archive = archiveById(db, archiveId);
          if (
            !archive ||
            archive.library_id !== library.id ||
            archive.location === "quarantine" ||
            archive.status === "missing"
          )
            throw new HttpError(409, "Archive is not available for processing");
        }
        if (!library.enabled)
          throw new HttpError(409, "The library is disabled");
        if (
          Number(
            db
              .prepare(
                "SELECT count(*) AS n FROM runs WHERE status IN ('queued','running','stopping')",
              )
              .get()!["n"],
          ) >= 20
        )
          throw new HttpError(409, "The job queue is full");
        const id = enqueue(db, library, policy, scope, archiveId);
        worker.wake();
        send(response, 202, { id });
        return;
      }
      let match = path.match(/^\/api\/runs\/([^/]+)\/cancel$/);
      if (method === "POST" && match) {
        if (
          !db
            .prepare("SELECT 1 FROM runs WHERE id=? AND library_id=?")
            .get(match[1]!, library.id)
        )
          throw new HttpError(404, "Run not found");
        send(response, 200, { cancelled: worker.cancel(match[1]!) });
        return;
      }
      if (method === "GET" && path === "/api/runs") {
        const { limit, offset } = page(url);
        send(response, 200, {
          items: db
            .prepare(
              "SELECT * FROM runs WHERE library_id=? ORDER BY queued_at DESC,id DESC LIMIT ? OFFSET ?",
            )
            .all(library.id, limit, offset),
        });
        return;
      }
      match = path.match(/^\/api\/runs\/([^/]+)$/);
      if (method === "GET" && match) {
        const run = db
          .prepare("SELECT * FROM runs WHERE id=? AND library_id=?")
          .get(match[1]!, library.id);
        if (!run) throw new HttpError(404, "Run not found");
        const { limit, offset } = page(url);
        send(response, 200, {
          run,
          results: db
            .prepare(
              "SELECT * FROM results WHERE run_id=? ORDER BY id LIMIT ? OFFSET ?",
            )
            .all(match[1]!, limit, offset),
        });
        return;
      }
      if (method === "GET" && path === "/api/issues") {
        const { limit, offset } = page(url),
          state = url.searchParams.get("state") ?? "needs_review";
        if (!["needs_review", "reviewed", "all"].includes(state))
          throw new HttpError(400, "Invalid issue state");
        send(response, 200, {
          items: db
            .prepare(
              "SELECT i.*,a.path,a.location,a.status,a.lossy_state FROM issues i LEFT JOIN archives a ON a.id=i.archive_id WHERE (a.library_id=? OR i.archive_id IS NULL) AND (?='all' OR i.state=?) ORDER BY i.created_at DESC,i.id DESC LIMIT ? OFFSET ?",
            )
            .all(library.id, state, state, limit, offset),
        });
        return;
      }
      match = path.match(/^\/api\/issues\/(\d+)$/);
      if (method === "PATCH" && match) {
        const issue = db
          .prepare(
            "SELECT i.id FROM issues i LEFT JOIN archives a ON a.id=i.archive_id WHERE i.id=? AND (a.library_id=? OR i.archive_id IS NULL)",
          )
          .get(match[1]!, library.id);
        if (!issue) throw new HttpError(404, "Issue not found");
        if (input.state !== "reviewed" && input.state !== "needs_review")
          throw new HttpError(400, "state must be reviewed or needs_review");
        const note = text(input.note, "Review note", 4000);
        db.prepare(
          "UPDATE issues SET state=?,note=?,updated_at=? WHERE id=?",
        ).run(input.state, note, now(), match[1]!);
        send(response, 200, { ok: true });
        return;
      }
      match = path.match(/^\/api\/archives\/([^/]+)$/);
      if (method === "GET" && match) {
        const archive = archiveById(db, match[1]!);
        if (!archive || archive.library_id !== library.id)
          throw new HttpError(404, "Archive not found");
        const { limit, offset } = page(url);
        send(response, 200, {
          archive,
          results: db
            .prepare(
              "SELECT * FROM results WHERE archive_id=? ORDER BY id DESC LIMIT ? OFFSET ?",
            )
            .all(archive.id, limit, offset),
          pages: db
            .prepare(
              "SELECT * FROM pages WHERE archive_id=? ORDER BY id DESC LIMIT ? OFFSET ?",
            )
            .all(archive.id, limit, offset),
        });
        return;
      }
      throw new HttpError(404, "Not found");
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const status =
        error instanceof HttpError
          ? error.status
          : /must be|policy is required|scope must/.test(String(error))
            ? 400
            : 500;
      if (status === 500) console.error(error);
      send(response, status, {
        error:
          status === 500
            ? "The operation failed; see the application log"
            : error instanceof Error
              ? error.message
              : String(error),
      });
    }
  });
}
