import { Env, SyncResponse, CipherResponse, FolderResponse, ProfileResponse } from '../types';
import { StorageService } from '../services/storage';
import { errorResponse } from '../utils/response';
import { cipherToResponse, isCipherResponseSyncCompatible, shouldPreserveRepairableCipherUris } from './ciphers';
import { sendToResponse } from './sends';
import { LIMITS } from '../config/limits';
import {
  buildUserDecryptionCompat,
  buildUserDecryptionOptions,
} from '../utils/user-decryption';
import { buildDomainsResponse } from '../services/domain-rules';
import { buildWebAuthnPrfOption } from '../utils/account-passkeys';
import { buildProfileResponse } from '../utils/profile-response';
import { profileOrganizationResponse } from './organizations';
import { collectionToResponse } from './collections';

// CONTRACT:
// /api/sync reuses cipherToResponse() as the single cipher response shaper.
// Filtering invalid cipher responses here protects clients from stored rows that
// would otherwise make official apps fail after an HTTP 200 sync.
// Keep this aligned with src/handlers/ciphers.ts when adding new vault fields.
function buildSyncCacheRequest(
  request: Request,
  userId: string,
  revisionDate: string,
  accountPasskeyCacheTag: string,
  excludeDomains: boolean,
  excludeSends: boolean,
  preserveRepairableUris: boolean
): Request {
  const url = new URL(request.url);
  const cacheUrl = new URL(
    `/__nodewarden/cache/sync/${encodeURIComponent(userId)}/${encodeURIComponent(revisionDate)}/${encodeURIComponent(accountPasskeyCacheTag)}/${excludeDomains ? '1' : '0'}/${excludeSends ? '1' : '0'}/${preserveRepairableUris ? '1' : '0'}`,
    url.origin
  );
  return new Request(cacheUrl.toString(), { method: 'GET' });
}

async function readSyncCache(cacheRequest: Request): Promise<Response | null> {
  const hit = await caches.default.match(cacheRequest);
  if (!hit) return null;
  // The stored copy uses a cacheable Cache-Control (the Cache API refuses
  // private/no-store on put); restore the private directive before serving so
  // browsers never store the authorized response.
  const headers = new Headers(hit.headers);
  headers.set('Cache-Control', `private, max-age=${Math.max(1, Math.floor(LIMITS.cache.syncResponseTtlMs / 1000))}`);
  return new Response(hit.body, { status: hit.status, headers });
}

async function writeSyncCache(cacheRequest: Request, response: Response): Promise<void> {
  // caches.default.put() silently refuses responses marked private/no-store,
  // so store a copy with a cacheable directive; readSyncCache restores the
  // private directive for the client-facing response.
  const bodyBytes = Number(response.headers.get('X-NodeWarden-Sync-Bytes')) || 0;
  if (bodyBytes > LIMITS.cache.syncResponseMaxBodyBytes) {
    // Oversized response: serve uncached rather than holding a huge entry.
    return;
  }
  const ttlSeconds = Math.max(1, Math.floor(LIMITS.cache.syncResponseTtlMs / 1000));
  const clone = response.clone();
  const headers = new Headers(clone.headers);
  headers.set('Cache-Control', `max-age=${ttlSeconds}`);
  await caches.default.put(cacheRequest, new Response(clone.body, {
    status: clone.status,
    headers,
  }));
}

// Contract: one data point per /api/sync response, regardless of cache state.
// index = user id (queryable), blobs = cache state + client identity headers,
// doubles = [responseBytes, requestCount]. Never throws — telemetry must not
// break the sync path, and the binding is optional in some deployments.
function recordSyncTelemetry(
  env: Env,
  request: Request,
  userId: string,
  revisionDate: string,
  cacheState: 'hit' | 'miss',
  bytes: number
): void {
  let clientName = 'unknown';
  let clientVersion = 'unknown';
  try {
    clientName = request.headers.get('Bitwarden-Client-Name') || 'unknown';
    clientVersion = request.headers.get('Bitwarden-Client-Version') || 'unknown';
  } catch {
    // Ignore header read failures.
  }
  try {
    env.VAULT_TELEMETRY?.writeDataPoint({
      indexes: [userId],
      blobs: [cacheState, clientName, clientVersion, revisionDate],
      doubles: [bytes, 1],
    });
  } catch {
    // Ignore telemetry failures.
  }
  console.log(
    JSON.stringify({
      event: 'sync_response',
      userId,
      bytes,
      cache: cacheState,
      revisionDate,
      client: `${clientName}/${clientVersion}`,
    })
  );
}

// GET /api/sync
export async function handleSync(request: Request, env: Env, userId: string): Promise<Response> {
  const storage = new StorageService(env.DB);
  const url = new URL(request.url);
  const excludeDomainsParam = url.searchParams.get('excludeDomains');
  const excludeDomains = excludeDomainsParam !== null && /^(1|true|yes)$/i.test(excludeDomainsParam);
  const excludeSendsParam = url.searchParams.get('excludeSends');
  const excludeSends = excludeSendsParam !== null && /^(1|true|yes)$/i.test(excludeSendsParam);
  const preserveRepairableUris = shouldPreserveRepairableCipherUris(request);

  const user = await storage.getUserById(userId);
  if (!user) {
    return errorResponse('User not found', 404);
  }

  const [revisionDate, accountPasskeys] = await Promise.all([
    storage.getRevisionDate(userId),
    storage.getAccountPasskeyCredentialsByUserId(userId),
  ]);
  const accountPasskeyCacheTag = accountPasskeys
    .map((credential) => [
      credential.id,
      credential.updatedAt,
      credential.supportsPrf ? '1' : '0',
      credential.encryptedUserKey && credential.encryptedPublicKey && credential.encryptedPrivateKey ? '1' : '0',
    ].join(':'))
    .join(',');
  const cacheRequest = buildSyncCacheRequest(request, userId, revisionDate, accountPasskeyCacheTag, excludeDomains, excludeSends, preserveRepairableUris);
  const cachedResponse = await readSyncCache(cacheRequest);
  if (cachedResponse) {
    const cachedBytes = Number(cachedResponse.headers.get('X-NodeWarden-Sync-Bytes')) || 0;
    recordSyncTelemetry(env, request, userId, revisionDate, 'hit', cachedBytes);
    return cachedResponse;
  }

  const [folders, sends, domainSettings, organizations, collections, cipherFolderAssignments] = await Promise.all([
    storage.getAllFolders(userId),
    excludeSends ? Promise.resolve([]) : storage.getAllSends(userId),
    excludeDomains ? Promise.resolve(null) : storage.getUserDomainSettings(userId),
    storage.listConfirmedOrganizationsForUser(userId),
    storage.listCollectionsForUser(userId),
    storage.listCipherUserFolders(userId),
  ]);
  // Sequential after the parallel block above: the attachment fetch keys off
  // the merged cipher list (personal + org ciphers), which requires the org
  // memberships to have resolved first.
  const ciphers = await storage.getAllCiphersIncludingOrgs(userId);
  const attachmentsByCipher = await storage.getAttachmentsByCipherIds(
    ciphers.map((cipher) => cipher.id)
  );
  const webAuthnPrfOptions = accountPasskeys
    .map(buildWebAuthnPrfOption)
    .filter((option): option is NonNullable<typeof option> => !!option);
  const userDecryptionOptions = buildUserDecryptionOptions(user, webAuthnPrfOptions[0] || null);
  const validFolderIds = new Set(folders.map((folder) => folder.id));
  // Per-user filing of org ciphers: overlay the acting user's personal folder
  // assignment before responses are built. The mapping always references the
  // user's own folders, so validFolderIds masking passes.
  const folderAssignmentByCipher = new Map(
    cipherFolderAssignments.map((row) => [row.cipherId, row.folderId])
  );
  for (const cipher of ciphers) {
    if (cipher.organizationId) {
      cipher.folderId = folderAssignmentByCipher.get(cipher.id) ?? null;
    }
  }

  const profile: ProfileResponse = buildProfileResponse(
    user,
    env,
    organizations.map((membership) =>
      profileOrganizationResponse(membership.organization, membership.organizationUser)
    )
  );

  const cipherResponses: CipherResponse[] = [];
  for (const cipher of ciphers) {
    const response = cipherToResponse(cipher, attachmentsByCipher.get(cipher.id) || [], { preserveRepairableUris, validFolderIds });
    if (isCipherResponseSyncCompatible(response)) {
      cipherResponses.push(response);
    }
  }

  const folderResponses: FolderResponse[] = [];
  for (const folder of folders) {
    folderResponses.push({
      id: folder.id,
      name: folder.name,
      revisionDate: folder.updatedAt,
      creationDate: folder.createdAt,
      object: 'folder',
    });
  }

  const sendResponses = sends.map(sendToResponse);
  const syncResponse: SyncResponse = {
    profile,
    folders: folderResponses,
    collections: collections.map((collection) =>
      collectionToResponse(collection, {
        readOnly: collection.readOnly,
        hidePasswords: collection.hidePasswords,
        object: 'collectionDetails',
      })
    ),
    ciphers: cipherResponses,
    domains: excludeDomains
      ? null
      : buildDomainsResponse(
          domainSettings?.equivalentDomains || [],
          domainSettings?.customEquivalentDomains || [],
          domainSettings?.excludedGlobalEquivalentDomains || [],
          { omitExcludedGlobals: true }
        ),
    policies: [],
    policiesNew: [],
    sends: sendResponses,
    UserDecryption: {
      MasterPasswordUnlock: userDecryptionOptions.MasterPasswordUnlock,
      TrustedDeviceOption: null,
      KeyConnectorOption: null,
      WebAuthnPrfOption: webAuthnPrfOptions[0] || null,
      WebAuthnPrfOptions: webAuthnPrfOptions,
      V2UpgradeToken: null,
      Object: 'userDecryption',
    },
    UserDecryptionOptions: userDecryptionOptions,
    userDecryption: buildUserDecryptionCompat(user) as SyncResponse['userDecryption'],
    object: 'sync',
  };

  const bodyText = JSON.stringify(syncResponse);
  const response = new Response(bodyText, {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `private, max-age=${Math.max(1, Math.floor(LIMITS.cache.syncResponseTtlMs / 1000))}`,
      'X-NodeWarden-Sync-Bytes': String(bodyText.length),
    },
  });
  recordSyncTelemetry(env, request, userId, revisionDate, 'miss', bodyText.length);
  await writeSyncCache(cacheRequest, response);
  return response;
}
