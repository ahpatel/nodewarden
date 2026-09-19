import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

function read(path: string): string {
  return readFileSync(resolve(root, path), 'utf-8');
}

// ─── Native Bitwarden status enums ─────────────────────────────────────────
// organization_users.status stores Bitwarden's own OrganizationUserStatusType
// (-1=Revoked, 0=Invited, 1=Accepted, 2=Confirmed) — no translation layer.

test('organization user status is stored in Bitwarden wire enums natively', () => {
  const orgs = read('src/handlers/organizations.ts');
  assert.ok(
    /REVOKED:\s*-1/.test(orgs) && /INVITED:\s*0/.test(orgs) && /ACCEPTED:\s*1/.test(orgs) && /CONFIRMED:\s*2/.test(orgs),
    'stored status constants are -1/0/1/2'
  );
  assert.ok(
    !orgs.includes('wireOrganizationUserStatus'),
    'no translation layer: responses pass the stored value through'
  );
});

test('status SQL literals match the native enum (confirmed = 2)', () => {
  for (const path of [
    'src/services/storage-org-repo.ts',
    'src/services/storage-cipher-repo.ts',
    'src/services/storage-collection-repo.ts',
  ]) {
    const src = read(path);
    assert.ok(!/status = 3/.test(src), `${path} has no pre-migration status = 3 literals`);
    assert.ok(/status = 2/.test(src), `${path} uses the native confirmed value`);
  }
});

test('status migration to wire enums is guarded by a sentinel', () => {
  const schema = read('src/services/storage-schema.ts');
  const fn = schema.slice(schema.indexOf('migrateOrganizationUserStatusToWire'));
  assert.ok(/status = 3/.test(fn), 'the sentinel is the unmigrated confirmed value');
  assert.ok(/SET status = status - 1/.test(fn), 'shifts stored values onto the wire scale');
  assert.ok(/await migrateOrganizationUserStatusToWire\(db\);/.test(schema), 'wired into ensureStorageSchema');
  const storage = read('src/services/storage.ts');
  assert.ok(/native-org-status/.test(storage), 'schema version bumped for the data migration');
});

test('organization roles include Bitwarden Manager and Custom', () => {
  const orgs = read('src/handlers/organizations.ts');
  assert.ok(/MANAGER:\s*3/.test(orgs) && /CUSTOM:\s*4/.test(orgs), 'ORG_USER_TYPE covers Manager=3 and Custom=4');
  const invite = orgs.slice(orgs.indexOf('handleInviteOrganizationUsers'));
  assert.ok(/\[0, 1, 2, 3, 4\]\.includes/.test(invite), 'invite type validation accepts the full Bitwarden range');
});

test('invite UI exposes Admin and Manager roles', () => {
  const page = read('webapp/src/components/OrganizationsPage.tsx');
  assert.ok(
    page.includes('ORG_ROLE.ADMIN') && page.includes('ORG_ROLE.MANAGER'),
    'the role select offers Admin and Manager'
  );
});

test('organization type constants match client enum', () => {
  const orgs = read('src/handlers/organizations.ts');
  assert.ok(/OWNER:\s*0/.test(orgs) && /ADMIN:\s*1/.test(orgs) && /USER:\s*2/.test(orgs),
    'ORG_USER_TYPE: Owner=0, Admin=1, User=2');
});

// ─── Registration invite email binding ─────────────────────────────────────
// Org-minted registration codes must only register the invited email.
// Admin-minted codes (email NULL) stay generic.

test('markInviteUsed enforces email binding for org-minted codes', () => {
  const repo = read('src/services/storage-admin-repo.ts');
  assert.ok(
    repo.includes('(email IS NULL OR email = ?)'),
    'markInviteUsed must have (email IS NULL OR email = ?) predicate'
  );
  assert.ok(
    repo.includes('void userId'),
    'markInviteUsed discards userId (no user binding, only email binding)'
  );
});

test('registration passes the registering email to markInviteUsed', () => {
  const accounts = read('src/handlers/accounts.ts');
  assert.ok(
    accounts.includes('storage.markInviteUsed(inviteCode, user.id, email)'),
    'registration must pass the email to markInviteUsed'
  );
});

test('org invite minting is gated by config flag', () => {
  const orgs = read('src/handlers/organizations.ts');
  assert.ok(
    orgs.includes("getConfigValue(ORG_SELF_SERVICE_REGISTRATION_CONFIG_KEY)"),
    'invite handler must check the config flag'
  );
  assert.ok(
    orgs.includes("ORG_SELF_SERVICE_REGISTRATION_CONFIG_KEY = 'org.selfServiceRegistration'"),
    'config key is org.selfServiceRegistration'
  );
  assert.ok(
    orgs.includes('requiresAdminRegistration'),
    'response includes requiresAdminRegistration when flag is off'
  );
});

// ─── Org key distribution scoping ─────────────────────────────────────────

test('confirmed org query filters by user and status', () => {
  const repo = read('src/services/storage-org-repo.ts');
  assert.ok(
    repo.includes('WHERE ou.user_id = ? AND ou.status = 2'),
    'org key distribution must be scoped to confirmed members only'
  );
});

test('membership transitions are status-preconditioned', () => {
  const repo = read('src/services/storage-org-repo.ts');
  assert.ok(
    repo.includes('WHERE id = ? AND status = ?'),
    'transitionOrganizationUserStatus must use status-preconditioned UPDATE'
  );

  // Verify accept uses it
  const orgs = read('src/handlers/organizations.ts');
  assert.ok(
    orgs.includes('transitionOrganizationUserStatus(organizationUserId, ORG_USER_STATUS.INVITED'),
    'accept must transition from INVITED'
  );
  assert.ok(
    orgs.includes('transitionOrganizationUserStatus(\n    organizationUserId,\n    isReconfirm ? ORG_USER_STATUS.CONFIRMED : ORG_USER_STATUS.ACCEPTED'),
    'confirm must branch on re-confirm vs first-confirm'
  );
  assert.ok(
    orgs.includes('transitionOrganizationUserStatus(\n    organizationUserId,\n    organizationUser.status'),
    'update member must use conditional transition'
  );
});

// ─── Cipher collection access resolution ─────────────────────────────────────

test('resolveCipherAccessForUser requires collection intersection', () => {
  const repo = read('src/services/storage-collection-repo.ts');
  assert.ok(
    repo.includes('JOIN collection_users cu ON cu.collection_id = cc.collection_id'),
    'cipher access must require collection assignment'
  );
  assert.ok(
    repo.includes('ou.access_all = 1'),
    'accessAll members bypass collection checks'
  );
});

// ─── Collection move endpoint authorization ────────────────────────────────

test('collection move endpoints enforce per-target editability', () => {
  const ciphers = read('src/handlers/ciphers.ts');
  assert.ok(
    ciphers.includes('verifyTargetCollectionsEditable'),
    'move endpoints must check target collection editability'
  );
  assert.ok(
    ciphers.includes('At least one collection is required'),
    'single-item move must reject empty collectionIds'
  );
});

// ─── hidePasswords server-side enforcement ─────────────────────────────────

test('cipherToResponse strips password material when viewPassword is false', () => {
  const ciphers = read('src/handlers/ciphers.ts');
  assert.ok(
    ciphers.includes('responseLogin = { ...responseLogin, password: null, totp: null }'),
    'hidePasswords must null login.password and login.totp server-side'
  );
  assert.ok(
    ciphers.includes('responsePasswordHistory = null'),
    'hidePasswords must null passwordHistory server-side'
  );
});

// ─── Attachment org-cipher SQL guards ──────────────────────────────────────

test('attachment delete works for org ciphers', () => {
  const repo = read('src/services/storage-attachment-repo.ts');
  assert.ok(
    repo.includes("(c.user_id = ? OR c.organization_id IS NOT NULL)"),
    'deleteAttachmentForUser must match org ciphers'
  );
});

test('attachment save upsert works for org ciphers', () => {
  const repo = read('src/services/storage-attachment-repo.ts');
  assert.ok(
    repo.includes("current_cipher.organization_id IS NOT NULL"),
    'saveAttachment upsert must match org ciphers'
  );
});

// ─── Ownerless org guard ────────────────────────────────────────────────────

test('confirmed owner count uses the native confirmed status only', () => {
  const repo = read('src/services/storage-org-repo.ts');
  assert.ok(
    repo.includes("type = 0 AND status = 2"),
    'countConfirmedOrganizationOwners counts CONFIRMED owners only'
  );
});

// ─── Sync response completeness ─────────────────────────────────────────────

test('sync includes org data in profile, collections, and ciphers', () => {
  const sync = read('src/handlers/sync.ts');
  assert.ok(sync.includes('listConfirmedOrganizationsForUser'), 'profile.orgs');
  assert.ok(sync.includes('listCollectionsForUser'), 'collections');
  assert.ok(sync.includes('getAllCiphersIncludingOrgs'), 'org ciphers');
  assert.ok(sync.includes('profileOrganizationResponse'), 'profile shape uses org fn');
});

test('profile org response shape has required client fields', () => {
  const orgs = read('src/handlers/organizations.ts');

  // Required by the extension's vault-list-items-container template
  assert.ok(orgs.includes('productTierType'), 'productTierType');
  assert.ok(orgs.includes('selfHost'), 'selfHost');
  assert.ok(orgs.includes('usersGetPremium'), 'usersGetPremium');
  assert.ok(orgs.includes('usePasswordManager'), 'usePasswordManager');
  assert.ok(orgs.includes('permissions: {'), 'permissions object');

  // billingEmail must NOT be in the profile response
  const profileFn = orgs.slice(orgs.indexOf('profileOrganizationResponse'), orgs.indexOf('collectionToResponse'));
  assert.ok(
    !profileFn.includes('billingEmail'),
    'billingEmail must be absent from profileOrganizationResponse (member-visible shape)'
  );
});

// ─── Last-owner protection ─────────────────────────────────────────────────

test('last-owner guards exist on leave, demote, and remove', () => {
  const orgs = read('src/handlers/organizations.ts');

  // All three paths must check countConfirmedOrganizationOwners
  const leaveMatch = orgs.match(/handleLeaveOrganization[\s\S]*?confirmedOwners <= 1/);
  const demoteMatch = orgs.match(/handleUpdateOrganizationUser[\s\S]*?confirmedOwners <= 1/);
  const removeMatch = orgs.match(/handleRemoveOrganizationUser[\s\S]*?confirmedOwners <= 1/);

  assert.ok(leaveMatch, 'leave checks last-owner guard');
  assert.ok(demoteMatch, 'demote checks last-owner guard');
  assert.ok(removeMatch, 'remove checks last-owner guard');
});

// ─── Schema ────────────────────────────────────────────────────────────────

test('schema includes all five org tables', () => {
  const schema = read('src/services/storage-schema.ts');
  for (const table of ['organizations', 'organization_users', 'collections', 'collection_users', 'cipher_collections']) {
    assert.ok(schema.includes(`CREATE TABLE IF NOT EXISTS ${table}`), `${table} table`);
  }
});

test('backup includes all five org tables', () => {
  const backup = read('src/services/backup-archive.ts');
  for (const table of ['organizations', 'organization_users', 'collections', 'collection_users', 'cipher_collections']) {
    assert.ok(backup.includes(`FROM ${table}`) || backup.includes(table), `${table} in backup`);
  }
});

test('schema version is bumped for org feature', () => {
  const storage = read('src/services/storage.ts');
  assert.ok(
    /^const STORAGE_SCHEMA_VERSION = '.*(organization|org|filing).*';$/m.test(storage),
    'schema version reflects org feature'
  );
});

// ─── Admin toggle security ─────────────────────────────────────────────────

test('admin toggle requires master password verification', () => {
  const admin = read('src/handlers/admin.ts');
  const toggleFn = admin.slice(admin.indexOf('handleAdminSetOrgSelfServiceRegistration'));
  assert.ok(
    toggleFn.includes('requireMasterPasswordHash'),
    'toggle must require master password'
  );
  assert.ok(
    toggleFn.includes('isAdmin(actorUser)'),
    'toggle must check admin role'
  );
  assert.ok(
    toggleFn.includes('writeAuditLog'),
    'toggle must write audit log'
  );
});

// ─── Per-user filing of organization ciphers ────────────────────────────────
// Shared items are filed into each member's own personal folders via a
// per-user mapping (cipher_user_folders). The cipher row never carries a
// personal folder id; the standard folderId response field carries the
// acting user's assignment so official clients render filing natively.

test('schema and backup include the per-user cipher filing map', () => {
  const schema = read('src/services/storage-schema.ts');
  assert.ok(
    schema.includes('CREATE TABLE IF NOT EXISTS cipher_user_folders'),
    'schema creates cipher_user_folders'
  );
  const mapping = schema.slice(schema.indexOf('CREATE TABLE IF NOT EXISTS cipher_user_folders'));
  assert.ok(
    /FOREIGN KEY \(folder_id\) REFERENCES folders\(id\) ON DELETE CASCADE/.test(mapping),
    'deleting a folder unfiles affected org items (FK cascade)'
  );
  assert.ok(
    /FOREIGN KEY \(cipher_id\) REFERENCES ciphers\(id\) ON DELETE CASCADE/.test(mapping),
    'deleting a cipher cleans up its filing rows (FK cascade)'
  );

  const archive = read('src/services/backup-archive.ts');
  assert.ok(archive.includes('FROM cipher_user_folders'), 'export includes the filing map');
  const backupImport = read('src/services/backup-import.ts');
  assert.ok(
    backupImport.includes("'cipher_user_folders'"),
    'restore allowlist includes the filing map'
  );
  assert.ok(
    /DELETE FROM cipher_user_folders/.test(backupImport),
    'restore reset clears the filing map'
  );
});

test('org cipher rows never persist a personal folder id', () => {
  const repo = read('src/services/storage-cipher-repo.ts');
  assert.ok(
    /const folderId = cipher\.organizationId \? null : normalizeOptionalId\(cipher\.folderId\);/.test(repo),
    'saveCipher guards org rows against personal folder ids'
  );
});

test('org cipher write paths file into the acting user\'s own folders', () => {
  const ciphers = read('src/handlers/ciphers.ts');

  // The load path overlays the per-user assignment so every org cipher
  // response reports the acting user's filing.
  assert.ok(
    /loadCipherForRequest[\s\S]*?result\.cipher\.folderId = await storage\.getCipherUserFolder\(userId, cipherId\);/.test(ciphers),
    'load path overlays the per-user assignment'
  );

  // create-in-org: mapping write after save.
  assert.ok(
    /createCipherFolderId[\s\S]*?setCipherUserFolder\(userId, cipher\.id, createCipherFolderId\)/.test(ciphers),
    'create-in-org stores the filing per-user'
  );

  // full update: user-folder verification + mapping writes, keep-when-omitted.
  const update = ciphers.slice(ciphers.indexOf('export async function handleUpdateCipher'));
  assert.ok(
    update.includes('verifyFolderOwnership(storage, requestedFolderId, userId)') &&
    update.includes('setCipherUserFolder(userId, cipher.id, requestedFolderId)') &&
    update.includes('setCipherUserFolder(userId, cipher.id, null)'),
    'full update resolves filing against the acting user\'s folders'
  );
  assert.ok(
    /An omitted folderId keeps the existing filing/.test(ciphers),
    'omitted folderId keeps the existing filing'
  );

  // partial (move-to-folder): single user-folder check + mapping.
  const partial = ciphers.slice(ciphers.indexOf('handlePartialUpdateCipher'));
  assert.ok(
    partial.includes('setCipherUserFolder(userId, cipher.id, folderId)'),
    'move-to-folder writes the per-user mapping'
  );

  // bulk move works for mixed personal + org selections.
  const bulk = ciphers.slice(ciphers.indexOf('handleBulkMoveCiphers'));
  assert.ok(
    bulk.includes('bulkSetCipherUserFolders(userId, orgIds, folderId)') &&
    /bulkSetCipherUserFolders[\s\S]*?updateRevisionDate\(userId\)/.test(bulk),
    'bulk move files org items per acting user and bumps only their revision'
  );

  // share: the source personal folder carries over as the sharer's mapping.
  const share = ciphers.slice(ciphers.indexOf('handleShareCipher'));
  assert.ok(
    share.includes('verifyFolderOwnership(storage, requestedFolderId, userId)') &&
    share.includes('setCipherUserFolder(userId, shared.id, requestedFolderId)'),
    'share keeps the source personal folder filing per-user'
  );
});

test('sync overlays the acting user\'s filing onto org ciphers', () => {
  const sync = read('src/handlers/sync.ts');
  assert.ok(
    sync.includes('listCipherUserFolders(userId)'),
    'sync loads the acting user\'s filing map'
  );
  assert.ok(
    /folderAssignmentByCipher[\s\S]*?cipher\.folderId = folderAssignmentByCipher\.get\(cipher\.id\) \?\? null;/.test(sync),
    'org ciphers report the per-user assignment through folderId'
  );
  assert.ok(
    !sync.includes('organizationFolderToSyncFolderResponse'),
    'org folders are no longer injected into the folders list'
  );
});

test('org folder machinery is removed', () => {
  const orgs = read('src/handlers/organizations.ts');
  assert.ok(!orgs.includes('OrganizationFolder'), 'no org folder handlers remain');
  const folders = read('src/handlers/folders.ts');
  assert.ok(
    !folders.includes('getOrganizationFolderById'),
    'user-folder endpoints no longer proxy org folders'
  );
  const router = read('src/router-authenticated.ts');
  assert.ok(
    !router.includes('OrganizationFolder'),
    'no org folder routes remain'
  );
});

// ─── Atomic creation & preconditioned deletes (sorolaholvi review) ───────────

test('organization creation is atomic (org + owner + default collection in one D1 batch)', () => {
  const repo = read('src/services/storage-org-repo.ts');
  assert.ok(
    /export async function createOrganizationWithOwner[\s\S]*?db\.batch\(/.test(repo),
    'createOrganizationWithOwner commits org, owner membership, and default collection atomically'
  );
  const orgs = read('src/handlers/organizations.ts');
  assert.ok(
    /handleCreateOrganization[\s\S]*?createOrganizationWithOwner/.test(orgs),
    'the create handler uses the atomic path'
  );
});

test('organization delete is owner-preconditioned in SQL', () => {
  const repo = read('src/services/storage-org-repo.ts');
  const del = repo.slice(repo.indexOf('export async function deleteOrganizationForOwner'));
  assert.ok(
    /DELETE FROM organizations[\s\S]*?EXISTS \([\s\S]*?ou\.type = 0[\s\S]*?ou\.status =/.test(del),
    'delete verifies confirmed owner membership inside the DELETE statement'
  );
  assert.ok(
    /changes/.test(del),
    'reports whether a row was deleted'
  );
});

test('collection delete is owner-preconditioned in SQL', () => {
  const repo = read('src/services/storage-collection-repo.ts');
  const del = repo.slice(repo.indexOf('export async function deleteCollectionForOwner'));
  assert.ok(
    /DELETE FROM collections[\s\S]*?EXISTS \(/.test(del),
    'collection delete guards org and owner in the statement itself'
  );
});

test('required schema tables include the organization tables (self-healing ensure)', () => {
  const storage = read('src/services/storage.ts');
  const block = storage.slice(storage.indexOf('REQUIRED_SCHEMA_TABLES'));
  for (const table of ['organizations', 'organization_users', 'collections', 'collection_users', 'cipher_collections', 'cipher_user_folders']) {
    assert.ok(block.includes(`'${table}'`), `REQUIRED_SCHEMA_TABLES includes ${table}`);
  }
});
