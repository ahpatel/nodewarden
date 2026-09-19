import type { OrganizationFolder } from '../types';

// Organization-owned folders. Names are EncStrings encrypted with the
// organization key (like collections), so the server never decrypts them.
// Management is owner/admin-only; reads are available to confirmed members so
// sync can surface them through the standard folders list.

const ORGANIZATION_FOLDER_COLUMNS = 'id, organization_id, name, creation_date, revision_date';

function mapOrganizationFolderRow(row: any): OrganizationFolder {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    creationDate: row.creation_date,
    revisionDate: row.revision_date,
  };
}

// Lookup by id across all orgs. Used by the user-folder endpoints to detect
// and proxy organization folder operations; callers must still check org
// membership before acting.
export async function getOrganizationFolderById(db: D1Database, id: string): Promise<OrganizationFolder | null> {
  const row = await db
    .prepare(`SELECT ${ORGANIZATION_FOLDER_COLUMNS} FROM organization_folders WHERE id = ?`)
    .bind(id)
    .first<any>();
  return row ? mapOrganizationFolderRow(row) : null;
}

export async function getOrganizationFolder(
  db: D1Database,
  organizationId: string,
  id: string
): Promise<OrganizationFolder | null> {
  const row = await db
    .prepare(`SELECT ${ORGANIZATION_FOLDER_COLUMNS} FROM organization_folders WHERE id = ? AND organization_id = ?`)
    .bind(id, organizationId)
    .first<any>();
  return row ? mapOrganizationFolderRow(row) : null;
}

export async function listOrganizationFolders(db: D1Database, organizationId: string): Promise<OrganizationFolder[]> {
  const result = await db
    .prepare(`SELECT ${ORGANIZATION_FOLDER_COLUMNS} FROM organization_folders WHERE organization_id = ? ORDER BY creation_date ASC`)
    .bind(organizationId)
    .all<any>();
  return (result.results || []).map(mapOrganizationFolderRow);
}

// All folders across every organization the user is a confirmed member of.
// Mirrors listConfirmedOrganizationsForUser semantics.
export async function listOrganizationFoldersForUser(db: D1Database, userId: string): Promise<OrganizationFolder[]> {
  const result = await db
    .prepare(
      `SELECT f.id, f.organization_id, f.name, f.creation_date, f.revision_date
       FROM organization_folders f
       INNER JOIN organization_users ou ON ou.organization_id = f.organization_id
       WHERE ou.user_id = ? AND ou.status = 3
       ORDER BY f.creation_date ASC`
    )
    .bind(userId)
    .all<any>();
  return (result.results || []).map(mapOrganizationFolderRow);
}

export async function saveOrganizationFolder(db: D1Database, folder: OrganizationFolder): Promise<void> {
  await db
    .prepare(
      'INSERT INTO organization_folders(id, organization_id, name, creation_date, revision_date) ' +
      'VALUES(?, ?, ?, ?, ?) ' +
      'ON CONFLICT(id) DO UPDATE SET name=excluded.name, revision_date=excluded.revision_date'
    )
    .bind(folder.id, folder.organizationId, folder.name, folder.creationDate, folder.revisionDate)
    .run();
}

export async function deleteOrganizationFolder(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM organization_folders WHERE id = ?').bind(id).run();
}

// Unfile every cipher that referenced the folder. The data JSON blob never
// contains the org folder id (it is a scalar column), so a single UPDATE is
// enough. Returns the number of affected ciphers.
export async function clearOrganizationFolderFromCiphers(
  db: D1Database,
  folderId: string,
  updatedAt: string
): Promise<number> {
  const result = await db
    .prepare('UPDATE ciphers SET organization_folder_id = NULL, updated_at = ? WHERE organization_folder_id = ?')
    .bind(updatedAt, folderId)
    .run();
  return result.meta?.changes || 0;
}

// Bulk filing for organization ciphers. Callers must have verified access for
// every id (org membership + edit rights) before calling; unlike personal
// bulk moves the ids are explicit, not a user_id-scoped sweep.
export async function bulkSetOrganizationFolderOnCiphers(
  db: D1Database,
  maxChunkSize: number,
  ids: string[],
  organizationFolderId: string | null,
  updatedAt: string
): Promise<void> {
  if (!ids.length) return;
  const uniqueIds = Array.from(new Set(ids.map((id) => String(id || '').trim()).filter(Boolean)));
  const chunkSize = Math.max(1, maxChunkSize);
  for (let i = 0; i < uniqueIds.length; i += chunkSize) {
    const chunk = uniqueIds.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => '?').join(',');
    await db
      .prepare(
        `UPDATE ciphers SET organization_folder_id = ?, updated_at = ? WHERE id IN (${placeholders})`
      )
      .bind(organizationFolderId, updatedAt, ...chunk)
      .run();
  }
}
