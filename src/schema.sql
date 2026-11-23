PRAGMA application_id = 1128421942;
PRAGMA user_version = 1;
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
INSERT INTO meta VALUES ('schema','cbzxl-typescript-1');
CREATE TABLE libraries(
 id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL,
 enabled INTEGER NOT NULL DEFAULT 1, legacy_json TEXT NOT NULL DEFAULT '{}'
) STRICT;
CREATE TABLE archives(
 id TEXT PRIMARY KEY, library_id TEXT NOT NULL REFERENCES libraries(id),
 path TEXT NOT NULL, location TEXT NOT NULL DEFAULT 'source',
 status TEXT NOT NULL DEFAULT 'new', baseline_size INTEGER, size INTEGER,
 fingerprint TEXT, mtime_ms REAL, lossy_state TEXT NOT NULL DEFAULT 'unknown',
 converted_pages INTEGER NOT NULL DEFAULT 0, format_counts TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, legacy_json TEXT NOT NULL DEFAULT '{}',
 UNIQUE(library_id,path),
 CHECK(location IN ('source','converted','quarantine')),
 CHECK(lossy_state IN ('unprocessed','lossless','lossy','unknown'))
) STRICT;
CREATE TABLE runs(
 id TEXT PRIMARY KEY, library_id TEXT REFERENCES libraries(id),
 source TEXT NOT NULL, status TEXT NOT NULL, policy_json TEXT NOT NULL,
 scope TEXT NOT NULL DEFAULT 'changed', only_path TEXT,
 queued_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
 found INTEGER NOT NULL DEFAULT 0, checked INTEGER NOT NULL DEFAULT 0,
 optimized INTEGER NOT NULL DEFAULT 0, unchanged INTEGER NOT NULL DEFAULT 0,
 failed INTEGER NOT NULL DEFAULT 0, bytes_saved INTEGER NOT NULL DEFAULT 0,
 cancel_requested INTEGER NOT NULL DEFAULT 0, error TEXT,
 legacy_json TEXT NOT NULL DEFAULT '{}'
) STRICT;
CREATE TABLE results(
 id INTEGER PRIMARY KEY, run_id TEXT REFERENCES runs(id),
 archive_id TEXT REFERENCES archives(id), path TEXT NOT NULL,
 outcome TEXT NOT NULL, mode TEXT, source_size INTEGER, final_size INTEGER,
 bytes_saved INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
 details_json TEXT NOT NULL DEFAULT '{}'
) STRICT;
CREATE TABLE pages(
 id INTEGER PRIMARY KEY, result_id INTEGER REFERENCES results(id),
 archive_id TEXT REFERENCES archives(id), entry_path TEXT NOT NULL,
 source_format TEXT, outcome TEXT NOT NULL, mode TEXT, distance REAL, effort INTEGER,
 source_size INTEGER, final_size INTEGER, created_at TEXT NOT NULL,
 details_json TEXT NOT NULL DEFAULT '{}'
) STRICT;
CREATE TABLE issues(
 id INTEGER PRIMARY KEY, archive_id TEXT REFERENCES archives(id),
 kind TEXT NOT NULL, message TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'needs_review',
 note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 details_json TEXT NOT NULL DEFAULT '{}',
 CHECK(state IN ('needs_review','reviewed','resolved'))
) STRICT;
CREATE TABLE snapshots(
 id INTEGER PRIMARY KEY, library_id TEXT REFERENCES libraries(id),
 recorded_at TEXT NOT NULL, archive_count INTEGER, current_bytes INTEGER,
 saved_bytes INTEGER, formats_json TEXT, details_json TEXT NOT NULL DEFAULT '{}'
) STRICT;
CREATE TABLE transfers(
 id TEXT PRIMARY KEY, archive_id TEXT NOT NULL REFERENCES archives(id),
 source_path TEXT NOT NULL, target_path TEXT NOT NULL, temporary_path TEXT NOT NULL,
 source_hash TEXT NOT NULL, target_hash TEXT NOT NULL, kind TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'prepared', payload_json TEXT NOT NULL,
 created_at TEXT NOT NULL
) STRICT;
CREATE TABLE imports(
 digest TEXT PRIMARY KEY, source_path TEXT NOT NULL, source_kind TEXT NOT NULL,
 imported_at TEXT NOT NULL, report_json TEXT NOT NULL
) STRICT;
CREATE INDEX archive_location ON archives(library_id,location,status);
CREATE INDEX archive_fingerprint ON archives(fingerprint);
CREATE INDEX run_queue ON runs(status,queued_at);
CREATE INDEX results_history ON results(archive_id,created_at);
CREATE INDEX page_archive ON pages(archive_id);
CREATE INDEX issue_attention ON issues(state,updated_at);
CREATE INDEX snapshot_date ON snapshots(library_id,recorded_at);
