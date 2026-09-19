import { Env, Folder, FolderResponse, OrganizationFolder } from '../types';
import {
  notifyUserFolderCreate,
  notifyUserFolderDelete,
  notifyUserFolderUpdate,
  notifyUserVaultSync,
} from '../durable/notifications-hub';
import { StorageService } from '../services/storage';
import { jsonResponse, errorResponse } from '../utils/response';
import { readActingDeviceIdentifier } from '../utils/device';
import { generateUUID } from '../utils/uuid';
import { parsePagination, encodeContinuationToken } from '../utils/pagination';
import { auditRequestMetadata, writeAuditEvent } from '../services/audit-events';
import { bumpOrganizationMembers } from '../utils/org-notify';
import {
  ORG_USER_STATUS,
  ORG_USER_TYPE,
  deleteOrganizationFolderInternal,
  organizationFolderToSyncFolderResponse,
  renameOrganizationFolderInternal,
} from './organizations';

function notifyVaultSyncForRequest(
  request: Request,
  env: Env,
  userId: string,
  revisionDate: string
): void {
  notifyUserVaultSync(env, userId, revisionDate, readActingDeviceIdentifier(request));
}

async function writeFolderAudit(
  storage: StorageService,
  request: Request,
  userId: string,
  action: string,
  metadata: Record<string, unknown>
): Promise<void> {
  await writeAuditEvent(storage, {
    actorUserId: userId,
    action,
    category: 'data',
    level: action.includes('delete') ? 'security' : 'info',
    targetType: 'folder',
    targetId: typeof metadata.id === 'string' ? metadata.id : null,
    metadata: {
      ...metadata,
      ...auditRequestMetadata(request),
    },
  });
}

// Convert internal folder to API response format
function folderToResponse(folder: Folder): FolderResponse {
  return {
    id: folder.id,
    name: folder.name,
    revisionDate: folder.updatedAt,
    creationDate: folder.createdAt,
    object: 'folder',
  };
}

// Organization folders share the user-folder id space on the wire (they are
// injected into the folders list), so the user-folder endpoints must detect
// and handle them. Members may read; only owners/admins may rename or delete.
// Anything else keeps the personal-folder behavior.

async function confirmedOrganizationFolderMembership(
  storage: StorageService,
  folder: OrganizationFolder,
  userId: string
): Promise<{ type: number } | null> {
  const membership = await storage.getOrganizationUserForUser(folder.organizationId, userId);
  if (!membership || membership.status !== ORG_USER_STATUS.CONFIRMED) return null;
  return { type: Number(membership.type) };
}

function organizationFolderNotFound(): Response {
  // Members of other organizations learn nothing about the folder's existence.
  return errorResponse('Folder not found', 404);
}

async function requireOrganizationFolderManager(
  storage: StorageService,
  folder: OrganizationFolder,
  userId: string
): Promise<Response | null> {
  const membership = await confirmedOrganizationFolderMembership(storage, folder, userId);
  if (!membership) return organizationFolderNotFound();
  if (membership.type !== ORG_USER_TYPE.OWNER && membership.type !== ORG_USER_TYPE.ADMIN) {
    return errorResponse('Organization folders can only be managed by organization owners or admins', 403);
  }
  return null;
}

// GET /api/folders
export async function handleGetFolders(request: Request, env: Env, userId: string): Promise<Response> {
  const storage = new StorageService(env.DB);
  const url = new URL(request.url);
  const pagination = parsePagination(url);

  let folders: Folder[];
  let organizationFolders: OrganizationFolder[] | null = null;
  let continuationToken: string | null = null;
  if (pagination) {
    const pageRows = await storage.getFoldersPage(userId, pagination.limit + 1, pagination.offset);
    const hasNext = pageRows.length > pagination.limit;
    folders = hasNext ? pageRows.slice(0, pagination.limit) : pageRows;
    continuationToken = hasNext ? encodeContinuationToken(pagination.offset + folders.length) : null;
  } else {
    folders = await storage.getAllFolders(userId);
    // Unpaginated lists also surface organization folders (same as sync).
    // Paginated responses keep strict user-folder paging; org folders arrive
    // via sync for every official client.
    organizationFolders = await storage.listOrganizationFoldersForUser(userId);
  }

  return jsonResponse({
    data: [
      ...folders.map(folderToResponse),
      ...(organizationFolders || []).map(organizationFolderToSyncFolderResponse),
    ],
    object: 'list',
    continuationToken: continuationToken,
  });
}

// GET /api/folders/:id
export async function handleGetFolder(request: Request, env: Env, userId: string, id: string): Promise<Response> {
  const storage = new StorageService(env.DB);

  // Organization folders are readable by any confirmed member of their org
  // (names decrypt with the org key the member already holds).
  const organizationFolder = await storage.getOrganizationFolderById(id);
  if (organizationFolder) {
    const membership = await confirmedOrganizationFolderMembership(storage, organizationFolder, userId);
    if (!membership) return organizationFolderNotFound();
    return jsonResponse(organizationFolderToSyncFolderResponse(organizationFolder));
  }

  const folder = await storage.getFolderForUser(id, userId);

  if (!folder || folder.userId !== userId) {
    return errorResponse('Folder not found', 404);
  }

  return jsonResponse(folderToResponse(folder));
}

// POST /api/folders
export async function handleCreateFolder(request: Request, env: Env, userId: string): Promise<Response> {
  const storage = new StorageService(env.DB);

  let body: { name?: string };
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON', 400);
  }

  if (!body.name) {
    return errorResponse('Name is required', 400);
  }

  const now = new Date().toISOString();
  const folder: Folder = {
    id: generateUUID(),
    userId: userId,
    name: body.name,
    createdAt: now,
    updatedAt: now,
  };

  await storage.saveFolder(folder);
  const revisionDate = await storage.updateRevisionDate(userId);
  notifyVaultSyncForRequest(request, env, userId, revisionDate);
  notifyUserFolderCreate(env, {
    userId,
    folderId: folder.id,
    revisionDate,
    contextId: readActingDeviceIdentifier(request),
  });

  return jsonResponse(folderToResponse(folder), 200);
}

// PUT /api/folders/:id
export async function handleUpdateFolder(request: Request, env: Env, userId: string, id: string): Promise<Response> {
  const storage = new StorageService(env.DB);

  // Organization folders: rename is delegated to the org-folder operation for
  // owners/admins, so managing them from any client works without errors.
  const organizationFolder = await storage.getOrganizationFolderById(id);
  if (organizationFolder) {
    const denied = await requireOrganizationFolderManager(storage, organizationFolder, userId);
    if (denied) return denied;

    let body: { name?: string };
    try {
      body = await request.json();
    } catch {
      return errorResponse('Invalid JSON', 400);
    }
    if (!body.name || typeof body.name !== 'string') {
      return errorResponse('Name is required', 400);
    }
    await renameOrganizationFolderInternal(storage, organizationFolder, body.name);
    await bumpOrganizationMembers(request, env, storage, organizationFolder.organizationId);
    await writeFolderAudit(storage, request, userId, 'folder.update', {
      id,
      organizationFolderId: id,
      organizationId: organizationFolder.organizationId,
    });

    return jsonResponse(organizationFolderToSyncFolderResponse(organizationFolder));
  }

  const folder = await storage.getFolderForUser(id, userId);

  if (!folder || folder.userId !== userId) {
    return errorResponse('Folder not found', 404);
  }

  let body: { name?: string };
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON', 400);
  }

  if (body.name) {
    folder.name = body.name;
  }
  folder.updatedAt = new Date().toISOString();

  await storage.saveFolder(folder);
  const revisionDate = await storage.updateRevisionDate(userId);
  notifyVaultSyncForRequest(request, env, userId, revisionDate);
  notifyUserFolderUpdate(env, {
    userId,
    folderId: folder.id,
    revisionDate,
    contextId: readActingDeviceIdentifier(request),
  });

  return jsonResponse(folderToResponse(folder));
}

// DELETE /api/folders/:id
export async function handleDeleteFolder(request: Request, env: Env, userId: string, id: string): Promise<Response> {
  const storage = new StorageService(env.DB);

  // Organization folders: deletion is delegated for owners/admins (unfiles
  // every affected cipher and bumps all org members).
  const organizationFolder = await storage.getOrganizationFolderById(id);
  if (organizationFolder) {
    const denied = await requireOrganizationFolderManager(storage, organizationFolder, userId);
    if (denied) return denied;

    await deleteOrganizationFolderInternal(request, env, storage, organizationFolder);
    await writeFolderAudit(storage, request, userId, 'folder.delete', {
      id,
      organizationFolderId: id,
      organizationId: organizationFolder.organizationId,
    });
    return new Response(null, { status: 204 });
  }

  const folder = await storage.getFolderForUser(id, userId);

  if (!folder || folder.userId !== userId) {
    return errorResponse('Folder not found', 404);
  }

  await storage.clearFolderFromCiphers(userId, id);
  await storage.deleteFolder(id, userId);
  const revisionDate = await storage.updateRevisionDate(userId);
  notifyVaultSyncForRequest(request, env, userId, revisionDate);
  notifyUserFolderDelete(env, {
    userId,
    folderId: id,
    revisionDate,
    contextId: readActingDeviceIdentifier(request),
  });
  await writeFolderAudit(storage, request, userId, 'folder.delete', {
    id,
  });

  return new Response(null, { status: 204 });
}

// POST /api/folders/delete
export async function handleBulkDeleteFolders(request: Request, env: Env, userId: string): Promise<Response> {
  const storage = new StorageService(env.DB);

  let body: { ids?: string[] };
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON', 400);
  }

  const ids = Array.isArray(body.ids) ? body.ids.map((id) => String(id || '').trim()).filter(Boolean) : [];
  if (!ids.length) {
    return errorResponse('Folder ids are required', 400);
  }

  // Organization folders are handled per-id: renamed/deleted only by
  // owners/admins; personal ids fall through to the user bulk delete.
  const personalIds: string[] = [];
  for (const id of ids) {
    const organizationFolder = await storage.getOrganizationFolderById(id);
    if (organizationFolder) {
      const denied = await requireOrganizationFolderManager(storage, organizationFolder, userId);
      if (denied) return denied;
      await deleteOrganizationFolderInternal(request, env, storage, organizationFolder);
      await writeFolderAudit(storage, request, userId, 'folder.delete', {
        id,
        organizationFolderId: id,
        organizationId: organizationFolder.organizationId,
      });
    } else {
      personalIds.push(id);
    }
  }

  if (!personalIds.length) {
    return new Response(null, { status: 204 });
  }

  const folders = (
    await Promise.all(personalIds.map(async (id) => {
      const folder = await storage.getFolderForUser(id, userId);
      return folder;
    }))
  ).filter((folder): folder is Folder => !!folder);
  const revisionDate = await storage.bulkDeleteFolders(personalIds, userId);
  if (revisionDate) {
    notifyVaultSyncForRequest(request, env, userId, revisionDate);
    for (const folder of folders) {
      notifyUserFolderDelete(env, {
        userId,
        folderId: folder.id,
        revisionDate,
        contextId: readActingDeviceIdentifier(request),
      });
    }
    await writeFolderAudit(storage, request, userId, 'folder.delete.bulk', {
      count: personalIds.length,
    });
  }

  return new Response(null, { status: 204 });
}
