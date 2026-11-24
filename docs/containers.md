# Container operations

The app image contains Node, two small ZIP packages, ImageMagick, libjxl tools,
and the compiled browser assets. The migration image contains Node and the
standalone migration modules; it does not start the web server or worker.
Both run as a numeric non-root user by default.

## Directories

Compose mounts `LIBRARY_ROOT` at `/library`, `CONFIG_DIR` at `/config`, and
`WORK_DIR` at `/work`. These host directories default to `./library`, `./data`,
and `./work`. `SOURCE_DIR`, `CONVERTED_DIR`, and `QUARANTINE_DIR` are paths inside
the container, usually `/library/source`, `/library/converted`, and
`/library/quarantine`. Create the source directory before starting.

Set `PUID`/`PGID` to the owner of the mounted directories. The app does not
recursively change ownership or start with elevated capabilities. All enabled
destinations and the database/scratch directories must be writable by that user.

Only `SOURCE_DIR` is enabled in the example configuration. Uncomment an optional
destination to enable it. Keep all three locations under the mounted library
root, or explicitly add mounts for your alternate container paths.

Scratch space must be separate from library directories, on a filesystem with
room for extracted pages and candidate output. Publication copies a verified
candidate to the destination filesystem before an atomic replacement or
no-overwrite link, so source and destination can be on different filesystems.

## Start, stop, and update

```sh
docker compose up --build -d cbzxl
docker compose logs --tail=100 cbzxl
docker compose stop cbzxl
```

Stopping cancels encoder work and finishes any publication already in progress.
After an abrupt stop, durable transfers are reconciled before a new run.
Interrupted runs remain history; explicitly queued new runs continue on startup.

The root filesystem is read-only. The process has no Linux capabilities and
cannot acquire new privileges. Compose limits CPU, memory, and process count;
`MEMORY_LIMIT_MB` controls application estimates and ImageMagick's budget, while
`CONTAINER_MEMORY` sets the hard total container limit. Leave headroom between
them. The default values are 2048 MB and 3 GB respectively.

`PORT` selects the host loopback port. To expose the service, configure your
reverse proxy and `API_TOKEN`; do not expose an unauthenticated instance to
untrusted clients. Browser tokens are held in memory and requested again after
a reload. API clients use `Authorization: Bearer TOKEN`.

Back up the complete configuration directory and library while the app is
stopped. SQLite WAL and SHM files belong to the database; copying only a live
main file is not a consistent backup. Restore the database and library together
to preserve conversion history and lossy protection. Do not delete transfer
records to bypass a recovery conflict.

## Build and verify

```sh
docker build --target test -t cbzxl-test:local .
docker run --rm --network none --memory 3g cbzxl-test:local
docker build -t cbzxl:local .
docker build -f Dockerfile.migrate -t cbzxl-migrate:local .
node test/app-container.ts cbzxl:local
node test/migration-container.ts cbzxl-migrate:local
```

The smoke scripts require Node 24 and Docker on the host. They bind only freshly
created synthetic fixtures, run as the invoking user, and remove their containers
and test directories. CI validates both supported CPU architectures. This
repository's workflow builds and tests images; it does not publish registry tags.
