# Notifications

TwextHub keeps a per-account notification mailbox. Review decisions, terms updates, admin password resets, role changes, and instance-wide broadcasts all land there. Clients read the mailbox over the API; the `twext` CLI ships a `notifications` command on top of it (requires Twext CLI v1.0.0 or above).

## Table of Contents

<!-- START doctoc generated TOC please keep comment here to allow auto update -->
<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->

- [What generates a notification](#what-generates-a-notification)
- [Reading the mailbox](#reading-the-mailbox)
- [Marking notifications read](#marking-notifications-read)
- [Broadcasts](#broadcasts)
- [Retention](#retention)

<!-- END doctoc generated TOC please keep comment here to allow auto update -->

## What generates a notification

Every notification has a `kind`:

| Kind              | Emitted when                                                                             | Recipient                                                                                               |
| ----------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `review.approved` | An admin approves a pending version.                                                     | The version's owner.                                                                                    |
| `review.rejected` | An admin rejects a pending version. The payload carries the `reason`.                    | The version's owner.                                                                                    |
| `terms.bumped`    | A terms update lands (version 2 or later). The first terms document is not a bump.       | Every account that had accepted a previous version — exactly the accounts the publish gate would block. |
| `tokens.revoked`  | An admin resets another account's password. Self-service password changes notify no one. | The account whose sessions and automation tokens were revoked.                                          |
| `role.changed`    | An admin changes an account's role.                                                      | The account whose role changed.                                                                         |
| `broadcast`       | An admin posts a registry-wide message.                                                  | Every account at the moment of the call.                                                                |

Notifications are written in the same transaction as the event that produced them: a rolled-back review or password change leaves no notification behind, and a notification never appears for a decision that did not stick.

Each notification carries a pre-rendered `message` plus a structured `payload` (e.g. `namespace`, `id`, `version`, `reason` for review decisions) so clients can match notifications against a local project without parsing the message.

## Reading the mailbox

```sh
curl -H 'Authorization: Bearer <token>' \
  'https://hub.example.com/v1/notifications?limit=20'
```

Returns notifications newest first, with `unreadCount` for the whole mailbox (not just the page) so a client can render an unread badge from this single call. The list is cursor-paginated with `?limit` and `?cursor`; pass `?unread=true` to see only unread rows.

Both sessions and automation tokens can read the mailbox. There is no admin override — admins read their own mailbox like everyone else.

## Marking notifications read

```sh
curl -X POST -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  -d '{"ids":["12","13"]}' \
  https://hub.example.com/v1/notifications/read
```

Send either `ids` (up to 100) or `all: true`, never both. The call is idempotent: ids that were already read or belong to another account are ignored, and the response reports only newly read rows as `updated`.

Reading is not automatic — the CLI marks rows read only when you pass `--read`.

## Broadcasts

Admins post a registry-wide message with `POST /v1/admin/notifications`:

```sh
curl -X POST -H 'Authorization: Bearer <session-token>' \
  -H 'Content-Type: application/json' \
  -d '{"message":"Scheduled maintenance tonight at 02:00 UTC."}' \
  https://hub.example.com/v1/admin/notifications
```

The message is capped at 280 characters. Fan-out happens at insert time — every account gets its own row, and accounts created later do not see old broadcasts. The response reports how many mailboxes the message reached. Automation tokens are rejected, like on every admin endpoint.

## Retention

The mailbox keeps the newest 200 notifications per account; an insert beyond that deletes the oldest row immediately. Unread notifications can therefore age out under sustained traffic — treat the mailbox as recent activity, not an archive.
