// Source-invariant tests for the security-audit remediation tickets
// (planning repo issues #9–#19, audit run nodewarden-1).
//
// WHY SOURCE PATTERNS: the identity/admin/router handlers import Cloudflare
// Workers types and have no seams for node:test (see scripts/organizations.test.ts
// for that strategy), so the invariants below are asserted against the source
// files with regexes.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

function read(path: string): string {
  return readFileSync(resolve(root, path), 'utf-8');
}

// ─── Ticket 1 (#9): passkey login enforces two-step login ───────────────────

test('webauthn grant runs the shared 2FA gate before any token is minted', () => {
  const identity = read('src/handlers/identity.ts');
  const branchStart = identity.indexOf("} else if (grantType === 'webauthn') {");
  const branchEnd = identity.indexOf("} else if (grantType === 'client_credentials') {");
  assert.ok(branchStart > 0 && branchEnd > branchStart, 'webauthn grant branch exists');
  const branch = identity.slice(branchStart, branchEnd);

  // The shared gate is evaluated inside the branch...
  assert.ok(
    /const twoFactor = await verifyLoginTwoFactor\(/.test(branch),
    'the webauthn branch calls the shared verifyLoginTwoFactor helper'
  );
  // ...before the access token is generated...
  assert.ok(
    branch.indexOf('verifyLoginTwoFactor(') < branch.indexOf('generateAccessToken'),
    'the 2FA gate precedes token issuance'
  );
  // ...and a challenge halts the branch instead of falling through.
  assert.ok(
    /if \(twoFactor\.status === 'halt'\) \{\s*return twoFactor\.response;/.test(branch),
    'a 2FA challenge halts the webauthn branch'
  );

  // The shared helper itself checks every enabled provider and challenges
  // when no second factor was supplied.
  const helper = identity.slice(identity.indexOf('async function verifyLoginTwoFactor'));
  assert.ok(
    /resolveTotpSecret\(user\.totpSecret\)/.test(helper)
      && /userYubiKeyPublicIds\(user\)/.test(helper)
      && /getAccountPasskeyCredentialsByUserId\(user\.id, 'twoFactor'\)/.test(helper),
    'the helper evaluates TOTP, YubiKey and twoFactor-passkey state'
  );
  assert.ok(
    /!hasProvider \|\| !hasToken/.test(helper) && /twoFactorRequiredResponse/.test(helper),
    'a missing provider/token returns the standard 2FA challenge'
  );

  // The password grant uses the same helper (single source of truth).
  const passwordBranch = identity.slice(
    identity.indexOf("if (grantType === 'password') {"),
    identity.indexOf("} else if (grantType === 'webauthn') {")
  );
  assert.ok(
    /const twoFactor = await verifyLoginTwoFactor\(/.test(passwordBranch),
    'the password grant routes through the same shared 2FA helper'
  );
});

// ─── Ticket 2 (#10): hide-passwords strip derived from access ───────────────

test('cipher update and attachment responses derive viewPassword from access', () => {
  const ciphers = read('src/handlers/ciphers.ts');
  const updateHandler = ciphers.slice(
    ciphers.indexOf('export async function handleUpdateCipher'),
    ciphers.indexOf('export async function handleDeleteCipher(')
  );

  // Both spellings are removed from the client-merge set...
  assert.ok(
    /viewPassword:\s*_clientViewPassword,\s*\n\s*ViewPassword:\s*_pascalClientViewPassword,/.test(updateHandler),
    'viewPassword (both spellings) is excluded from the update merge'
  );
  // ...and re-asserted from the loaded access info.
  assert.ok(
    /applyCipherAccessFlags\(cipher, loaded\.access\)/.test(updateHandler),
    'the update handler re-asserts access flags after the merge'
  );

  // The shared helper derives the flag ONLY from access.
  const helperStart = ciphers.indexOf('export function applyCipherAccessFlags');
  const helperEnd = ciphers.indexOf('// Load one cipher for an authenticated operation');
  const helper = ciphers.slice(helperStart, helperEnd);
  assert.ok(
    /cipher\.viewPassword = !access\.hidePasswords;/.test(helper),
    'applyCipherAccessFlags sets viewPassword from access.hidePasswords'
  );
  assert.ok(
    !/request|body|params/.test(helper),
    'the helper never derives the flag from request input'
  );

  // Attachment create/delete responses run the same derivation.
  const attachments = read('src/handlers/attachments.ts');
  const createHandler = attachments.slice(
    attachments.indexOf('export async function handleCreateAttachment'),
    attachments.indexOf('export async function handleUploadAttachment')
  );
  const deleteHandler = attachments.slice(
    attachments.indexOf('export async function handleDeleteAttachment'),
    attachments.indexOf('export async function deleteAllAttachmentsForCipher')
  );
  for (const [name, handler] of [['create', createHandler], ['delete', deleteHandler]] as const) {
    assert.ok(
      /applyCipherAccessFlags\(updatedCipher, updatedLoaded\?\.access\)/.test(handler),
      `attachment ${name} response derives the strip from access`
    );
  }
});

// ─── Ticket 4 (#12): master-password step-up on audit clear and settings ────

test('audit-log clear and retention settings require the master password', () => {
  const admin = read('src/handlers/admin.ts');
  const settingsHandler = admin.slice(
    admin.indexOf('export async function handleAdminUpdateAuditLogSettings'),
    admin.indexOf('export async function handleAdminClearAuditLogs')
  );
  const clearHandler = admin.slice(
    admin.indexOf('export async function handleAdminClearAuditLogs'),
    admin.indexOf('export async function handleAdminCreateInvite')
  );
  for (const [name, handler] of [['settings', settingsHandler], ['clear', clearHandler]] as const) {
    assert.ok(
      /requireMasterPasswordHash\(env, actorUser, body\.masterPasswordHash\)/.test(handler),
      `audit ${name} handler calls the master-password step-up helper`
    );
    assert.ok(
      handler.indexOf('requireMasterPasswordHash') < handler.indexOf('writeAuditLog'),
      `audit ${name} handler verifies the password before mutating`
    );
  }
});

// ─── Ticket 5 (#13): webauthn per-IP budget and stable lockout key ──────────

test('webauthn grant consumes the per-IP budget and keys the lockout on the verified credential', () => {
  const identity = read('src/handlers/identity.ts');
  const branchStart = identity.indexOf("} else if (grantType === 'webauthn') {");
  const branchEnd = identity.indexOf("} else if (grantType === 'client_credentials') {");
  const branch = identity.slice(branchStart, branchEnd);

  assert.ok(
    /consumeStrictBudget\(\s*`\$\{clientIdentifier\}:login-ip`,\s*LIMITS\.rateLimit\.loginIpRequestsPerMinute/.test(branch),
    'the webauthn branch consumes the per-IP login budget'
  );
  assert.ok(
    /loginRateLimitKey\(clientIdentifier!, grantType, credential\.id\)/.test(branch),
    'the lockout key is derived from the server-verified credential id'
  );
  assert.ok(
    !/loginRateLimitKey\(clientIdentifier!, grantType, token/.test(branch),
    'the lockout key no longer embeds the attacker-supplied token'
  );
});

// ─── Ticket 6 (#14): enumeration oracle cleanup ─────────────────────────────

test('recover-2fa burns PBKDF2 work for unknown/inactive accounts like the login path', () => {
  const accounts = read('src/handlers/accounts.ts');
  const handler = accounts.slice(accounts.indexOf('export async function handleRecoverTwoFactor'));
  const notFoundBranch = handler.slice(
    handler.indexOf('const user = await storage.getUser(email);'),
    handler.indexOf('const validPassword = await auth.verifyPassword')
  );
  assert.ok(
    /performDummyPasswordWork\(masterPasswordHash\)/.test(notFoundBranch)
      || /hashPasswordServer\(masterPasswordHash, user \? user\.email : 'timing-equalizer@invalid'\)/.test(notFoundBranch),
    'the not-found/inactive branch performs the timing-equalizer burn'
  );
});

test('auth-request creation enforces the known-device prerequisite with identical responses', () => {
  const authRequests = read('src/handlers/auth-requests.ts');
  const handler = authRequests.slice(
    authRequests.indexOf('export async function handleCreateAuthRequest'),
    authRequests.indexOf('export async function handleCreateAdminAuthRequest')
  );
  assert.ok(
    /isKnownDeviceByEmail\(email, deviceInfo\.deviceIdentifier\)/.test(handler),
    'creation checks that the device identifier is registered to the user'
  );
  const userBranch = handler.slice(
    handler.indexOf('const user = await storage.getUser(email);'),
    handler.indexOf('await storage.pruneExpiredAuthRequests()')
  );
  const responses = userBranch.match(/errorResponse\('User or known device not found\.', 400\)/g) || [];
  assert.ok(
    responses.length === 1,
    'unknown user and unknown device share one identical rejection'
  );
});

test('password-hint returns a constant body and never consults account state', () => {
  const accounts = read('src/handlers/accounts.ts');
  const handler = accounts.slice(
    accounts.indexOf('export async function handleGetPasswordHint'),
    accounts.indexOf('export async function handleGetProfile')
  );
  assert.ok(
    !/storage\.getUser\(/.test(handler),
    'the hint handler does not look up the account'
  );
  assert.ok(
    /hasHint:\s*false/.test(handler) && !/hasHint\s*=\s*!!/.test(handler),
    'the response body is constant (hasHint is a literal)'
  );
});

// ─── Ticket 7 (#15): Server-Timing gated on verified credentials ────────────

test('Server-Timing emission is gated on the router verification marker, not header presence', () => {
  const entry = read('src/index.ts');
  assert.ok(
    /isServerTimingVerified\(resp\)/.test(entry),
    'emission checks the router verification marker'
  );
  assert.ok(
    !/CREDENTIAL_HEADER_NAMES/.test(entry),
    'the old header-presence gate is gone'
  );
  assert.ok(
    !/headers\.has\('Authorization'\)/.test(entry),
    'attacker-controllable header presence never enables emission'
  );

  const router = read('src/router.ts');
  assert.ok(
    /markServerTimingVerified\(await respondVerified\(\)\)/.test(router),
    'the router stamps responses only after verifyAccessTokenWithUser succeeds'
  );
  const verifyPos = router.indexOf('verifyAccessTokenWithUser');
  const markerPos = router.indexOf('markServerTimingVerified(await respondVerified');
  assert.ok(verifyPos > 0 && markerPos > verifyPos, 'the marker follows credential verification');
});

// ─── Ticket 8 (#16): file-send access limit enforced once at delivery ───────

test('file-send access limit increments at delivery, not at mint', () => {
  const sendsPublic = read('src/handlers/sends-public.ts');
  const mintV1 = sendsPublic.slice(
    sendsPublic.indexOf('export async function handleAccessSendFile('),
    sendsPublic.indexOf('export async function handleAccessSendV2')
  );
  const mintV2 = sendsPublic.slice(
    sendsPublic.indexOf('export async function handleAccessSendFileV2'),
    sendsPublic.indexOf('export async function handleDownloadSendFile')
  );
  for (const [name, handler] of [['v1 mint', mintV1], ['v2 mint', mintV2]] as const) {
    assert.ok(
      !/incrementSendAccessCount/.test(handler),
      `${name} performs no access-count increment`
    );
    assert.ok(
      /isSendAvailable\(send\)/.test(handler),
      `${name} keeps the availability pre-check`
    );
  }
  const download = sendsPublic.slice(
    sendsPublic.indexOf('export async function handleDownloadSendFile'),
    sendsPublic.indexOf('export async function issueSendAccessToken')
  );
  assert.ok(
    /const delivered = await storage\.incrementSendAccessCount\(sendId\);/.test(download)
      && /if \(!delivered\) \{/.test(download),
    'the download endpoint increments and enforces the limit after token verification'
  );
  // Text sends unchanged: the access handler still increments at delivery.
  const textAccess = sendsPublic.slice(
    sendsPublic.indexOf('export async function handleAccessSend('),
    sendsPublic.indexOf('export async function handleAccessSendFile(')
  );
  assert.ok(
    /incrementSendAccessCount/.test(textAccess),
    'text sends still count access on the access endpoint'
  );
});

// ─── Ticket 9 (#17): router hardening ───────────────────────────────────────

test('the Content-Length guard runs before the large-upload early return', () => {
  const router = read('src/router.ts');
  const fn = router.slice(
    router.indexOf('async function enforceRequestBodyLimit'),
    router.indexOf('export async function handleRequest')
  );
  // The old bug: the early return swallowed large-upload paths, so the
  // Content-Length guard that followed was dead code.
  assert.ok(
    !/\|\| isLargeUploadPath\(path\)/.test(fn),
    'the generic early return no longer swallows large-upload paths'
  );
  const largeBranch = fn.slice(
    fn.indexOf('if (isLargeUploadPath(path)) {'),
    fn.indexOf('const contentLengthRaw')
  );
  assert.ok(
    largeBranch.includes("if (!request.headers.get('Content-Length')) {")
      && largeBranch.includes("return errorResponse('Content-Length required', 411);"),
    'the Content-Length check executes for large-upload paths'
  );
});

test('the isolate limiter uses the shared IP normalization and never clears the whole map', () => {
  const routerPublic = read('src/router-public.ts');
  const fn = routerPublic.slice(
    routerPublic.indexOf('function enforceIsolateRateLimit'),
    routerPublic.indexOf('export interface WebBootstrapResponse')
  );
  assert.ok(
    /getClientIdentifier\(request\)/.test(fn),
    'buckets key on the shared normalized IP (/64 aggregation)'
  );
  assert.ok(
    !/isolateRateBuckets\.clear\(\)/.test(routerPublic),
    'the limiter never drops other clients\' counters with a mass clear'
  );
  assert.ok(
    /isolateRateBuckets\.delete\(key\)/.test(fn) && /resetAt <= now/.test(fn),
    'expired entries are evicted instead'
  );
});

// ─── Ticket #23: atomic, lock-aware login lockout ───────────────────────────
// The failed-login transition must be a single atomic UPSERT that (a) engages
// the lock when the counter reaches the max, (b) freezes the counter while a
// lock is active, and (c) never extends an active lock — with no follow-up
// read or UPDATE. The SQL is extracted from the source so the test cannot
// drift from the implementation, and run against an in-memory SQLite with the
// same schema (D1 serializes writes, so sequential semantics are the
// concurrent semantics).

function extractRecordFailedLoginSql(): string {
  const src = read('src/services/ratelimit.ts');
  const start = src.indexOf('async recordFailedLogin');
  const end = src.indexOf('async clearLoginAttempts');
  const body = src.slice(start, end);
  const m = body.match(/prepare\(\s*([\s\S]*?)\)\s*\.bind/);
  assert.ok(m, 'recordFailedLogin prepare call found');
  const literals = [...(m[1] as string).matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((x) => x[1]);
  assert.ok(literals.length > 1, 'SQL literals extracted');
  return literals.join('');
}

test('login lockout UPSERT: lock engages at the 10th failure, counter and deadline freeze while locked', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE login_attempts_ip (ip TEXT PRIMARY KEY, attempts INTEGER NOT NULL, locked_until INTEGER, updated_at INTEGER NOT NULL)');
  const sql = extractRecordFailedLoginSql();
  const stmt = db.prepare(sql);
  const now = Date.now();
  const MAX = 10;
  const LOCK_MS = 120000;

  // 30 sequential failed logins (bind order: ip, now, now, now, max, now, lockMs)
  let tenth: { attempts: number; locked_until: number | null } | undefined;
  for (let i = 1; i <= 30; i++) {
    const row = stmt.get('ip1', now, now, now, MAX, now, LOCK_MS) as { attempts: number; locked_until: number | null };
    if (i === 10) tenth = row;
  }
  const row = db.prepare('SELECT attempts, locked_until FROM login_attempts_ip WHERE ip = ?').get('ip1') as { attempts: number; locked_until: number };

  assert.equal(row.attempts, 10, 'counter frozen at the cap (30 failures, not 30 counted)');
  assert.equal(row.locked_until, now + LOCK_MS, 'lock deadline set once, at the cap');
  assert.ok(tenth, 'the 10th failure returned its row');
  assert.equal(tenth!.attempts, 10, 'lock set during the burst (10th failure)');
  assert.equal(tenth!.locked_until, now + LOCK_MS, 'the 10th failure reports the lock');

  // Post-lock stragglers must not extend the deadline or grow the counter.
  for (let i = 0; i < 5; i++) stmt.get('ip1', now, now, now, MAX, now, LOCK_MS);
  const after = db.prepare('SELECT attempts, locked_until FROM login_attempts_ip WHERE ip = ?').get('ip1') as { attempts: number; locked_until: number };
  assert.equal(after.attempts, 10, 'attempts do not grow while locked');
  assert.equal(after.locked_until, now + LOCK_MS, 'an active lock is never extended');
});

test('login lockout UPSERT: fresh IPs count normally; expired locks re-arm on the next failure', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE login_attempts_ip (ip TEXT PRIMARY KEY, attempts INTEGER NOT NULL, locked_until INTEGER, updated_at INTEGER NOT NULL)');
  const stmt = db.prepare(extractRecordFailedLoginSql());
  const now = Date.now();
  const MAX = 10;
  const LOCK_MS = 120000;

  const first = stmt.get('ip2', now, now, now, MAX, now, LOCK_MS) as { attempts: number; locked_until: number | null };
  assert.equal(first.attempts, 1, 'fresh IP starts at 1');
  assert.equal(first.locked_until, null, 'fresh IP is not locked');

  // A row whose lock already expired (checkLoginAttempt deletes these in the
  // normal flow, but a failure may arrive before that) re-arms the lock on
  // the next failure — the long-standing behavior, unchanged.
  db.prepare('UPDATE login_attempts_ip SET attempts = 10, locked_until = ? WHERE ip = ?').run(now - 1, 'ip2');
  const rearmed = stmt.get('ip2', now, now, now, MAX, now, LOCK_MS) as { attempts: number; locked_until: number | null };
  assert.ok(rearmed.locked_until && rearmed.locked_until > now, 'next failure after expiry re-arms the lock');
});

test('recordFailedLogin has no follow-up read or unguarded locked_until UPDATE', () => {
  const src = read('src/services/ratelimit.ts');
  const body = src.slice(src.indexOf('async recordFailedLogin'), src.indexOf('async clearLoginAttempts'));
  assert.ok(
    /RETURNING attempts, locked_until/.test(body),
    'the transition returns its row via RETURNING (no follow-up read)'
  );
  assert.ok(
    !/UPDATE login_attempts_ip SET locked_until/.test(body),
    'the old unguarded locked_until UPDATE is gone'
  );
});

// ─── Ticket #22: hub negotiate budget ───────────────────────────────────────

test('hub negotiate consumes a dedicated per-IP budget before token issuance', () => {
  const routerPublic = read('src/router-public.ts');
  const routeStart = routerPublic.indexOf("'/notifications/hub/negotiate'");
  const route = routerPublic.slice(routeStart, routerPublic.indexOf('handleNotificationsNegotiate', routeStart) + 40);
  assert.ok(
    /enforcePublicRateLimit\('hub-negotiate', LIMITS\.rateLimit\.hubNegotiateRequestsPerMinute\)/.test(route),
    'the negotiate route consumes its dedicated budget first'
  );
  assert.ok(
    route.indexOf('enforcePublicRateLimit') < route.indexOf('handleNotificationsNegotiate'),
    'the budget runs before token issuance'
  );
  const router = read('src/router.ts');
  assert.ok(
    /category === 'hub-negotiate'/.test(router),
    'hub-negotiate uses the D1-backed strict budget'
  );
  const limits = read('src/config/limits.ts');
  assert.ok(
    /hubNegotiateRequestsPerMinute:\s*60/.test(limits),
    'the negotiate limit is defined (60/min per IP)'
  );
});


// ─── Ticket 10 (#18): web-bootstrap stops disclosing security state ─────────

test('the public bootstrap no longer discloses JWT strength, provisioning or the origin allowlist', () => {
  const routerPublic = read('src/router-public.ts');
  const bootstrap = routerPublic.slice(
    routerPublic.indexOf('export async function buildWebBootstrapResponse'),
    routerPublic.indexOf('export async function handlePublicRoute')
  );
  assert.ok(
    !/jwtUnsafeReason|jwtSecretMinLength/.test(bootstrap),
    'JWT weakness classification is not published'
  );
  assert.ok(
    !/getUserCount/.test(bootstrap),
    'the provisioning bit no longer reflects the user count'
  );
  assert.ok(
    !/webAuthnAllowedOrigins|getConfiguredWebAuthnAllowedOrigins/.test(bootstrap),
    'the WebAuthn origin allowlist is not published'
  );
  assert.ok(
    /registrationInviteRequired: true/.test(bootstrap),
    'registrationInviteRequired is a constant (the register endpoint enforces the real rule)'
  );

  const types = read('webapp/src/lib/types.ts');
  assert.ok(
    !/jwtUnsafeReason|jwtSecretMinLength|webAuthnAllowedOrigins/.test(types),
    'webapp types match the slimmed bootstrap shape'
  );

  // Both connectors validate their parent origin server-side.
  for (const path of [
    'webapp/public/webauthn-connector.js',
    'webapp/public/webauthn-fallback-connector.html',
  ]) {
    const src = read(path);
    assert.ok(
      src.includes('/api/webauthn/origin-check'),
      `${path} submits the parent origin for server-side validation`
    );
    assert.ok(
      !src.includes('webAuthnAllowedOrigins'),
      `${path} no longer reads the published allowlist`
    );
  }

  // The operator warning moved to startup/server tooling.
  const router = read('src/router.ts');
  assert.ok(
    /warnOnUnsafeJwtSecret/.test(router),
    'an unsafe JWT secret is logged for the operator'
  );
});
