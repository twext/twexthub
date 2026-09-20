// Pre-rendered notification messages and insert helpers. Every insert takes
// the caller's transaction so a notification can never outlive the event that
// produced it.
export async function notifyUser(tx, userId, kind, message, payload = {}) {
  await tx`
    INSERT INTO notifications (user_id, kind, message, payload)
    VALUES (${userId}, ${kind}, ${message}, ${tx.json(payload)}::jsonb)
  `;
}

// Fan out to every user matching a WHERE fragment (used for terms bumps and
// broadcasts). Returns the number of rows inserted.
export async function notifyUsersMatching(tx, where, kind, message, payload = {}) {
  const rows = await tx`
    INSERT INTO notifications (user_id, kind, message, payload)
    SELECT id, ${kind}, ${message}, ${tx.json(payload)}::jsonb FROM users ${where}
    RETURNING 1
  `;
  return rows.length;
}

export function reviewApprovedMessage(namespace, id, version) {
  return `${id}@${version} was approved and is live. View it at @${namespace}/${id}.`;
}

export function reviewRejectedMessage(id, version, reason) {
  return `${id}@${version} was rejected: ${reason.trim()}`;
}

export function termsBumpedMessage(version) {
  return `The Terms of Service were updated to version ${version}. Accept the new version before publishing again.`;
}

export function tokensRevokedMessage(actorNamespace) {
  return `Your password was reset by an admin (@${actorNamespace}); all sessions and automation tokens were revoked.`;
}

export function roleChangedMessage(role) {
  return `Your account role changed to "${role}".`;
}
