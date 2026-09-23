# Hosting TwextHub

TwextHub is a registry for Twext-compiled extensions. Publishers submit their project sources through the `twext` CLI; the registry compiles them server-side, applies a per-owner moderation gate, and serves downloads to TurboWarp. This guide is for people running an instance. Publisher-facing behavior is documented by the [twext](https://github.com/twext/twext) project.

## Table of Contents

<!-- START doctoc generated TOC please keep comment here to allow auto update -->
<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->

- [What you need](#what-you-need)
- [Run from source](#run-from-source)
- [Run with Docker](#run-with-docker)
- [Configuration](#configuration)
- [Behind a reverse proxy](#behind-a-reverse-proxy)
- [Blobs must live on persistent storage](#blobs-must-live-on-persistent-storage)
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

Publish requests can carry up to 25 MB of JSON (the project sources plus manifest). nginx's default `client_max_body_size` is 1 MB, so raise it for the instance; otherwise large publishes die at the proxy. Publishing is additionally rate limited per account (20 per 15 minutes by default), which also throttles the build sandbox.

## Blobs must live on persistent storage

Published blobs are written to the local disk under `dataDir`, not to the database. The `versions` table records that a version exists; the blob is a file on whatever machine handled the publish. This shapes every deployment on a container platform:

- **Replacing the container loses blobs.** If the instance's storage is ephemeral — an ECS/Fargate task without a mounted volume, a Coolify service rebuilt fresh — every deploy deletes the blobs while the database keeps the `versions` rows. Extensions stay listed but their download endpoints 404. Mount a persistent volume at `/app/data` (the image declares it as a volume) so redeploys reuse it.
- **Scaling to more than one instance requires shared blob storage.** Two instances behind a load balancer that share Postgres but have separate disks will 404 on downloads half the time: a blob written by instance A only exists there. Publishing is safe across instances (the per-extension locks live in Postgres), but the blob directory must be shared — an EFS mount on Fargate, a shared block volume, or a single instance.

Point `TWEXTHUB_DATA_DIR` (or `dataDir`) at the persistent mount and keep it in sync with database backups.

The image bundles the `@twext/twext` compiler it compiles publishes with. If you pin a different `twext.version` (`TWEXTHUB_TWEXT_VERSION`), the server installs it from npm on first use, so the container needs outbound npm access then; the install lands in `data/twext-versions/` and is reused thereafter.

## Upgrades

Releases are tagged with semver, and `latest` tracks `main`. To upgrade, pull the new image or deploy the new tree and restart — new migrations apply automatically on boot. A database backup before the restart is cheap insurance if a migration goes wrong mid-run.

## Backups

Two things hold state: the Postgres database and the data directory.

- Database: a standard `pg_dump`, restored onto a fresh database with `psql`.
- Data directory: the compiled extension blobs. Blobs are written once at publish time and cannot be regenerated (the registry stores the uploaded sources too, so a blob could in principle be recompiled, but that requires re-running the compiler and is not something the server does). Losing the data directory while keeping the database leaves published versions listed but their download endpoints 404ing. Back up `blobs/` (or the whole `dataDir`) together with the database.

`tmp/` and `quarantine/` inside the data directory are scratch space; only `blobs/` matters for restores.

## Boot-time cleanup

On every start the server reconciles leftover state:

- Staging versions older than an hour are promoted to `pending` or `published` when their blob exists, and removed when it does not. That is crash recovery for publishes interrupted mid-write.
- Temp uploads, build sandboxes, and quarantined account data older than an hour are swept.
- Expired sessions and stale rate-limit rows are deleted.

A hard kill mid-publish therefore leaves the registry consistent after the next boot.

## Next steps

- [configuration.md](configuration.md) — every config key and environment variable.
- [moderation.md](moderation.md) — approving submissions, terms and privacy, roles.
- Publisher-side workflows (sign in, publish, yank) live in the `twext` CLI.
