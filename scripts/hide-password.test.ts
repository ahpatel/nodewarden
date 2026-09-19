// Executable round-trip tests for the server-side hide-passwords strip.
// Unlike the handler layer (Workers-typed, untestable outside the runtime —
// see scripts/organizations.test.ts for that strategy), the strip is a pure
// util so its behaviour is verified here with real inputs.
import assert from 'node:assert/strict';
import test from 'node:test';
import { stripPasswordMaterial } from '../src/utils/hide-password-material';

test('strips every password-bearing field across all cipher types', () => {
  const stripped = stripPasswordMaterial({
    login: { username: '2.AAA|BBB|CCC', password: '2.PW|PW|PW', totp: '2.TP|TP|TP', uris: [] },
    card: { cardholderName: '2.N|N|N', code: '2.CD|CD|CD', brand: 'visa' },
    identity: { ssn: '2.SSN|S|S', licenseNumber: '2.LN|L|L', passportNumber: '2.PN|P|P', firstName: '2.F|F|F' },
    sshKey: { privateKey: '2.SK|SK|SK', publicKey: '2.PK|PK|PK' },
    bankAccount: { pin: '2.PIN|P|P', accountNumber: '2.AN|A|A', bankName: '2.BN|B|B' },
    driversLicense: { licenseNumber: '2.DL|D|D', firstName: '2.F|F|F' },
    passport: { passportNumber: '2.PP|P|P', surname: '2.S|S|S' },
    fields: [
      { type: 0, name: '2.TF|T|T', value: '2.TV|T|T' },
      { type: 1, name: '2.HF|H|H', value: '2.HV|H|H' },
    ],
    passwordHistory: [{ password: '2.HP|H|H', lastUsedDate: '2024-01-01' }],
  });

  // Login password + TOTP gone; username and uris intact.
  assert.equal((stripped.login as any).password, null);
  assert.equal((stripped.login as any).totp, null);
  assert.ok((stripped.login as any).username);
  // Card security code gone; holder name + brand intact.
  assert.equal((stripped.card as any).code, null);
  assert.ok((stripped.card as any).cardholderName);
  // Identity SSN/license/passport numbers gone; firstName intact.
  assert.equal((stripped.identity as any).ssn, null);
  assert.equal((stripped.identity as any).licenseNumber, null);
  assert.equal((stripped.identity as any).passportNumber, null);
  assert.ok((stripped.identity as any).firstName);
  // SSH private key gone; public key intact.
  assert.equal((stripped.sshKey as any).privateKey, null);
  assert.ok((stripped.sshKey as any).publicKey);
  // Bank PIN + account number gone; bank name intact.
  assert.equal((stripped.bankAccount as any).pin, null);
  assert.equal((stripped.bankAccount as any).accountNumber, null);
  assert.ok((stripped.bankAccount as any).bankName);
  // License / passport numbers gone; non-secret fields intact.
  assert.equal((stripped.driversLicense as any).licenseNumber, null);
  assert.ok((stripped.driversLicense as any).firstName);
  assert.equal((stripped.passport as any).passportNumber, null);
  assert.ok((stripped.passport as any).surname);
  // Only hidden-type fields are stripped; text fields keep their value.
  assert.ok((stripped.fields as any)[0].value);
  assert.equal((stripped.fields as any)[1].value, null);
  // Password history is password material wholesale.
  assert.equal(stripped.passwordHistory, null);
});

test('stripped values are explicit nulls, and null sections stay null', () => {
  const stripped = stripPasswordMaterial({
    login: { password: '2.PW|PW|PW', totp: '2.TP|TP|TP' },
    fields: [{ type: 1, value: '2.HV|H|H' }],
  });
  assert.ok('password' in (stripped.login as any));
  assert.equal((stripped.login as any).password, null);
  assert.equal(stripped.card, null);
  assert.equal(stripped.identity, null);
  assert.equal(stripped.sshKey, null);
});
