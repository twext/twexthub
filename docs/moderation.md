# Moderation and administration

Running a registry means curating the publish queue. This guide covers the admin side: creating the first administrative account, approving and rejecting submissions, publishing terms and privacy, and managing roles. Publisher-side commands live in the `twext` CLI.

## Table of Contents

<!-- START doctoc generated TOC please keep comment here to allow auto update -->
<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->

- [The first account is an admin](#the-first-account-is-an-admin)
- [How the publish gate works](#how-the-publish-gate-works)
- [Reviewing the queue](#reviewing-the-queue)
- [Terms and privacy](#terms-and-privacy)
- [Accounts and roles](#accounts-and-roles)
- [Automation tokens and CI](#automation-tokens-and-ci)

<!-- END doctoc generated TOC please keep comment here to allow auto update -->

## The first account is an admin

On a fresh database the first account created is assigned the `admin` role. Create it with the `twext` CLI (its account sign-up hits the same endpoint); every later account is a regular user until an admin promotes it.

Admins act with a session token. To get one for scripting the queue:

```sh
curl -X POST -H 'Content-Type: application/json' \
  -d '{"namespace":"alice","password":"…"}' \
  https://hub.example.com/v0/auth/login
```

The response includes `token`; every admin endpoint below takes it as `Authorization: Bearer <token>`. Automation tokens are rejected by admin endpoints.

## How the publish gate works

A submitted version moves `staging → pending → published`, or `pending → rejected`. A published version can later be `yanked`.

- The first publish from an owner is held in `pending` until an admin approves it.
- Once an owner has any published version, every later publish skips review and goes straight to `published`.
- An owner can have only one version in the queue (`staging` or `pending`) at a time. To let a publisher correct and resubmit, reject the queued version — the rejection stores a reason and frees the slot.

Rejected, staging, and pending versions are neither listed publicly nor downloadable.

## Reviewing the queue

List submissions, oldest first:

```sh
curl -H 'Authorization: Bearer <session-token>' \
  'https://hub.example.com/v0/versions?status=pending'
```

Returns the pending versions with namespace, id, version, name, license, description, and timestamps. The list is paginated with `?limit` and `?cursor`.

Approve:

```sh
curl -X PATCH -H 'Authorization: Bearer <session-token>' \
  -H 'Content-Type: application/json' \
  -d '{"status":"approved"}' \
  https://hub.example.com/v0/@alice/myext/versions/1.0.0
```

Reject — a reason is required:

```sh
curl -X PATCH -H 'Authorization: Bearer <session-token>' \
  -H 'Content-Type: application/json' \
  -d '{"status":"rejected","reason":"The block ID collides with an existing extension."}' \
  https://hub.example.com/v0/@alice/myext/versions/1.0.0
```

Approving publishes the version, sets its `publishedAt`, and marks the owner as established so their next publish skips the queue.

The version address is `@<namespace>/<id>/versions/<version>`, under your `apiRoot` (default `/v0`).

## Terms and privacy

The registry can carry terms of service and a privacy policy. Neither exists until you publish it — the public endpoints return 404 beforehand.

- `PATCH /v0/admin/terms` with `{"body":"…"}` publishes the terms; `PATCH /v0/admin/privacy` does the same for privacy. Each update bumps the document version. On a fresh registry the first call creates the document.
- A terms bump forces every publisher to accept the new version before publishing again; the publish gate and other write endpoints reject them until `POST /v0/terms/accept`. Existing published versions keep serving.
- The current documents are public at `GET /v0/terms` and `GET /v0/privacy`.

Order matters when bootstrapping: create the terms document first, then accept it, then create the privacy document — approving a later terms bump requires having accepted the current one.

## Accounts and roles

Roles are `admin` and `normal`. Only admins change roles or act on other accounts.

- `PATCH /v0/users/:namespace` updates `displayName`, `role`, or `password` — self-service for your own password, or anything as admin for another account.
- Resetting a password revokes every session and automation token on that account.
- `DELETE /v0/users/:namespace` deletes the account, its versions, and its blobs. Published extensions disappear from the registry; the blob directory is quarantined and purged.

Sessions and automation tokens can be listed and revoked per account under `/v0/sessions` and `/v0/tokens`.

## Automation tokens and CI

Publishers script publishing with long-lived automation tokens scoped to `publish` and `yank`, created through the `twext` CLI. The server stores only SHA-256 hashes of token values, so tokens cannot be read back from the database. To kill a leaked token, delete it, or reset the account's password, which revokes everything.
