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
  https://hub.example.com/v1/sessions
```

The response includes `token`; every admin endpoint below takes it as `Authorization: Bearer <token>`. An automation token works on these endpoints too, once it carries the `admin` scope — see [Automation tokens and CI](#automation-tokens-and-ci). The session is the shorter route, since it needs no grant.

## How the publish gate works

A submitted version moves `staging → pending → published`, or `pending → rejected`. A published version can later be `yanked`.

- The namespace account's first publish is held in `pending` until an admin approves it, including a publish submitted by a co-owner.
- Once the namespace has a published version, later publishes to it skip review and go straight to `published`.
- A publishing account can have only one version in the queue (`staging` or `pending`) at a time. To let a publisher correct and resubmit, reject the queued version — the rejection stores a reason and frees the slot.

Rejected and staging versions are neither listed publicly nor downloadable. Pending versions are available to an admin for review, by session or by a token holding the `admin` scope.

## Reviewing the queue

List submissions, oldest first:

```sh
curl -H 'Authorization: Bearer <session-token>' \
  'https://hub.example.com/v1/versions?status=pending'
```

Returns the pending versions with namespace, id, version, name, license, description, build log, source URL, and timestamps. The list is paginated with `?limit` and `?cursor`.

Approve:

```sh
curl -X PATCH -H 'Authorization: Bearer <session-token>' \
  -H 'Content-Type: application/json' \
  -d '{"status":"approved"}' \
  https://hub.example.com/v1/@alice/myext/versions/1.0.0
```

Reject — a reason is required:

```sh
curl -X PATCH -H 'Authorization: Bearer <session-token>' \
  -H 'Content-Type: application/json' \
  -d '{"status":"rejected","reason":"The block ID collides with an existing extension."}' \
  https://hub.example.com/v1/@alice/myext/versions/1.0.0
```

Approving publishes the version, sets its `publishedAt`, and marks the namespace account as established so its next publish skips the queue, including one submitted by a co-owner.

The version address is `@<namespace>/<id>/versions/<version>`, under your `apiRoot` (default `/v1`).

## Terms and privacy

The registry can carry terms of service and a privacy policy. Neither exists until you publish it — the public endpoints return 404 beforehand.

- `PATCH /v1/admin/terms` with `{"body":"…"}` publishes the terms; `PATCH /v1/admin/privacy` does the same for privacy. Each update bumps the document version. On a fresh registry the first call creates the document.
- A terms bump forces every publisher to accept the new version before publishing again; the publish gate and other write endpoints reject them until the account patches itself with the new `termsAcceptedVersion`. Existing published versions keep serving.
- The current documents are public at `GET /v1/terms` and `GET /v1/privacy`.

Order matters when bootstrapping: create the terms document first, then accept it with `PATCH /v1/users/{namespace}`, then create the privacy document — approving a later terms bump requires having accepted the current one.

## Accounts and roles

Roles are `admin` and `normal`. Only admins change roles or act on other accounts.

- `PATCH /v1/users/:namespace` updates `displayName`, `role`, or `password` — self-service for your own password, or anything as admin for another account.
- Resetting a password revokes every session and automation token on that account.
- `DELETE /v1/users/:namespace` deletes the account and its versions. Unreferenced blobs and source tarballs are removed after the database delete; shared content remains available to other accounts.

Sessions and automation tokens can be listed and revoked per account under `/v1/sessions` and `/v1/tokens`, which take the `manage:sessions` and `manage:tokens` scopes respectively.

## Automation tokens and CI

Publishers script publishing with long-lived automation tokens created through the `twext` CLI. The server stores only SHA-256 hashes of token values, so tokens cannot be read back from the database. To kill a leaked token, delete it, or reset the account's password, which revokes everything.

A token carries a list of scopes, and a session carries all of them. The scopes are:

| Scope             | Opens                                                               |
| ----------------- | ------------------------------------------------------------------- |
| `publish`         | Publishing a version, its dist-tags, and its per-extension webhooks |
| `yank`            | `DELETE /v1/@:namespace/:id/versions/:version`                      |
| `read:source`     | Downloading a version's source tarball                              |
| `manage:account`  | `PATCH`/`DELETE /v1/users/:namespace` and the profile images        |
| `manage:orgs`     | The `/v1/orgs` routes, including owners and namespace webhooks      |
| `manage:sessions` | Listing and revoking sessions                                       |
| `manage:tokens`   | The `/v1/tokens` routes                                             |
| `admin`           | `/v1/admin/*` and version review                                    |

A CI token that only publishes wants `publish` and nothing else. A token that also archives sources wants `read:source` alongside it. That is the whole design: give a token the scopes its job needs and no more, and the rest of the account stays out of its reach.

Two rules keep the grants honest. A token can only be granted a scope it already holds, so a leaked token cannot be spent minting a more powerful one — the same limit keeps an operator from handing a narrow token to a contractor and having it hand back a wider one. And `admin` is never enough on its own: the account behind the token must carry the `admin` role as well, so a regular account cannot reach the admin surface however it was signed. Both checks run on every admin request.

A token acts as the account that minted it, never above it. It publishes only the extensions that account owns, administers only the organizations it owns, and a token holding every scope is a session in everything but how it expires and how it is revoked.

The two self-revocation routes stay keyed to the kind of credential rather than a scope, because each deletes the caller's own row and the `sessions` and `automation_tokens` id sequences are independent. `DELETE /v1/sessions/current` is session-only; a token that reached it would delete whatever session shared its id. `DELETE /v1/tokens/current` refuses a session for the mirror reason.
