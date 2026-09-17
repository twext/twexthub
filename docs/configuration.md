# Configuration

Every TwextHub instance is configured by defaults, a `config.yaml` file, and environment variables. This reference covers all of them.

## Table of Contents

<!-- START doctoc generated TOC please keep comment here to allow auto update -->
<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->

- [How configuration is resolved](#how-configuration-is-resolved)
- [Server](#server)
- [Database](#database)
- [Auth](#auth)
- [Rate limits](#rate-limits)
- [Pagination](#pagination)
- [Behavior notes](#behavior-notes)
- [Data directory layout](#data-directory-layout)
- [Request size limits](#request-size-limits)
- [Not runtime configuration](#not-runtime-configuration)

<!-- END doctoc generated TOC please keep comment here to allow auto update -->

## How configuration is resolved

Defaults are merged with `config.yaml` (default path `./config.yaml`), and `TWEXTHUB_*` environment variables override both. Environment variables win.

The only required value is `database.url`, either in the file or as `TWEXTHUB_DATABASE_URL`. Without it the server exits on startup instead of booting.

`config.yaml` is overridable: `node src/server.js /path/to/config.yaml`, and `node src/migrate.js /path/to/config.yaml` or `node src/migrate.js --config file.yaml`.

Boolean environment variables must be exactly `true` or `false`; numeric ones must be positive integers. Anything else fails startup with a message naming the offending variable.

`dataDir` is resolved relative to the process working directory.

## Server

| Key             | Default                 | Environment                | Purpose                                                                  |
| --------------- | ----------------------- | -------------------------- | ------------------------------------------------------------------------ |
| `port`          | `3000`                  | `TWEXTHUB_PORT`            | TCP port to listen on                                                    |
| `dataDir`       | `./data`                | `TWEXTHUB_DATA_DIR`        | Directory holding published blobs and scratch space                      |
| `apiRoot`       | `/v0`                   | `TWEXTHUB_API_ROOT`        | Prefix for all routes; `/v0`, `v0`, and `/v0/` are the same              |
| `publicBaseUrl` | `http://localhost:3000` | `TWEXTHUB_PUBLIC_BASE_URL` | Client-facing base URL; used to build download links                     |
| `requireHttps`  | `false`                 | `TWEXTHUB_REQUIRE_HTTPS`   | Reject non-`https` requests with 403                                     |
| `trustProxy`    | `false`                 | `TWEXTHUB_TRUST_PROXY`     | Express trust proxy: `true`, `false`, a hop count, or an address pattern |

`trustProxy` accepts the [`trust proxy`](https://expressjs.com/en/guide/behind-proxies.html) value directly. With a reverse proxy in front, set it so IP-based rate limits and `requireHttps` see the client rather than the proxy.

## Database

| Key                              | Default      | Environment                         | Purpose                    |
| -------------------------------- | ------------ | ----------------------------------- | -------------------------- |
| `database.url`                   | — (required) | `TWEXTHUB_DATABASE_URL`             | Postgres connection string |
| `database.maxConnections`        | `10`         | `TWEXTHUB_DATABASE_MAX_CONNECTIONS` | Postgres pool size         |
| `database.connectTimeoutSeconds` | `30`         | —                                   | Connection timeout         |
| `database.idleTimeoutSeconds`    | `60`         | —                                   | Idle connection timeout    |

## Auth

| Key                   | Default                | Environment                 | Purpose                                     |
| --------------------- | ---------------------- | --------------------------- | ------------------------------------------- |
| `auth.sessionTtlDays` | `7`                    | `TWEXTHUB_SESSION_TTL_DAYS` | How long session tokens stay valid          |
| `auth.scrypt`         | `N: 16384, r: 8, p: 1` | —                           | scrypt cost parameters for password hashing |

## Rate limits

| Key                                 | Default | Environment                          | Purpose                          |
| ----------------------------------- | ------- | ------------------------------------ | -------------------------------- |
| `rateLimits.loginAttemptsPerWindow` | `5`     | `TWEXTHUB_LOGIN_ATTEMPTS_PER_WINDOW` | Failed logins allowed per window |
| `rateLimits.loginWindowMinutes`     | `15`    | `TWEXTHUB_LOGIN_WINDOW_MINUTES`      | Window length for login attempts |
| `rateLimits.signupsPerIpPerWindow`  | `5`     | `TWEXTHUB_SIGNUPS_PER_IP_PER_WINDOW` | Accounts per IP per window       |
| `rateLimits.signupWindowMinutes`    | `15`    | `TWEXTHUB_SIGNUP_WINDOW_MINUTES`     | Window length for signups        |

## Pagination

| Key                       | Default | Environment                         | Purpose                                      |
| ------------------------- | ------- | ----------------------------------- | -------------------------------------------- |
| `pagination.defaultLimit` | `20`    | `TWEXTHUB_PAGINATION_DEFAULT_LIMIT` | Page size when none is given                 |
| `pagination.maxLimit`     | `50`    | `TWEXTHUB_PAGINATION_MAX_LIMIT`     | Upper bound on `limit` for any list endpoint |

## Behavior notes

- Login is limited per namespace-and-IP and per IP, both at once. Signups are limited per IP. Exceeding a limit returns 429 with a `Retry-After` header. Rate-limit rows are pruned by a background job and again on boot.
- `requireHttps` only distinguishes real clients behind a TLS-terminating proxy when `trustProxy` is set.
- `publicBaseUrl` appears in API responses as the start of download URLs. Keep it the client-facing address, not an internal one.
- `apiRoot` moves every route at once, including the moderation queue and download links. Decide on it before going public; changing it later moves the registry's URLs.

## Data directory layout

```
data/
├── blobs/
│   └── <namespace>/
│       └── <extension-id>/
│           └── <version>.js     # published blobs (durable)
├── tmp/                         # in-flight publish uploads
└── quarantine/                  # deleted accounts awaiting final purge
```

`blobs/` holds durable content. `tmp/` and `quarantine/` are swept of anything older than an hour on boot.

## Request size limits

Ordinary JSON bodies are capped at 100 KB. The publish endpoint accepts up to 25 MB. A proxy in front must permit the larger body size or publishes will fail there.

## Not runtime configuration

`TWEXTHUB_TEST_DATABASE_URL` is consumed by the test suite and CI only. It is not part of the configuration surface.
