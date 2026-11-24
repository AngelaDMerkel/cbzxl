# Architecture

CBZXL is one Node 24 process with native HTTP and SQLite, a sequential async
worker, and browser-native TypeScript. The two runtime packages read and write
ZIP archives. ImageMagick prepares and verifies pixels; libjxl performs encoding
and decoding. The browser bundle has no runtime dependencies.

| Module | Responsibility |
| --- | --- |
| `config.ts`, `files.ts` | Environment validation, path boundaries, file identities, hashes, durable writes. |
| `database.ts`, `schema.sql` | Exclusive ownership, transactions, schema and integrity checks. |
| `library.ts` | Job queue, archive identity/history, review records, totals, dated snapshots. |
| `archive.ts` | ZIP paths, resource limits, CRC checks, reconstruction and byte verification. |
| `codec.ts` | Supported format adapters, bounded child processes, lossless/colour verification. |
| `worker.ts` | Discovery, policy enforcement, cancellation and orchestration. |
| `transfers.ts` | Durable filesystem publication and interrupted-transfer recovery. |
| `http.ts`, `cli.ts` | Validated API, static assets, authentication, lifecycle. |
| `migrate.ts`, `migration-cli.ts` | Legacy schema adapters and one-shot migration. |
| `web/` | Centered overview, accessible dialogs, settings and SVG trend charts. |

## Conversion and recovery

Discovery records file identity and SHA-256. A private workspace receives flat
temporary files so archive paths cannot escape it. Each ZIP entry is size/CRC
checked; unsafe paths, duplicates, and special-file entries are rejected.

JPEG lossless output must reconstruct the original JPEG bytes exactly. Other
accepted lossless output must decode to the same oriented 16-bit RGBA pixels
and ICC profile. TIFF/BMP preparation is checked separately before encoding.
Accepted lossy output must decode, retain dimensions/orientation and colour
profile, and satisfy both page and final-archive size checks. Existing JPEG XL
and unsupported entries are never passed to the encoder.

A transfer intent stores the complete accepted result, page history, source
identity/hash, destination hash, and staging identity before a source can be
removed. Staging is adjacent to the destination and fsynced. In-place output is
renamed atomically; separate routing uses a no-overwrite link. Publication is
verified again and the directory synced. The exact source identity and contents
must still match before deletion. Final history and counters commit together
with removal of the transfer intent, so recovery counts the result once.

Recovery refuses unrelated or changed destinations, changed sources, and paths
outside the configured roots. Conflicting transfers remain durable, produce
attention items, and exclude their paths from fresh processing. Temporary
workspaces carrying the application's ownership marker are reclaimed at startup;
unrecognized directories are not removed.

## Durable evidence

Accepted lossy or uncertain history is a separate archive protection state.
Policy changes and review notes do not reset it. Replaced path generations
inherit conservative protection. Failed attempts and rejected candidates do not
establish accepted lossy history. The initial UI deliberately has no override
for this protection.

Issues accumulate until explicitly reviewed with a note. A successful retry
does not dismiss them. Imported reviews are historical context and require a new
review. Snapshots preserve genuine measurement dates; daily chart aggregation
chooses a recorded point rather than manufacturing interpolated inventory.

## API

All `/api/` endpoints require `Authorization: Bearer TOKEN` when configured.
Mutations require JSON and `X-CBZXL-Request: 1`. Cross-origin requests are
rejected. Lists accept `limit` (1–200) and `offset`.

| Method/path | Purpose |
| --- | --- |
| `GET /health` | Process readiness; no library details. |
| `GET /api/overview` | Current/previous run, queue length and library totals. |
| `GET /api/trends?days=90` | Genuine daily size/savings/format points. |
| `GET /api/settings`, `PATCH /api/settings` | Read configuration; update name, enabled state, effort. |
| `POST /api/runs` | Enqueue `{policy:{mode,effort,distance},scope,archiveId?}`; defaults to lossless changed-source processing. |
| `GET /api/runs`, `GET /api/runs/:id` | Run history and paginated archive results. |
| `POST /api/runs/:id/cancel` | Cancel pending work or stop active encoding safely. |
| `GET /api/issues?state=needs_review` | Accumulated review list; `all` includes reviewed records. |
| `PATCH /api/issues/:id` | Set `reviewed`/`needs_review` with a required `note`; never changes protection. |
| `GET /api/archives/:id` | Archive evidence, paginated result and page history. |

Add a format at the codec boundary, an independent feature module at the HTTP
boundary, or a new schema migration at the database boundary. Keep publication
and permanent protection rules shared rather than duplicating them in routes or
UI handlers.
