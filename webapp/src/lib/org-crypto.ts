// CONTRACT:
// Organization key cryptography, mirroring the Bitwarden client model:
// - An organization owns a random 64-byte symmetric key (enc 32 + mac 32).
// - The org key is distributed to each member encrypted with that member's
//   RSA public key ("4.<b64>" — RSA-OAEP SHA-256), stored on the member row.
// - The org has its own RSA keypair; the private key is stored encrypted with
//   the org key ("2.iv|ct|mac").
// - Org ciphers/collections are encrypted with the org key. The server never
//   sees any of this material in the clear.
import { base64ToBytes, bytesToBase64, decryptBw, encryptBw, requireWebCrypto, toBufferSource } from './crypto';

export interface OrgKeyParts {
  encB64: string;
  macB64: string;
  encBytes: Uint8Array;
  macBytes: Uint8Array;
}

function parseRsaEncString(value: string): Uint8Array {
  const trimmed = String(value || '').trim();
  const dot = trimmed.indexOf('.');
  if (dot !== 1 || trimmed.slice(0, dot) !== '4') {
    throw new Error('Invalid organization key format');
  }
  return base64ToBytes(trimmed.slice(dot + 1));
}

// Decrypt the user's RSA private key (profile.privateKey, encrypted with the
// user symmetric key) into an importable CryptoKey.
export async function importUserPrivateKey(
  privateKeyEnc: string | null | undefined,
  userEnc: Uint8Array,
  userMac: Uint8Array
): Promise<CryptoKey | null> {
  if (!privateKeyEnc || !userEnc || !userMac) return null;
  try {
    const pkcs8 = await decryptBw(privateKeyEnc, userEnc, userMac);
    return await requireWebCrypto().subtle.importKey(
      'pkcs8',
      toBufferSource(pkcs8),
      { name: 'RSA-OAEP', hash: 'SHA-256' },
      false,
      ['decrypt']
    );
  } catch {
    return null;
  }
}

// Unwrap an organization key: RSA-OAEP-decrypt the "4." EncString with the
// user's private key, then split into enc/mac halves. Result is cached by the
// encrypted key string so repeated vault decrypts stay cheap.
const unwrappedOrgKeyCache = new Map<string, OrgKeyParts>();

export async function unwrapOrganizationKey(
  organizationId: string,
  orgKeyEnc: string | null | undefined,
  userPrivateKey: CryptoKey
): Promise<OrgKeyParts | null> {
  const cacheKey = `${organizationId}:${orgKeyEnc || ''}`;
  const cached = unwrappedOrgKeyCache.get(cacheKey);
  if (cached) return cached;

  if (!orgKeyEnc || !orgKeyEnc.startsWith('4.')) return null;
  try {
    const wrapped = parseRsaEncString(orgKeyEnc);
    const raw = new Uint8Array(
      await requireWebCrypto().subtle.decrypt(
        { name: 'RSA-OAEP' },
        userPrivateKey,
        toBufferSource(wrapped)
      )
    );
    if (raw.length < 64) return null;
    const encBytes = raw.slice(0, 32);
    const macBytes = raw.slice(32, 64);
    const parts: OrgKeyParts = {
      encBytes,
      macBytes,
      encB64: bytesToBase64(encBytes),
      macB64: bytesToBase64(macBytes),
    };
    unwrappedOrgKeyCache.set(cacheKey, parts);
    return parts;
  } catch {
    return null;
  }
}

// Generate the 64-byte organization symmetric key.
export function generateOrganizationKeyBytes(): Uint8Array {
  return requireWebCrypto().getRandomValues(new Uint8Array(64));
}

export function orgKeyBytesToParts(raw: Uint8Array): OrgKeyParts {
  if (raw.length < 64) throw new Error('Organization key must be 64 bytes');
  const encBytes = raw.slice(0, 32);
  const macBytes = raw.slice(32, 64);
  return {
    encBytes,
    macBytes,
    encB64: bytesToBase64(encBytes),
    macB64: bytesToBase64(macBytes),
  };
}

// Generate the organization RSA keypair. The private key is exported as PKCS8
// and encrypted with the org key (EncString type 2); the public key is plain
// base64 SPKI, exactly like users.public_key.
export async function generateOrganizationKeyPair(
  orgKey: OrgKeyParts
): Promise<{ publicKeyB64: string; encryptedPrivateKey: string }> {
  const subtle = requireWebCrypto().subtle;
  const pair = await subtle.generateKey(
    { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['encrypt', 'decrypt']
  );
  const spki = new Uint8Array(await subtle.exportKey('spki', pair.publicKey));
  const pkcs8 = new Uint8Array(await subtle.exportKey('pkcs8', pair.privateKey));
  const encryptedPrivateKey = await encryptBw(pkcs8, orgKey.encBytes, orgKey.macBytes);
  return { publicKeyB64: bytesToBase64(spki), encryptedPrivateKey };
}

// Wrap the org key for a member: RSA-OAEP encrypt with the member's public key
// (base64 SPKI), producing the "4.<b64>" EncString stored on confirm.
export async function wrapOrganizationKeyForUser(
  orgKeyRaw: Uint8Array,
  memberPublicKeyB64: string
): Promise<string> {
  const subtle = requireWebCrypto().subtle;
  const spki = base64ToBytes(String(memberPublicKeyB64 || '').trim());
  const publicKey = await subtle.importKey(
    'spki',
    toBufferSource(spki),
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['encrypt']
  );
  const wrapped = new Uint8Array(
    await subtle.encrypt({ name: 'RSA-OAEP' }, publicKey, toBufferSource(orgKeyRaw))
  );
  return `4.${bytesToBase64(wrapped)}`;
}

export async function encryptWithOrgKey(
  value: string,
  orgKey: OrgKeyParts
): Promise<string> {
  return encryptBw(new TextEncoder().encode(value), orgKey.encBytes, orgKey.macBytes);
}

export function clearUnwrappedOrgKeyCache(): void {
  unwrappedOrgKeyCache.clear();
}
