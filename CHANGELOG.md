# Changelog

All notable changes to TwextHub are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
versions with [SemVer](https://semver.org/). The API surface documented in
[openapi/v1.yml](openapi/v1.yml) is frozen as of 1.0.0: breaking changes bump
the major version, additive changes the minor.

## [1.0.0] - 2026-09-25

The first stable release. Publishes are now source tarballs that the hub
compiles itself, and the registry gained the governance and discovery features
listed below.

### Added

- Build on publish: `POST /@:namespace/:id/versions` accepts a gzipped project
  tarball (`application/gzip`) instead of compiled JSON. The server extracts
  `twext.yml`, validates it, and compiles in a sandboxed child process with
  filesystem, memory, and wall-time limits. The moderation queue carries the
  build log and a source URL; owners can fetch their source back with
  `GET /@:namespace/:id/versions/:version/source`.
- Content integrity: every published blob's SHA-256 is recorded and exposed as
  `dist.digest` (and `dist.integrity` in SRI form). `GET /blobs/:digest`
  serves content-addressed downloads with an `immutable` cache header, and
  identical re-publishes share one file on disk.
- Deprecation as a softer alternative to yank:
  `PATCH /@:namespace/:id/versions/:version/deprecate` sets or clears a
  message; deprecated versions stay listable and downloadable and are flagged
  in API responses.
- Dist-tags: `GET`/`PUT`/`DELETE /@:namespace/:id/tags[/:tag]` manage
  npm-style aliases; `latest` is reserved and implicit.
- Download metrics: downloads are counted per version per day (hashed IPs
  only), surfaced on detail/listing responses, `/v1/stats`, and
  `GET /v1/extensions/trending`, with `sort=recent|downloads|updated|name` and
  a `license=` filter on `/v1/extensions` and `/v1/search`.
- Multi-owner extensions: `extension_owners` lets several accounts publish,
  yank, deprecate, and tag under one namespace; `GET /@:namespace/:id/owners`,
  `PUT`/`DELETE /@:namespace/:id/owners/:namespace`.
- Webhooks: owners subscribe extensions to signed registry events
  (`version.published`, `version.yanked`, `version.deprecated`,
  `version.rejected`, `owners.changed`) delivered with an HMAC-SHA256
  signature, with retries and SSRF guards on target URLs.
- SemVer range resolution: `GET /@:namespace/:id/versions/resolve?range=^1.2`
  returns the newest published version satisfying a range.
- Discovery extras: shields-style `GET /v1/badge/@:namespace/:id` and an Atom
  feed at `GET /v1/feed.atom`.
- Profiles: `PATCH /v1/users/:namespace` edits bio, website, GitHub link,
  avatar, and banner; `GET /v1/users/:namespace/avatar` serves a deterministic
  identicon when no avatar is set.
- Private extensions: per-extension visibility with per-account access grants,
  configurable size caps, per-account storage quotas, and an append-only audit
  log readable at `GET /v1/admin/audit`.
- Admin observability: `GET /v1/admin/metrics` renders Prometheus text-format
  counters (registry state, storage, HTTP traffic), with optional structured
  JSON request logging (`logging.requests` / `TWEXTHUB_LOG_REQUESTS`).
- Maintenance: a background job garbage-collects unreferenced blobs and
  verifies stored blobs against their recorded digests, exporting failures as
  `twexthub_storage_integrity_errors`.

### Changed

- Publish requests are graded against `limits.maxSourceBytes` for the tarball
  and `limits.maxBlobBytes` for compiled output; JSON publishes of compiled
  code are gone (a legacy JSON body gets `415`).
- `versions.status` accepts `deprecated` alongside the earlier states.

## [0.1.0]

Initial API surface: namespaced publishing with a per-owner moderation gate,
sessions and scoped automation tokens, notifications, public discovery, and
content-addressed blob storage.
