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
    storage.includes("STORAGE_SCHEMA_VERSION = '2026-09-19-security-fixes'"),
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
