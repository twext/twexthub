import { normalizeApiRoot } from './util.js';

export function userToObject(row) {
  return {
    namespace: row.namespace,
    displayName: row.display_name,
    role: row.role,
    hasPublished: row.has_published,
    createdAt: row.created_at.toISOString(),
    termsAcceptedVersion: row.terms_accepted_version ?? null,
  };
}

export function sessionToObject(row) {
  return {
    id: String(row.id),
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    lastUsedAt: row.last_used_at ? row.last_used_at.toISOString() : null,
  };
}

export function automationTokenToObject(row) {
  return {
    id: String(row.id),
    name: row.name,
    scopes: row.scopes,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
    lastUsedAt: row.last_used_at ? row.last_used_at.toISOString() : null,
  };
}

export function legalDocumentToObject(row) {
  return {
    version: row.version,
    body: row.body,
    updatedAt: row.updated_at.toISOString(),
  };
}

export function versionToObject(row, config) {
  const out = {
    namespace: row.namespace,
    id: row.extension_id,
    version: row.version,
    status: row.status,
    name: row.name,
    license: row.license,
    description: row.description,
    createdAt: row.created_at.toISOString(),
  };
  if (row.author) out.author = row.author;
  if (row.published_at) out.publishedAt = row.published_at.toISOString();
  if (row.status === 'published' || row.status === 'yanked') {
    out.dist = {
      downloadUrl: downloadUrl(config, row.namespace, row.extension_id, row.version),
    };
  }
  return out;
}

export function downloadUrl(config, namespace, id, version) {
  const apiRoot = normalizeApiRoot(config.apiRoot);
  const root = apiRoot ? `/${apiRoot}` : '';
  return `${config.publicBaseUrl.replace(/\/$/, '')}${root}/@${namespace}/${id}/versions/${version}/download`;
}

export function extensionSummaryFromRow(row) {
  return {
    namespace: row.namespace,
    id: row.extension_id,
    name: row.name,
    version: row.version,
    description: row.description,
    publishedAt: row.published_at.toISOString(),
  };
}

export function extensionDetailFromRow(row, versions) {
  return {
    ...extensionSummaryFromRow(row),
    author: row.author ?? '',
    license: row.license,
    color1: row.color1 ?? null,
    color2: row.color2 ?? null,
    color3: row.color3 ?? null,
    versions,
  };
}

export function pendingVersionToObject(row, config) {
  return {
    ...versionToObject(row, config),
    ownerNamespace: row.namespace,
  };
}
