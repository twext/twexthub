# Organizations

An organization is a namespace that belongs to a group of people instead of to a single account. It publishes extensions, has a display name, bio, links, avatar and banner, and can register webhooks — but it has no password, cannot sign in, and holds no sessions or automation tokens of its own. It is always acted for by the accounts on its owner list, using their own credentials.

This is the same thing as a personal namespace from the outside: `@acme/widget` resolves the same way whether `acme` is an account or an organization. The difference is who may write to it.

## Table of Contents

<!-- START doctoc generated TOC please keep comment here to allow auto update -->
<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->

- [Creating an organization](#creating-an-organization)
- [Owners](#owners)
- [Publishing and visibility](#publishing-and-visibility)
- [Co-owning an extension](#co-owning-an-extension)
- [Profile and images](#profile-and-images)
- [Webhooks](#webhooks)
- [Accounts and organizations](#accounts-and-organizations)
- [Deleting an organization](#deleting-an-organization)

<!-- END doctoc generated TOC please keep comment here to allow auto update -->

## Creating an organization

```sh
curl -X POST -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  -d '{"namespace":"acme","displayName":"Acme Inc"}' \
  https://hub.example.com/v1/orgs
```

The namespace is shared with accounts, so a name already in use is a `409`; names follow the same rule as an account (`lowercase letters, digits and hyphens`). Creating one needs the current Terms of Service accepted and is rate limited like a signup. The caller becomes the organization's first owner.

`GET /v1/orgs` lists organizations newest first, and `GET /v1/orgs/:namespace` reads one. Both are public.

## Owners

Owners are ordinary accounts. Any owner — or an admin — may manage the organization; there is no per-owner permission level, and every owner can do everything.

```sh
# List owners (public)
curl https://hub.example.com/v1/orgs/acme/owners

# Add or remove one
curl -X PUT -H 'Authorization: Bearer <token>' \
  https://hub.example.com/v1/orgs/acme/owners/alice
curl -X DELETE -H 'Authorization: Bearer <token>' \
  https://hub.example.com/v1/orgs/acme/owners/alice
```

Adding an account that is already an owner is a `204` rather than an error, so a retried request does not need to know whether the first attempt landed. Adding and removing notify the account in question.

The last owner cannot be removed (`409`). An organization nobody owns cannot be changed by anyone, so it is either handed on first or deleted. An account that is the last owner of an organization also cannot be deleted from `DELETE /v1/users/:namespace` for the same reason. An organization cannot be an owner of another organization.

## Publishing and visibility

`GET /v1/orgs/:namespace/extensions` is the registry listing scoped to the organization, with the same `sort`, `license`, cursor and paging parameters as `GET /v1/extensions?namespace=:namespace`. An owner of the organization sees its private extensions; everyone else sees only the public ones.

Owners publish to the organization's namespace with the same `twext publish` flow as for an account. The first publish to a namespace still requires admin approval, so a new organization's first extension is reviewed exactly like a new account's.

## Co-owning an extension

An organization can be given ownership of an extension, so a group can help maintain something published under someone else's namespace. The owner of the extension invites the organization, and the invitation is deliberately not a grant:

```sh
# An owner of @alice/widget invites @acme
curl -X PUT -H 'Authorization: Bearer <token>' \
  https://hub.example.com/v1/@alice/widget/owners/acme

# An owner of @acme accepts, and speaks for the rest of them
curl -X POST -H 'Authorization: Bearer <token>' \
  https://hub.example.com/v1/@alice/widget/owners/acme/accept
```

Until it is accepted, the organization has no access: not to publishing, not to private versions, not to the listing. Accounts on the organization's owner list are notified of the invitation and of the withdrawal of one, and `GET /v1/@alice/widget/owners` reports the organization with `"kind": "organization"` once it is in. Removing it with `DELETE` withdraws a pending invitation if there is one, and otherwise removes the grant; either way the partners are notified.

An account can be invited the same way, answering its own invitation. `GET /v1/@alice/widget/owners/pending` is the inbox for both: an account sees what was addressed to it, and an owner of `@acme` sees what was addressed to `@acme`.

Accepting an invitation grants management of the extension. It does not move the published address, the download history, the tags, or the webhooks — those stay with the namespace that published the extension.

## Profile and images

`PATCH /v1/orgs/:namespace` changes the display name, bio, website, GitHub username and the external avatar/banner URLs. These are the same fields an account has, with the same validation.

Uploaded avatars and banners work exactly as they do for an account:

```sh
curl -X PUT -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: image/png' \
  --data-binary @avatar.png \
  https://hub.example.com/v1/orgs/acme/avatar
```

`GET /v1/orgs/:namespace/avatar` streams the upload, redirects to the external URL, or falls back to the identicon when the organization has neither. `DELETE` removes the upload and lets whatever remains show through. The banner has no identicon fallback — an organization with no banner is a `404`.

## Webhooks

A webhook registered on an organization watches every extension in its namespace, instead of one `id`:

```sh
curl -X POST -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com/hooks","events":["version.published"]}' \
  https://hub.example.com/v1/orgs/acme/webhooks
```

A publish, yank, deprecation, rejection or owner change under `@acme` then reaches one URL, with no need to register anything per extension. The per-extension webhooks at `POST /v1/@:namespace/:id/webhooks` are a separate collection and are unaffected; an id from one is a `404` at the other. The signing secret is returned once, on creation, exactly as for a per-extension webhook; listing never returns it.

## Accounts and organizations

An organization is not an account, so the account endpoints refuse it rather than pretending:

- `POST /v1/sessions` (sign in) is a `403` — an organization has no credentials, so the namespace is refused before the password is ever checked.
- `PATCH` and `DELETE /v1/users/:namespace` are a `403`, and point at `/v1/orgs/:namespace`.
- `GET /v1/users/:namespace` does answer for an organization, with `kind` set to `organization` and without `role` or `termsAcceptedVersion`, since an organization has neither.

## Deleting an organization

`DELETE /v1/orgs/:namespace`, by an owner or an admin, removes the profile and cascades to every extension, version, image and webhook under the namespace, and to the owner list. The blobs are content-addressed and are kept as long as any version anywhere still references them, so deleting an organization does not disturb another namespace's files.
