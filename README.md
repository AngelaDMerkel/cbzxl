# CBZXL

A small comic archive optimizer: TypeScript, SQLite, and a desktop web interface.
No database server, frontend framework, or background service fleet.

CBZXL converts JPEG, PNG, TIFF, and BMP pages inside CBZ archives to JPEG XL.
Lossless is the default. Existing JPEG XL pages stay untouched. A page and its
rebuilt archive must both become smaller before the source is replaced.

The overview shows the current run, previous run, library statistics, and two
dated trends: library size with cumulative savings, and image format counts.
Problems accumulate in a centered review dialog. Detailed archive and page
history stays available behind deliberate actions.

## Start with Docker

```sh
cp .env.example .env
mkdir -p library/source data work
```

Set `PUID` and `PGID` in `.env` to the directory owner's numeric IDs (`id -u`
and `id -g`). Put comics in `library/source`, then run:

```sh
docker compose up --build -d cbzxl
```

Open [localhost:5000](http://localhost:5000). Compose binds to loopback by
default. Set `API_TOKEN` before sharing access; terminate HTTPS at your reverse
proxy. [Container operations](docs/containers.md) explains mounts and resource
limits.

With only `SOURCE_DIR`, optimized results replace their source in place.
Defining `CONVERTED_DIR` sends only verified, smaller archives there, preserving
their relative paths. The source is removed after the output and its recoverable
history are durable. Archives needing no changes stay in the source.
Defining `QUARANTINE_DIR` moves only invalid or corrupt sources there unchanged.
Encoder failures and uncertain history retain the source for review.

## Existing Python or Rust database

Stop the old application and follow [the migration guide](docs/migration.md).
The separate migration container supports a dry run, verifies the imported
database and report, and removes the old database after success. Docker removes
the one-shot container with `--rm`. The new application never silently imports
or overwrites a legacy database.

## Run natively

Install Node 24.22.3, pnpm 11.25.0, libjxl's `cjxl` and `djxl` tools (tested with
0.11.2), and ImageMagick 7. Set the paths in `.env` to local directories:

```dotenv
SOURCE_DIR=./comics
DB_PATH=./data/cbzxl.sqlite3
SCRATCH_DIR=./data/work
```

```sh
mkdir -p comics
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

`pnpm dev` restarts the backend on source changes; rebuild the frontend with
`pnpm build`. `node --env-file=.env src/cli.ts check` checks the database,
directories, and native tools without starting a server.

## Development and boundaries

```sh
pnpm check
pnpm test
pnpm build
```

Tests use disposable databases and generated images, including real codec
round trips and interrupted publication. CI runs the Linux suite and both
container smoke tests on AMD64 and ARM64.

This version processes local CBZ files with ordinary stored/deflated ZIP
entries. Encrypted archives, unsupported ZIP compression, and multi-frame images
remain unchanged for review. TIFF/BMP conversion supports single-frame RGB or
grayscale images up to 16 bits; unsupported colour spaces stay unchanged.
CPU threads, memory estimates, archive limits, and command timeouts are bounded;
container memory limits provide a hard cap on native codec processes.

Lossy conversion is available only through explicit run options. Previously
lossy or uncertain imported history blocks it, and marking an issue reviewed
does not remove that protection. No schedules, automatic quality selection,
repair actions, notifications, or external integrations run in this version.

See [configuration](docs/configuration.md) and [architecture](docs/architecture.md).
