# TypeScript rewrite requirements

CBZXL will be rewritten from scratch in TypeScript, with a compact backend,
a lightweight TypeScript web UI, and SQLite. These requirements capture the
decisions agreed on November 17, 2026. The existing Rust and Python applications
remain references for understanding source database formats and identifying
behavior to discuss; their implementation and architecture are not the basis
of the new application.

## Architecture

- Write the frontend, backend, conversion orchestration, and migration tooling
  in TypeScript. Third-party image encoders remain external dependencies;
  application logic must not depend on the old Rust or Python runtime.
- Use SQLite with no separate database server.
- Design a small backend and lightweight UI around explicitly agreed workflows.
- Define the new modules, database schema, API, validation, and tests from the
  agreed requirements. Do not translate the old code module by module or inherit
  its compatibility routes, abstractions, UI structure, or feature set by default.
- Use explicit data validation at database, HTTP, and process boundaries;
  TypeScript types alone do not validate external data.
- Select the JavaScript runtime, libraries, and frontend framework separately.
  The TypeScript decision does not mandate a particular framework.

## Migration data

The migration must support both older Python databases and the current Rust
database. Detect database families from their structure as well as version
markers: version numbers are not interchangeable between the families.

| Data category | Required treatment |
| --- | --- |
| Libraries | Preserve names, folder paths, and enabled state. Support explicit path remapping. |
| Archives | Preserve paths, conversion status, original and current sizes, recorded space savings, and available identity information. |
| Conversion history | Preserve archive outcomes and per-page results where available, including the conversion settings needed to interpret past results. |
| Lossy conversion protection | Preserve durable evidence of accepted lossy conversions and uncertainty. Protection must survive policy changes and history cleanup. |
| Issues and reviews | Preserve errors, notes, and previous decisions as historical context. Every imported issue and review requires re-review, including previously dismissed or resolved items. |
| Conversion policies | Start fresh. Historical settings remain evidence of past conversions, not active presets. |
| Schedules | Start fresh with no imported schedules. |
| Diagnostic logs and progress events | Omit. |
| Cached statistics | Omit and rebuild from migrated records. |

Migrated conversion history does not authorize resuming old queued jobs or
automatically performing old repair actions.

## Protection against repeated lossy conversion

- Distinguish accepted conversions from failed attempts and candidates that were
  rejected or discarded. An attempted lossy conversion is not proof that a lossy
  replacement was accepted.
- Retain conversion mode, available quality parameters, outcome, identity, and
  archive/page associations needed to interpret the accepted conversion history.
- Prevent automatic lossy conversion of output that was previously converted
  lossily by CBZXL. A new policy must not reset that protection.
- When history is missing or ambiguous, block automatic lossy conversion for the
  entire archive until it is reviewed. Do not infer losslessness from missing
  fields, zero-filled defaults, filenames, or a mixed-mode policy name.
- Preserve what the source actually records. The oldest databases lack per-page
  history; migration must report that limitation and retain the conservative
  archive-level protection instead of inventing page-level evidence.
- Maintain the protection as durable processing state independent of optional
  diagnostic logs and detailed-history retention.
- Importing an old review or dismissal does not clear this protection. The new
  review workflow and its requirements for clearing a block remain to be defined.

## Disposable migration container

The migration runs as an explicit one-off operation with the old and new
applications stopped. It does not start the application or conversion worker.

1. Detect and validate the source, then offer a dry run that reports the planned
   migration without changing the source or publishing a destination database.
2. Preserve a consistent source snapshot during migration and build the new
   schema in a separate temporary destination. Source and destination must be
   different files.
3. Migrate all agreed data categories transactionally. Validate integrity,
   relationships, record mappings, retained totals, and lossy-conversion
   protections before making the destination available.
4. Publish the verified destination and persist a migration report outside the
   container. The report identifies the source format, imported and omitted
   categories, validation results, uncertainties, and cleanup status.
5. Remove the old source database only after the complete migration is committed,
   verified, and durably published with its report. Any failure before those
   conditions are satisfied must preserve the source. Never replace a populated unrelated
   destination or silently merge histories.
6. Return an explicit success or failure status. Docker removes the container on
   exit through `docker compose run --rm`; the destination and report persist
   independently of container cleanup.

Repeated and interrupted runs must not duplicate records or leave the data
without a verified, durable database.
Recovery must account for interruption between publishing the destination,
writing the report, and removing the source. An unreconciled archive replacement
must be surfaced and resolved before source deletion can be considered safe.

## First implementation scope

Implement and test the new SQLite schema and standalone TypeScript migration
container first. Use newly written tests based on these requirements and fixtures
representing the supported source formats. Cover successful imports, ambiguous
history, accepted versus rejected lossy attempts, mandatory re-review, path
remapping, repeat runs, interruption, invalid sources, and source deletion only
after verified success.

The application's conversion policies, review workflow, scheduling behavior,
API, and UI features will be confirmed separately. Existing functionality is
inventory for that discussion, not an automatic requirement for the rewrite.
