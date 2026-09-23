# TwextHub

> A lightweight registry of Twext-compiled extensions ("Twexts") for use in TurboWarp

## Table of Contents

<!-- START doctoc generated TOC please keep comment here to allow auto update -->
<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->

- [Highlights](#highlights)
- [Overview](#overview)
  - [Authors](#authors)
- [Usage](#usage)
- [Installation](#installation)
  - [Running with Docker](#running-with-docker)
- [Feedback and Contributing](#feedback-and-contributing)

<!-- END doctoc generated TOC please keep comment here to allow auto update -->

## Highlights

- Public, cursor-paginated discovery of published extensions (`/v1/extensions`, `/v1/search`).
- Namespaced publishing with a per-owner moderation gate: a first publish is `pending` until an admin approves; later publishes go straight to `published`.
- Sessions and scoped automation tokens (`publish`, `yank`).
- Per-account notifications for review decisions, terms bumps, and admin broadcasts (`GET /v1/notifications`), with a `twext notifications` command in the CLI.
- Compiled blobs live on disk, not in the database. Bearer tokens are stored only as SHA-256 hashes.

## Overview

TwextHub is the server-side half of the [Twext](https://github.com/twext/twext) workflow. A Twext project is compiled locally with the `twext` CLI, then published to a TwextHub instance with the resulting JavaScript IIFE and manifest metadata. Once an admin approves it, the version is listed in the public registry and available for download.

### Authors

Twext is maintained by the [Twext Team](https://github.com/twext).

## Usage

Three kinds of callers use the API:

- **The registry** — `GET /v1/extensions`, `/v1/search`, `GET /v1/@:namespace/:id` — is public and read-only. Blobs download via `GET /v1/@:namespace/:id/versions/:version/download`, which keeps serving yanked versions so existing consumers keep working.
- **A publisher** uses the `twext` command-line interface to create an account/sign in, and publish extension versions. _This requires at least Twext v1.0.0._
- **An admin** reviews that queue with `GET /v1/versions?status=pending` and approves or rejects each entry via `PATCH /v1/@:namespace/:id/versions/:version`. Admins also publish the terms/privacy text (`PATCH /v1/admin/terms`, `PATCH /v1/admin/privacy`) — a terms bump forces everyone to re-accept before publishing again.

CI can publish with automation tokens created at `POST /v1/tokens`; the `publish` scope covers publishing, `yank` covers `DELETE /v1/@:namespace/:id/versions/:version`.

## Installation

The server runs on Node.js >= 24 (ESM) and needs a Postgres database it can reach. The checked-in `config.yaml` points at a local development database (`localhost:5432`); deployments must override `database.url` — or set `TWEXTHUB_DATABASE_URL` — since the server refuses to boot without one.

```sh
npm install
createdb twexthub
export TWEXTHUB_DATABASE_URL=postgres://user:pass@localhost:5432/twexthub
npm start
```

`TWEXTHUB_DATABASE_URL` (or the `database.url` key in `config.yaml`) must point at the database created above — use the same user, password, and host as the `createdb` invocation (a local `postgres` superuser with no password maps to `postgres://postgres@localhost:5432/twexthub`).

Migrations in `migrations/*.sql` run in order on boot, or ahead of time with `npm run migrate`. The first account created on a fresh database gets role `admin`.

For production, set `publicBaseUrl` to the public URL of the instance (it's used to build download links) and run behind a TLS-terminating proxy.

All API paths are served under `apiRoot` in `config.yaml` (default `/v1`), so `/v1/extensions`, `/v0/extensions`, or `/ts/extensions` are all the same endpoint on a server with the matching `apiRoot`. Download links in API responses use the same prefix. The same value can be set with `TWEXTHUB_API_ROOT`.

### Running with Docker

A pre-built image is published to `ghcr.io/twext/twexthub`. The image is configured entirely through `TWEXTHUB_*` environment variables — there is no `config.yaml` baked in.

**Docker Compose** (includes Postgres):

```sh
docker compose -f compose.example.yml up -d
```

This starts a Postgres instance, runs migrations, and exposes TwextHub on `http://localhost:3000`. Data lives in named volumes (`postgres-data` and `twexthub-data`).

**Building from source:**

```sh
docker build -t twexthub:local .
```

**Running against an existing Postgres:**

```sh
docker run -d --name twexthub \
  -p 3000:3000 \
  -e TWEXTHUB_DATABASE_URL=postgres://user:pass@host:5432/twexthub \
  -e TWEXTHUB_PUBLIC_BASE_URL=https://hub.example.com \
  -v twexthub-data:/app/data \
  ghcr.io/twext/twexthub:latest
```

Every documented `TWEXTHUB_*` configuration variable corresponds to a `config.yaml` key in upper-case (e.g. `TWEXTHUB_API_ROOT`, `TWEXTHUB_REQUIRE_HTTPS`, `TWEXTHUB_SESSION_TTL_DAYS`). Test-only variables such as `TWEXTHUB_TEST_DATABASE_URL` are consumed by the test suite and CI only, and are not part of the configuration surface.

## Feedback and Contributing

Bug reports and feature requests go in [issues](https://github.com/twext/twexthub/issues); questions and ideas for the project are welcome in [discussions](https://github.com/twext/twexthub/discussions).

Contributions are welcome — open an issue first if the change is bigger than a typo fix.
