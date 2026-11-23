# TypeScript rewrite requirements

CBZXL will be rewritten from scratch in TypeScript, with a compact backend,
a lightweight TypeScript web UI, and SQLite. These requirements capture the
agreed decisions and current interface proposals. The existing Rust and Python
applications remain references for understanding source database formats and identifying
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
- Keep library discovery, job execution, conversion policies and codec adapters,
  verification and safe replacement, persistence, HTTP handling, and UI rendering
  in focused modules with explicit TypeScript interfaces. New features should
  compose with these modules without requiring changes throughout the system.
- Define conversion and history-protection rules once in the application logic.
  Keep them independent of UI components and HTTP routes, and verify them with
  newly written tests. Prefer direct composition and small interfaces.

## Initial application features

| Area | Required functionality |
| --- | --- |
| Libraries | Configure folders, discover CBZ files, and identify new or changed archives. |
| Manual conversion | Process a selected archive or library through a bounded job queue. |
| Progress | Show the current archive, completed and remaining work, failures, and space saved. |
| Job controls | Start jobs, cancel safely, and recover cleanly after interruption. |
| Overview | Prioritize the current run, previous run, and core library statistics. |
| History | Preserve archive and page outcomes, actual settings, sizes, and provenance. Present run summaries by default. |
| Review | Surface failures, ambiguous conversion history, and imported items requiring re-review. |
| Settings | Configure library locations, new conversion policies, encoder effort, and CPU and memory limits. |

## Conversion requirements

- Support JPEG, PNG, TIFF, and BMP pages inside CBZ archives from the initial
  release. Convert eligible pages to JPEG XL.
- Lossless conversion is always the default. Encoder effort is configurable and
  must be respected during processing.
- Preserve existing JPEG XL entries unchanged. Never submit already-JXL images
  for conversion or re-encoding, regardless of the selected policy.
- Support lossy conversion only through an explicitly selected policy. Record
  the actual accepted quality settings for each page and enforce the permanent
  history protections described below. Never switch to lossy conversion merely
  because a lossless candidate does not save space.
- Accept a converted page only if it is smaller than its source. Retain the
  source page when conversion does not save space. Require the completed archive
  to be smaller before an ordinary optimization replaces the source archive.
- Verify decoded image content for lossless candidates, including correct
  treatment of transparency, orientation, and colour information.
- Preserve folder structure, unsupported image entries, and non-image files
  such as ComicInfo.xml. Handle filename collisions explicitly.
- Validate archive paths and resource limits, verify the rebuilt archive and
  accepted image candidates, and recheck source identity before replacement.
  Failed verification must never replace the source.
- Use atomic replacement and recoverable database bookkeeping so interruption
  does not leave archive contents and conversion history silently inconsistent.

Automatic Smart quality selection, scheduling, advanced ZIP or image repairs,
notifications, and third-party integrations are outside the initial application
scope. Future features can be added through the modular boundaries above after
their behavior is agreed.

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
   conditions are satisfied must preserve the source. Never replace a populated
   unrelated destination or silently merge histories.
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

## Interface design

Target desktop browsers only. A mobile interface and mobile-specific layouts are
out of scope.

The primary screen must focus on the status of the current run, the status and
results of the previous run, and core library statistics such as archive count,
current size, and cumulative space savings.

Successful individual archives do not belong on the primary screen. Surface
archive-level information when automatic processing is unsuccessful or an item
requires review. Keep detailed conversion history as durable internal state.

Keep settings and problem-archive details behind deliberate actions. The default
view should not present a conversion setup form, an archive browser, or a list of
successful results. Use visualization mockups to agree a very clean, simple
layout before implementation. Detailed conversion-policy controls and review
actions will be defined through that design work.

### Overview layout

Use the existing UI's live-progress-first overview, blue accent, and lifetime
statistics as visual references. This does not change the decision to write new
application code from scratch.

- Show a single progress bar with a small time-remaining label.
- Center the overall page composition in a consistent content column. Center the
  branding, run status, statistic labels and values, and previous-run summary.
- Place a live, updating status line directly underneath. Include the current
  processing stage and compact completed/total counts there. Do not show
  successful archive names or oversized progress figures.
- Place statistics immediately below progress. Start with the existing overview's
  net savings, pages optimized, archives optimized, and items needing attention.
  The attention count opens only the problem archives.
- Keep the previous run's outcome as a quiet summary beneath the statistics,
  rather than a separate bordered section.
- Separate content with spacing. Avoid divider rules, bordered statistic cards,
  repeated section headings, and decorative comparison bars on the overview.
- Keep settings and detailed diagnostics behind deliberate actions. Display only
  a compact stop/start control alongside run status.
- Status must reflect actual worker activity; do not present a polling heartbeat
  as progress. Report uncertainty when an ETA is not yet available. Preserve
  truthful statistics rather than inventing unknown original sizes or outcomes.

The compact, centered progress-and-statistics home layout is approved. Preserve
that structure. The icon should remain legible at small sizes and avoid the old
mark's crowded compression arrows.

Do not use accordions for errors or other interface content. Unresolved errors
accumulate across runs and remain accessible after the current run finishes.
Show each problem and its protection status directly in a flat list.

Use the selected centered breakout dialog for Needs attention. Open it from the
attention count on the home page and show the accumulated errors and their
protection states in a flat list, with readable column alignment. Keep the
overview in place behind the dialog and preserve the run state while it is open.
Closing the dialog restores focus to the attention count. Opening, viewing, or
closing the dialog never clears errors, review requirements, or lossy-conversion
blocks. Detailed review actions remain to be defined.

Existing functionality remains inventory for future discussion, not an automatic
requirement for the rewrite.
