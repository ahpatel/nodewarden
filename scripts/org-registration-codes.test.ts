// Source-invariant tests for member registration codes (planning issue #21):
// owners can view and re-mint the registration code of a pending, unlinked
// organization member. The server handlers import Cloudflare Workers types
// and have no seams for node:test, so the invariants are asserted against
// the source files with regexes (see scripts/organizations.test.ts for that
// strategy). i18n parity is enforced by scripts/i18n-validate.cjs.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

function read(path: string): string {
  return readFileSync(resolve(root, path), 'utf-8');
}

function handlerSource(name: string): string {
  const src = read('src/handlers/organizations.ts');
  const start = src.indexOf(`export async function ${name}`);
  assert.ok(start > 0, `${name} exists`);
  const rest = src.slice(start);
  const end = rest.indexOf('\n}\n');
  return rest.slice(0, end);
}

// ─── Owner guard and eligibility ────────────────────────────────────────────

test('both registration-code endpoints are owner-gated before any other work', () => {
  const get = handlerSource('handleGetMemberRegistrationCode');
  const remint = handlerSource('handleRemintMemberRegistrationCode');
  for (const [name, src] of [['GET', get], ['remint', remint]] as const) {
    assert.ok(
      /const owner = await requireOrganizationOwner\(storage, organizationId, userId\)/.test(src),
      `${name} calls the shared owner guard`
    );
    assert.ok(
      src.indexOf('requireOrganizationOwner') < src.indexOf('getOrganizationUser'),
      `${name} checks ownership before loading the member`
    );
  }
});

test('registration codes apply only to invited, unlinked members', () => {
  const remint = handlerSource('handleRemintMemberRegistrationCode');
  const get = handlerSource('handleGetMemberRegistrationCode');
  for (const [name, src] of [['remint', remint], ['GET', get]] as const) {
    assert.ok(
      /member\.status !== ORG_USER_STATUS\.INVITED \|\| member\.userId/.test(src),
      `${name} rejects members that are not invited-and-unlinked`
    );
  }
});

test('squatted emails: GET explains, remint refuses', () => {
  const get = handlerSource('handleGetMemberRegistrationCode');
  const remint = handlerSource('handleRemintMemberRegistrationCode');
  assert.ok(
    /reason: 'email_registered'/.test(get),
    'GET returns the email_registered reason for squatted rows'
  );
  assert.ok(
    !/reason: 'email_registered'/.test(remint),
    'remint does not silently return a reason shape'
  );
  assert.ok(
    /already been registered/.test(remint) && /409/.test(remint),
    'remint refuses squatted emails with 409'
  );
});

// ─── Re-mint semantics ──────────────────────────────────────────────────────

test('remint revokes all email-bound codes before minting the replacement', () => {
  const remint = handlerSource('handleRemintMemberRegistrationCode');
  const revokePos = remint.indexOf('revokeActiveInvitesByEmail');
  const mintPos = remint.indexOf('storage.createInvite');
  assert.ok(revokePos > 0 && mintPos > revokePos, 'revocation precedes minting');
  // The replacement is minted bound to the member's email with the standard TTL.
  assert.ok(
    /ORG_INVITE_REGISTRATION_TTL_HOURS/.test(remint) && /code: randomHex\(20\)/.test(remint),
    'the replacement uses the standard TTL and code generator'
  );
  assert.ok(
    /createdBy: userId/.test(remint) && /usedBy: null/.test(remint),
    'the replacement is owned by the requesting owner and unused'
  );
});

test('remint works regardless of the self-service registration toggle', () => {
  const remint = handlerSource('handleRemintMemberRegistrationCode');
  assert.ok(
    !/ORG_SELF_SERVICE_REGISTRATION_CONFIG_KEY/.test(remint),
    'remint does not consult the self-service toggle (it gates new invitations only)'
  );
});

test('remint is audited with email and expiry, without the raw code', () => {
  const remint = handlerSource('handleRemintMemberRegistrationCode');
  assert.ok(
    /writeOrgAudit\(\s*storage, request, userId, 'organization\.user\.invite\.remint'/.test(remint),
    'the remint action is audited'
  );
  const auditStart = remint.indexOf('organization.user.invite.remint');
  const auditBlock = remint.slice(auditStart, remint.indexOf('})', auditStart));
  assert.ok(/email/.test(auditBlock) && /expiresAt/.test(auditBlock), 'metadata includes email and expiry');
  assert.ok(!/invite\.code|inviteCode/.test(auditBlock), 'the raw code is not logged');
});

test('both responses carry the server-built invite link', () => {
  const get = handlerSource('handleGetMemberRegistrationCode');
  const remint = handlerSource('handleRemintMemberRegistrationCode');
  assert.ok(/buildInviteLink\(request/.test(get), 'GET builds the link server-side');
  assert.ok(/buildInviteLink\(request/.test(remint), 'remint builds the link server-side');
  const admin = read('src/handlers/admin.ts');
  assert.ok(
    /export function buildInviteLink/.test(admin),
    'buildInviteLink is shared with the admin flow (one link format)'
  );
});

// ─── Routes ─────────────────────────────────────────────────────────────────

test('routes are dispatched under the member sub-path with correct methods', () => {
  const router = read('src/router-authenticated.ts');
  assert.ok(
    /userSubPath === '\/registration-code' && method === 'GET'/.test(router),
    'GET route registered'
  );
  assert.ok(
    /userSubPath === '\/registration-code\/remint' && \(method === 'POST' \|\| method === 'PUT'\)/.test(router),
    'remint route registered for POST/PUT'
  );
});

// ─── Storage: one live code per pending email ───────────────────────────────

test('storage revokes every active email-bound code and lists newest first', () => {
  const repo = read('src/services/storage-admin-repo.ts');
  const revokeStart = repo.indexOf('export async function revokeActiveInvitesByEmail');
  const revokeEnd = repo.indexOf('export async function', revokeStart + 1);
  const revoke = repo.slice(revokeStart, revokeEnd > 0 ? revokeEnd : undefined);
  assert.ok(
    /status = 'revoked'/.test(revoke) && /email = \?/.test(revoke),
    'revocation targets active email-bound codes only'
  );
  assert.ok(
    !/status != 'active'/.test(revoke),
    'revocation does not touch non-active rows'
  );
  const list = repo.slice(repo.indexOf('export async function listActiveInvitesByEmail'));
  assert.ok(
    /ORDER BY created_at DESC/.test(list),
    'listing is newest-first so the re-minted replacement wins'
  );
});

// ─── Webapp ─────────────────────────────────────────────────────────────────

test('member rows expose the dialog for owners on invited, unlinked members only', () => {
  const page = read('webapp/src/components/OrganizationsPage.tsx');
  assert.ok(
    /selectedIsOwner && Number\(member\.status\) === STATUS_INVITED && !member\.userId/.test(page),
    'the table button is gated on owner + invited + unlinked'
  );
  assert.ok(/setRegistrationCodeMember\(member\)/.test(page), 'the button opens the dialog');
});

test('the dialog loads the code and rotates it through the API client', () => {
  const dialog = read('webapp/src/components/OrganizationRegistrationCodeDialog.tsx');
  assert.ok(
    /getMemberRegistrationCode/.test(dialog) && /remintMemberRegistrationCode/.test(dialog),
    'the dialog uses the dedicated API client functions'
  );
  const api = read('webapp/src/lib/api/organizations.ts');
  assert.ok(
    /registration-code\/remint/.test(api) && /\/registration-code`/.test(api),
    'the API client targets both endpoints'
  );
});

test('the post-invite result dialog surfaces codes instead of the old toast', () => {
  const page = read('webapp/src/components/OrganizationsPage.tsx');
  assert.ok(/setInviteResult\(result\)/.test(page), 'invite results open the dialog');
  assert.ok(
    !/txt_organizations_invite_codes_note/.test(page),
    'the old "share from admin panel" toast is gone'
  );
  assert.ok(
    /txt_organizations_invite_result_title/.test(page) && /txt_copy_link/.test(page),
    'the dialog lists codes with copy-link actions'
  );
});
