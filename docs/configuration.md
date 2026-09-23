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
- [Compiler (`twext`)](#compiler-twext)
- [Pagination](#pagination)
- [CORS](#cors)
- [Behavior notes](#behavior-notes)
- [Data directory layout](#data-directory-layout)
- [Request size limits](#request-size-limits)
- [Not runtime configuration](#not-runtime-configuration)

<!-- END doctoc generated TOC please keep comment here to allow auto update -->

## How configuration is resolved

Defaults are merged with `config.yaml` (default path `./config.yaml`), and `TWEXTHUB_*` environment variables override both. Environment variables win.

The only required value is `database.url`, either in the file or as `TWEXTHUB_DATABASE_URL`. Without it the server exits on startup instead of booting.

`config.yaml` is overridable: `node src/server.js /path/to/config.yaml`, and `node src/migrate.js /path/to/config.yaml` or `node src/migrate.js --config file.yaml`.

Boolean environment variables must be exactly `true` or `false`; numeric ones must be positive integers. Anything else fails startup with a message naming the offending variable. `TWEXTHUB_CORS_ALLOWED_ORIGINS` is the exception: it takes a comma-separated list of origins, or `*`.

`dataDir` is resolved relative to the process working directory.

## Server

| Key             | Default                 | Environment                | Purpose                                                                  |
| --------------- | ----------------------- | -------------------------- | ------------------------------------------------------------------------ |
| `port`          | `3000`                  | `TWEXTHUB_PORT`            | TCP port to listen on                                                    |
| `dataDir`       | `./data`                | `TWEXTHUB_DATA_DIR`        | Directory holding published blobs and scratch space                      |
| `apiRoot`       | `/v1`                   | `TWEXTHUB_API_ROOT`        | Prefix for all routes; `/v1`, `v1`, and `/v1/` are the same              |
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
| `rateLimits.publishesPerWindow`     | `20`    | `TWEXTHUB_PUBLISHES_PER_WINDOW`      | Publishes per account per window |
| `rateLimits.publishWindowMinutes`   | `15`    | `TWEXTHUB_PUBLISH_WINDOW_MINUTES`    | Window length for publishes      |

Publishes are rate limited per account because the server compiles each upload — the limit protects the build sandbox as much as the database.

## Compiler (`twext`)

Publishing uploads sources; TwextHub compiles them server-side in a sandboxed worker process.

| Key                           | Default | Environment                              | Purpose                                                                                                                                  |
| ----------------------------- | ------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `twext.version`               | `null`  | `TWEXTHUB_TWEXT_VERSION`                 | Pin the `@twext/twext` compiler version; installed on demand into `dataDir/twext-versions/`. When empty, the bundled dependency is used. |
| `twext.compileTimeoutSeconds` | `20`    | `TWEXTHUB_TWEXT_COMPILE_TIMEOUT_SECONDS` | Kill a build sandbox that runs longer than this                                                                                          |

The bundled compiler is the `@twext/twext` dependency in `package.json`. Pinning a different version downloads it from npm on first use (npm must be on `PATH`), then reuses the cached install.

## Pagination

| Key                       | Default | Environment                         | Purpose                                      |
| ------------------------- | ------- | ----------------------------------- | -------------------------------------------- |
| `pagination.defaultLimit` | `20`    | `TWEXTHUB_PAGINATION_DEFAULT_LIMIT` | Page size when none is given                 |
| `pagination.maxLimit`     | `50`    | `TWEXTHUB_PAGINATION_MAX_LIMIT`     | Upper bound on `limit` for any list endpoint |

## CORS

| Key                   | Default | Environment                     | Purpose                                                          |
| --------------------- | ------- | ------------------------------- | ---------------------------------------------------------------- |
| `cors.allowedOrigins` | `*`     | `TWEXTHUB_CORS_ALLOWED_ORIGINS` | Origins allowed to read the API from a browser; `*` for any site |

`*` lets any origin read the registry — the default, since consumers like the TurboWarp editor load extensions from their own domain. To restrict, set a list of origins, either in `config.yaml` as a YAML array or as the environment variable with origins separated by commas: `TWEXTHUB_CORS_ALLOWED_ORIGINS=https://editor.example,https://hub.example`. A browser request from an allowed origin gets that origin echoed back in `Access-Control-Allow-Origin`; from any other origin it gets no CORS headers at all.

Requests without an `Origin` header (the `twext` CLI, curl) are never affected. Publishing and moderation use bearer tokens, so allowing an origin does not let it act as another user — CORS only governs what a browser page can read.

## Behavior notes

- Login is limited per namespace-and-IP and per IP, both at once. Signups are limited per IP. Publishes are limited per account. Exceeding a limit returns 429 with a `Retry-After` header. Rate-limit rows are pruned by a background job and again on boot.
- `requireHttps` only distinguishes real clients behind a TLS-terminating proxy when `trustProxy` is set.
- `publicBaseUrl` appears in API responses as the start of download URLs. Keep it the client-facing address, not an internal one.
- `apiRoot` moves every route at once, including the moderation queue and download links. Decide on it before going public; changing it later moves the registry's URLs.

## Data directory layout

```text
data/
├── blobs/
│   └── <namespace>/
│       └── <extension-id>/
│           └── <version>.js     # published blobs (durable)
├── twext-versions/              # pinned @twext/twext compiler installs
│   └── <version>/
├── tmp/                         # in-flight publish uploads and build sandboxes
└── quarantine/                  # deleted accounts awaiting final purge
```

`blobs/` holds durable content. `tmp/` and `quarantine/` are swept of anything older than an hour on boot. `twext-versions/` is a cache — safe to delete when nothing pins that version.

## Request size limits

Ordinary JSON bodies are capped at 100 KB. The publish endpoint accepts up to 25 MB. A proxy in front must permit the larger body size or publishes will fail there.

## Not runtime configuration

`TWEXTHUB_TEST_DATABASE_URL` is consumed by the test suite and CI only. It is not part of the configuration surface.
