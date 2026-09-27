# Changelog

## 1.0.0 (unreleased)

- Move the API contract to `/v1`. Publishing now accepts gzipped Twext project tarballs and compiles them on the hub; the former compiled-code JSON request is no longer accepted.
- Store compiled blobs and source tarballs by SHA-256 digest, with integrity metadata and background blob checks.
- Add deprecation, distribution tags, SemVer range resolution, multiple owners, private extensions, and access grants.
- Add download counts, trending, discovery filters, badges, an Atom feed, and signed webhooks.
- Add profile fields and images, storage quotas, audit records, request logging, admin metrics, and the v1 OpenAPI specification.
- Bound builds by filesystem permissions, a V8 heap cap, a process address-space limit, and a timeout. Build network isolation remains a deployment responsibility; see the [hosting guide](docs/hosting.md#the-build-sandbox).
