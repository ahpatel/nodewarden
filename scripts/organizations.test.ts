import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

function read(path: string): string {
  return readFileSync(resolve(root, path), 'utf-8');
}

// ─── Wire status mapping ──────────────────────────────────────────────────
// The server stores 1=Invited, 2=Accepted, 3=Confirmed. Official clients use
// OrganizationUserStatusType: Invited=0, Accepted=1, Confirmed=2, Revoked=-1.
// The wire translation is stored − 1.

test('wire status mapping constants match client enum offset', () => {
  const orgs = read('src/handlers/organizations.ts');

  assert.ok(
    /REVOKED:\s*0/.test(orgs) && /INVITED:\s*1/.test(orgs) && /ACCEPTED:\s*2/.test(orgs) && /CONFIRMED:\s*3/.test(orgs),
    'stored status constants are 0/1/2/3'
  );
  assert.ok(
    /wireOrganizationUserStatus[\s\S]*?storedStatus\s*-\s*1/.test(orgs),
    'wire status = stored − 1 (Bitwarden client enum)'
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
    repo.includes('WHERE ou.user_id = ? AND ou.status = 3'),
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

test('confirmed owner count uses status=3 only', () => {
  const repo = read('src/services/storage-org-repo.ts');
  assert.ok(
    repo.includes("type = 0 AND status = 3"),
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
    /^const STORAGE_SCHEMA_VERSION = '.*organization.*';$/m.test(storage),
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

// ─── Organization folders ───────────────────────────────────────────────────
// Org folders are admin-managed, org-scoped, org-key encrypted, and surfaced
// through the standard sync folders list so official clients render filing.

test('schema and backup include the organization_folders table', () => {
  const schema = read('src/services/storage-schema.ts');
  assert.ok(
    schema.includes('CREATE TABLE IF NOT EXISTS organization_folders'),
    'schema creates organization_folders'
  );
  assert.ok(
    schema.includes('ALTER TABLE ciphers ADD COLUMN organization_folder_id TEXT'),
    'ciphers gain the org filing column'
  );
  assert.ok(
    /ciphers_organization_migration[\s\S]*?organization_folder_id/.test(schema),
    'legacy rebuild carries the column'
  );

  const archive = read('src/services/backup-archive.ts');
  assert.ok(archive.includes('FROM organization_folders'), 'export includes org folders');
  const backupImport = read('src/services/backup-import.ts');
  assert.ok(
    backupImport.includes("'organization_folders'"),
    'restore allowlist includes org folders'
  );
  assert.ok(
    /DELETE FROM organization_folders/.test(backupImport),
    'restore reset clears org folders'
  );
});

test('org folder CRUD is gated to owners and admins', () => {
  const orgs = read('src/handlers/organizations.ts');
  const gate = orgs.slice(orgs.indexOf('async function requireOrganizationManager'));
  assert.ok(
    gate.includes('ORG_USER_TYPE.OWNER') && gate.includes('ORG_USER_TYPE.ADMIN'),
    'owners AND admins may manage folders'
  );
  assert.ok(
    gate.includes('403'),
    'regular members are rejected'
  );
  assert.ok(
    /handleCreateOrganizationFolder[\s\S]*?requireOrganizationManager/.test(orgs) &&
    /handleUpdateOrganizationFolder[\s\S]*?requireOrganizationManager/.test(orgs) &&
    /handleDeleteOrganizationFolder[\s\S]*?requireOrganizationManager/.test(orgs),
    'all folder write handlers check the manager gate'
  );
});

test('deleting an org folder unfiles affected ciphers', () => {
  const orgs = read('src/handlers/organizations.ts');
  const del = orgs.slice(orgs.indexOf('export async function deleteOrganizationFolderInternal'));
  assert.ok(
    del.includes('clearOrganizationFolderFromCiphers'),
    'delete cascades unfiling before removing the folder'
  );
  assert.ok(
    del.includes('bumpOrganizationMembers'),
    'members are bumped so clients refetch'
  );
  const repo = read('src/services/storage-org-folder-repo.ts');
  assert.ok(
    /clearOrganizationFolderFromCiphers[\s\S]*?organization_folder_id = NULL/.test(repo),
    'cascade nulls the filing column'
  );
});

test('org cipher write paths resolve the payload folder against org folders', () => {
  const ciphers = read('src/handlers/ciphers.ts');
  assert.ok(
    /verifyOrgFolderOwnership[\s\S]*?getOrganizationFolder/.test(ciphers),
    'org folder ownership checks resolve against organization_folders'
  );
  // create-in-org
  assert.ok(
    /if \(cipher\.folderId\)[\s\S]*?verifyOrgFolderOwnership\(storage, cipher\.folderId, createOrganizationId\)/.test(ciphers),
    'create-in-org validates the filing'
  );
  // full update
  const update = ciphers.slice(ciphers.indexOf('export async function handleUpdateCipher'));
  assert.ok(
    update.includes('verifyOrgFolderOwnership(storage, requestedFolderId, existingCipher.organizationId)'),
    'full update resolves org filing'
  );
  assert.ok(
    /incomingFolderId[\s\S]*?keep the existing filing/.test(ciphers),
    'omitted folderId preserves the existing filing'
  );
  // partial update
  const partial = ciphers.slice(ciphers.indexOf('handlePartialUpdateCipher'));
  assert.ok(
    partial.includes('verifyOrgFolderOwnership(storage, folderId, cipher.organizationId)'),
    'move-to-folder resolves org filing'
  );
  // bulk move
  const bulk = ciphers.slice(ciphers.indexOf('handleBulkMoveCiphers'));
  assert.ok(
    bulk.includes('bulkSetOrganizationFolderOnCiphers') &&
    bulk.includes('multiple organizations'),
    'bulk move handles org items with per-org folder validation'
  );
  // share
  const share = ciphers.slice(ciphers.indexOf('handleShareCipher'));
  assert.ok(
    share.includes('verifyOrgFolderOwnership(storage, requestedOrgFolderId, organizationId)'),
    'share resolves the name-matched org folder'
  );
  // personal folders never leak onto org rows
  assert.ok(
    /organizationId\s*\?\s*\(cipher\.organizationFolderId \?\? null\)\s*:\s*cipher\.folderId/.test(ciphers),
    'responses report org filing through folderId'
  );
  assert.ok(
    /organizationFolderId: undefined/.test(ciphers),
    'the internal column is never exposed on the wire'
  );
});

test('sync injects org folders into the folders list', () => {
  const sync = read('src/handlers/sync.ts');
  assert.ok(
    sync.includes('listOrganizationFoldersForUser'),
    'sync loads org folders for confirmed memberships'
  );
  assert.ok(
    /validFolderIds\.add\(organizationFolder\.id\)/.test(sync),
    'org folder ids are valid cipher folderId targets'
  );
  assert.ok(
    /folderResponses\.push\(organizationFolderToSyncFolderResponse\(organizationFolder\)\)/.test(sync),
    'org folders ride the standard folders list'
  );
});

test('user-folder endpoints proxy org folders with permission checks', () => {
  const folders = read('src/handlers/folders.ts');
  assert.ok(
    folders.includes('getOrganizationFolderById'),
    'folder handlers resolve org folder ids first'
  );
  assert.ok(
    folders.includes('confirmedOrganizationFolderMembership'),
    'membership is checked before serving or acting'
  );
  assert.ok(
    folders.includes('Organization folders can only be managed by organization owners or admins'),
    'non-managers get a clear 403'
  );
  assert.ok(
    folders.includes('renameOrganizationFolderInternal') &&
    folders.includes('deleteOrganizationFolderInternal'),
    'rename/delete delegate to the same operations as the console'
  );
});
