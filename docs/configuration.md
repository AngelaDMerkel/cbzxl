# Configuration

Native startup loads `.env`; Compose loads the same file and supplies its
container bind address, database, and scratch paths. Restart after changing it.

| Variable | Native default | Purpose |
| --- | --- | --- |
| `SOURCE_DIR` | `./comics` | Existing source library, scanned recursively for CBZ files. |
| `CONVERTED_DIR` | Disabled | Verified smaller archives only; preserve relative paths and remove the old source after durable publication. |
| `QUARANTINE_DIR` | Disabled | Invalid/corrupt source archives only, with bytes and review history preserved. |
| `DB_PATH` | `./data/cbzxl.sqlite3` | New schema SQLite database. |
| `SCRATCH_DIR` | `./data/work` | Private temporary workspaces, outside the library. |
| `HOST` | `127.0.0.1` | Native HTTP bind address. Compose supplies `0.0.0.0` inside its network. |
| `PORT` | `5000` | Native port; Compose uses this as the host port. |
| `API_TOKEN` | Unset | Optional bearer token for all API routes. |
| `ENCODER_EFFORT` | `7` | Default effort, 1–10. A saved UI setting overrides this for new runs. |
| `CPU_LIMIT` | Up to `2` | Threads per native codec, 1–64; Compose also caps CPU. |
| `MEMORY_LIMIT_MB` | `2048` | Processing estimate and ImageMagick budget, 128–65536 MB. |
| `ARCHIVE_STABLE_SECONDS` | `2` | Minimum time since modification before processing. |
| `MAX_ARCHIVE_MB` | `8192` | Maximum source and expanded archive size, 1–65536 MB. |
| `MAX_ARCHIVE_ENTRIES` | `10000` | Maximum ZIP entries, 1–100000. |
| `COMMAND_TIMEOUT_SECONDS` | `600` | Maximum time per native command, 1–86400 seconds. |

Blank optional destinations are disabled. Enabled paths are validated rather
than silently falling back to source replacement. Converted/quarantine folders
may be descendants of the source, in which case discovery excludes them, but
neither may contain the source or overlap the other. Symbolic links and special
files are not followed during discovery or publication.

The UI stores the library name, enabled state, and encoder effort in SQLite.
Pausing the library prevents new runs. Ordinary Start uses lossless mode and
processes new, changed, or unsuccessful source archives. Run options can select
all source archives and explicitly choose lossy distance (greater than zero,
at most 3). The queue is bounded to 20 active/pending runs and executes one
archive at a time. Review details support a lossless retry of a selected
available archive. Quarantined files require an operator's inspection before
they are manually returned to the source.

The source and converted directories form one logical library. Quarantine is
excluded from its size/format totals. Historical savings count accepted
conversions once, retain imported baselines and corrections, and do not count
routing or quarantine as savings. Format graphs show measured inventory and
gaps where a complete inventory is unavailable. They never infer old format
counts from today's files.

One process owns the database through SQLite locks. Use a local filesystem for
the database and stop the app before migration. Multiple legacy libraries remain
preserved; the one matching `SOURCE_DIR` is active for processing and the UI.
