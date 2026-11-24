# Migrate a database

The one-off migration image imports older Python databases and the Rust v5
database into the TypeScript schema. It preserves libraries, archive and page
history, review context, and available historical library snapshots. Saved
policies and schedules start fresh; diagnostic events and derived caches are
omitted.

Stop both applications before migrating. The source database and its directory
must be writable so the migrator can obtain SQLite locks and remove the source
after success. Include existing WAL and SHM sidecar files in the configuration
mount; do not copy just the main database out of a running application.

Build the migration image:

```sh
docker build -f Dockerfile.migrate -t cbzxl-migrate:local .
```

With the old database in a local `data` directory, inspect the migration first:

```sh
docker run --rm --user "$(id -u):$(id -g)" --mount "type=bind,src=$(pwd)/data,dst=/config" -e DB_PATH=/config/cbzxl.sqlite3 -e SOURCE_DIR=/library cbzxl-migrate:local /config/old.sqlite3 --dry-run
```

Remove `--dry-run` to perform the migration. The source and target must be
different files. A dry run imports into a temporary database and validates it,
but does not publish the target or remove the source.

On success, the migrator removes the old database and writes
`cbzxl.sqlite3.migration.json` alongside the new database. Keep a separate backup
if you need the ability to return to an old application version.

The report contains the source format and digest, copied counts, omitted
categories, warnings, destination digest, and cleanup status. Failed attempts
write a separate report when the destination directory is writable. A failure
before publication leaves the source in place. A cleanup failure leaves the
verified destination and source available for a retry.

Run the same command again after resolving an interrupted migration. Its
receipt prevents duplicate imports and permits safe completion of source
cleanup. A changed destination, changed source, or unrelated existing database
is refused rather than overwritten or merged. SQLite lock sidecars are
application-owned; do not remove them while an application or migration is
running.

## Library paths and history

A single legacy library is mapped to `SOURCE_DIR` by default. Use
`--map OLD_ROOT=NEW_ROOT` for explicit mappings, particularly when old archive
paths are absolute or the source contains multiple libraries. Repeat `--map`
for additional roots. The selected active library must match `SOURCE_DIR`.
`--target` and `--source-root` override the corresponding environment values.

Old queued/running jobs become interrupted history. Pending filesystem
replacement intents block migration: reconcile them with the old application
first. No old repair command is resumed.

Imported issues and previous reviews require fresh review. Accepted lossy
conversions remain protected; failed or rejected attempts do not establish an
accepted lossy conversion. Missing or unverifiable history stays conservatively
blocked from further lossy conversion. The oldest format has no per-page
history, and migration does not invent it.

Historical snapshots are preserved where available. Current-only format
inventory does not become fictional historical format data; new scans establish
future format snapshots.
