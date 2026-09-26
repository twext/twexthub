# Hosting TwextHub

TwextHub is a registry for Twext-compiled extensions. Publishers submit compiled extensions through the `twext` CLI; the registry stores them, applies a per-owner moderation gate, and serves downloads to TurboWarp. This guide is for people running an instance. Publisher-facing behavior is documented by the [twext](https://github.com/twext/twext) project.

## Table of Contents

<!-- START doctoc generated TOC please keep comment here to allow auto update -->
<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->

- [What you need](#what-you-need)
- [Run from source](#run-from-source)
- [Run with Docker](#run-with-docker)
- [Configuration](#configuration)
- [Behind a reverse proxy](#behind-a-reverse-proxy)
- [The build sandbox](#the-build-sandbox)
- [Webhooks](#webhooks)
- [Blobs must live on persistent storage](#blobs-must-live-on-persistent-storage)
- [Monitoring](#monitoring)
- [Upgrades](#upgrades)
- [Backups](#backups)
- [Boot-time cleanup](#boot-time-cleanup)
- [Next steps](#next-steps)

<!-- END doctoc generated TOC please keep comment here to allow auto update -->

## What you need

- Node.js 24 or newer. The server is ESM; `package.json` declares `engines.node >= 24`.
- A Postgres database it can reach. The supplied compose example uses Postgres 16; any recent Postgres works.
- A `database.url`, in `config.yaml` or as `TWEXTHUB_DATABASE_URL`. The server refuses to boot without one.

Migrations in `migrations/*.sql` run automatically on boot. To apply them ahead of time, use `npm run migrate`.

The first account created on a fresh database gets the `admin` role, which is your entry point to the review queue. Sign up first, then see the [moderation guide](moderation.md).

## Run from source

```sh
npm install
createdb twexthub
export TWEXTHUB_DATABASE_URL=postgres://postgres@localhost:5432/twexthub
npm start
```

`npm start` binds to port 3000 by default. A `data/` directory is created on first boot and holds the published extension blobs.

Migrations apply on every boot. To apply them without starting the server:

```sh
npm run migrate
```

To point at a different config file, pass it as the first argument:

```sh
node src/server.js /etc/twexthub.yaml
```

`npm run migrate` accepts the same argument, or `--config /etc/twexthub.yaml`.

## Run with Docker

Prebuilt images are published to `ghcr.io/twext/twexthub`. The image is configured entirely by `TWEXTHUB_*` environment variables — there is no `config.yaml` baked in. Blobs are written under `/app/data`, which is declared a volume.

**Compose (bundled Postgres):**

```sh
docker compose -f compose.example.yml up -d
```

Starts Postgres 16 and the hub, runs migrations, and exposes the API on `http://localhost:3000`. Data lives in the `postgres-data` and `twexthub-data` volumes.

**Build from source:**

```sh
docker build -t twexthub:local .
```

**Run against an existing Postgres:**

```sh
docker run -d --name twexthub \
  -p 3000:3000 \
  -e TWEXTHUB_DATABASE_URL=postgres://user:pass@host:5432/twexthub \
  -e TWEXTHUB_PUBLIC_BASE_URL=https://hub.example.com \
  -v twexthub-data:/app/data \
  ghcr.io/twext/twexthub:latest
```

## Configuration

The [configuration reference](configuration.md) lists every key and environment variable. The settings that matter most in production:

- `TWEXTHUB_PUBLIC_BASE_URL` — the public URL of the instance. Used to build the download links the registry returns.
- `TWEXTHUB_TRUST_PROXY` — set when the instance runs behind a reverse proxy (next section).
- `TWEXTHUB_REQUIRE_HTTPS` — reject plain-HTTP requests with 403.
- `TWEXTHUB_API_ROOT` — the URL prefix all routes are served under. Default `/v1`.

## Behind a reverse proxy

Point the proxy at the server's port. Two things need attention when one is in front:

- Set `TWEXTHUB_TRUST_PROXY` to the appropriate [Express trust proxy](https://expressjs.com/en/guide/behind-proxies.html) value (`1` for a single proxy hop, `true` to trust all). Without it the server sees the proxy's address instead of the client's. The per-IP signup limit (5 per 15 minutes by default) then adds up signups from every visitor into one bucket and starts returning 429 for everyone.
- If the proxy terminates TLS, `TWEXTHUB_TRUST_PROXY` is also what lets `TWEXTHUB_REQUIRE_HTTPS` tell real clients from plain HTTP.

Publish requests carry a gzipped source tarball (up to `limits.maxSourceBytes`, 1 MB by default). nginx's default `client_max_body_size` is 1 MB, so raise it for the instance; otherwise large publishes die at the proxy.

## The build sandbox

The hub compiles every publish itself: the uploaded tarball is expanded under `dataDir/tmp/`, and `twext build` runs there in a child process. The sandbox is:

- **Filesystem** — Node's permission model restricts the child to reads and writes inside the extracted project directory plus reads of the server's own `node_modules` (the compiler and its dependencies). A `twext.yml` cannot redirect the output elsewhere; the output path is forced inside the sandbox directory.
- **Memory** — `compiler.memoryMb` (192 MB default) caps the child's V8 old-generation heap; the child is killed if it grows past that.
- **Time** — `compiler.timeoutMs` (30 s default) SIGKILLs the child.
- **No secrets** — the child receives an allowlist (`PATH`, `HOME`, `TMPDIR`, `TMP`, `TEMP`, `LANG`, `LC_ALL`, `TZ`) instead of the server's environment, so a build cannot read the database URL or any other credential the host passes in.

Node's permission model does not gate outbound sockets, so an extension's build step could attempt network egress. Isolate that at the deployment boundary: run the container with no egress (Docker's `--network none` for a dedicated builder, or an egress firewall), or accept the risk if only moderated accounts can publish. The sandbox prevents code from escaping the box; it does not stop it from calling out.

Operators can substitute their own compiler with `TWEXTHUB_COMPILER` (a binary or script invoked as `<command> build -o <out>`); see the [compiler configuration](configuration.md#compiler). A substituted compiler gets the same environment allowlist, so a script that needs its own variables must read them from a file it controls.

A failed build rejects the publish with `422` and reports the compiler's output as `buildLog`; nothing is staged. Moderation reviews the source tarball and build log — the queue's `sourceUrl` fetches the exact uploaded bytes — so what an admin approves is what compiles into the served blob.

## Webhooks

Webhook destinations are checked when a publisher registers one: the URL must be `https`, resolve to a public address, and carry no credentials in it. The name is resolved again on every delivery attempt, so a destination whose DNS answers have since turned private is refused before the request goes out.

That re-check narrows the window but does not close it: the address is resolved before the connection, so a host that answers differently to the two lookups can still be reached. Closing it entirely means controlling resolution, which belongs at the deployment boundary — run the instance on a network where outbound requests cannot reach loopback, link-local or private ranges, or resolve through a proxy you operate.

## Blobs must live on persistent storage

Published blobs are written to the local disk under `dataDir`, not to the database. The `versions` table records that a version exists; the blob is a file on whatever machine handled the publish. This shapes every deployment on a container platform:

- **Replacing the container loses blobs.** If the instance's storage is ephemeral — an ECS/Fargate task without a mounted volume, a Coolify service rebuilt fresh — every deploy deletes the blobs while the database keeps the `versions` rows. Extensions stay listed but their download endpoints 404. Mount a persistent volume at `/app/data` (the image declares it as a volume) so redeploys reuse it.
- **Scaling to more than one instance requires shared blob storage.** Two instances behind a load balancer that share Postgres but have separate disks will 404 on downloads half the time: a blob written by instance A only exists there. Publishing is safe across instances (the per-extension locks live in Postgres), but the blob directory must be shared — an EFS mount on Fargate, a shared block volume, or a single instance.

Point `TWEXTHUB_DATA_DIR` (or `dataDir`) at the persistent mount and keep it in sync with database backups.

## Monitoring

`GET /v1/admin/metrics` renders Prometheus text format for an authenticated admin session — point a scraper's bearer token at it. Exposed gauges and counters:

- `twexthub_users_total`, `twexthub_extensions_published_total`, `twexthub_versions_total{status}`, `twexthub_downloads_total`
- `twexthub_storage_bytes{kind="blob"|"source"}` — bytes currently charged to accounts
- `twexthub_storage_integrity_errors` — blobs that failed the last daily integrity scrub (see below)
- `twexthub_process_uptime_seconds`
- `twexthub_http_requests_total{method,route,status}` and `twexthub_http_request_duration_seconds_sum/count{method,route}` — per-route traffic; routes are labeled by pattern, never raw path

The daily integrity scrub re-hashes every stored blob and compares against its recorded digest. Failures are logged at warn level and exported through the gauge, but nothing is deleted: a mismatch usually means disk corruption or a stray writer, and the operator decides between restoring the file from backup or deleting the affected version.

Scrape frequency note: the registry gauges are computed per scrape; per-route counters are in-memory and reset on restart.

## Upgrades

Releases are tagged with semver, and `latest` tracks `main`. To upgrade, pull the new image or deploy the new tree and restart — new migrations apply automatically on boot. A database backup before the restart is cheap insurance if a migration goes wrong mid-run.

## Backups

Two things hold state: the Postgres database and the data directory.

- Database: a standard `pg_dump`, restored onto a fresh database with `psql`.
- Data directory: compiled blobs (`blobs/`) **and** uploaded source tarballs (`sources/`). Both are written once at publish time and cannot be regenerated — losing either while keeping the database leaves versions listed but their download or source endpoints 404ing. Back up both directories (or the whole `dataDir`) together with the database.

Both trees are content-addressed by SHA-256 (`blobs/<xx>/<rest>`, `sources/<xx>/<rest>`), so a restore is a plain file copy — no paths to rewrite. If a restore leaves a file missing, the daily scrub surfaces it through `twexthub_storage_integrity_errors` and the affected download returns 404.

`tmp/` and `quarantine/` inside the data directory are scratch space; they matter for no restore.

## Boot-time cleanup

On every start the server reconciles leftover state:

- Staging versions older than an hour are promoted to `pending` or `published` when their blob and source both exist, and removed when either is missing. That is crash recovery for publishes interrupted mid-write. The namespace account decides between `pending` and `published`, exactly as it does during a live publish, and a removed staging row gets its charged bytes back.
- Temp uploads and quarantined account data older than an hour are swept.
- Expired sessions and stale rate-limit rows are deleted.

A hard kill mid-publish therefore leaves the registry consistent after the next boot. Between boots, a background job garbage-collects blob files that no database row references (crash residue from deletes) and runs the daily integrity scrub described under Monitoring.

A hard kill mid-publish therefore leaves the registry consistent after the next boot.

## Next steps

- [configuration.md](configuration.md) — every config key and environment variable.
- [moderation.md](moderation.md) — approving submissions, terms and privacy, roles.
- Publisher-side workflows (sign in, publish, yank) live in the `twext` CLI.
