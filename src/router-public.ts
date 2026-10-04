import { LIMITS } from './config/limits';
import {
  handleAccessSend,
  handleAccessSendFile,
  handleAccessSendV2,
  handleAccessSendFileV2,
  handleDownloadSendFile,
} from './handlers/sends';
import { handleKnownDevice } from './handlers/devices';
import {
  handleDigitalAssetLinkCheck,
  handleFillAssistForms,
  handleFillAssistManifest,
} from './handlers/fill-assist';
import { handleToken, handlePrelogin, handleRevocation } from './handlers/identity';
import { handleGetAccountPasskeyAssertionOptions } from './handlers/account-passkeys';
import {
  handleRegister,
  handleGetPasswordHint,
  handleRecoverTwoFactor,
} from './handlers/accounts';
import {
  handleCreateAuthRequest,
  handleGetAuthRequestResponse,
} from './handlers/auth-requests';
import { handlePublicDownloadAttachment } from './handlers/attachments';
import { handlePublicUploadAttachment } from './handlers/attachments';
import {
  handleAnonymousNotificationsHub,
  handleNotificationsHub,
  handleNotificationsNegotiate,
} from './handlers/notifications';
import { handlePublicUploadSendFile } from './handlers/sends';
import { isSafeWebsiteIconContentType } from './utils/content-type';
import { jsonResponse, unsupportedResponse } from './utils/response';
import { isConfiguredWebAuthnAllowedOrigin } from './utils/origins';
import { getClientIdentifier } from './services/ratelimit';
import type { Env } from './types';
import { buildConfigResponse } from './config-response';

type PublicRateLimiter = (category?: string, maxRequests?: number) => Promise<Response | null>;

/* Isolate-local rate limiter for database-free endpoints. Deliberately
   approximate (per-isolate state): these endpoints build static responses
   without touching D1, so protecting the database from them is meaningless —
   this only guards worker CPU while keeping the path free of database
   round-trips. */
const isolateRateBuckets = new Map<string, { count: number; resetAt: number }>();
const ISOLATE_BUCKET_LIMIT = 10000;

/* ETag helper: SHA-1 is fine for validator tokens (not a security primitive). */
async function sha1Prefix(input: string, length: number): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .slice(0, Math.ceil(length / 2))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, length);
}

function enforceIsolateRateLimit(request: Request, maxRequests: number): Response | null {
  // Shared IP normalization (IPv4-mapped collapse, /64 aggregation): the
  // raw CF-Connecting-IP header let IPv6 clients rekey per address.
  const clientId = getClientIdentifier(request);
  if (!clientId) {
    return new Response(
      JSON.stringify({
        error: 'Forbidden',
        error_description: 'Client IP is required',
      }),
      {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
  const now = Date.now();
  if (isolateRateBuckets.size > ISOLATE_BUCKET_LIMIT) {
    // Evict expired entries; if a flood of distinct fresh clients still
    // leaves the map over the bound, shed the oldest buckets only. Never
    // clear the whole map: that would reset every client's counters at
    // once and reward the flood.
    for (const [key, bucket] of isolateRateBuckets) {
      if (bucket.resetAt <= now) isolateRateBuckets.delete(key);
    }
    while (isolateRateBuckets.size > ISOLATE_BUCKET_LIMIT) {
      const oldest = isolateRateBuckets.keys().next().value;
      if (oldest === undefined) break;
      isolateRateBuckets.delete(oldest);
    }
  }
  const bucket = isolateRateBuckets.get(clientId);
  if (!bucket || now > bucket.resetAt) {
    isolateRateBuckets.set(clientId, { count: 1, resetAt: now + 60000 });
    return null;
  }
  bucket.count += 1;
  if (bucket.count > maxRequests) {
    return new Response(
      JSON.stringify({
        error: 'Too many requests',
        error_description: `Rate limit exceeded. Try again in ${Math.ceil((bucket.resetAt - now) / 1000)} seconds.`,
      }),
      {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': String(Math.ceil((bucket.resetAt - now) / 1000)),
          'X-RateLimit-Remaining': '0',
        },
      }
    );
  }
  return null;
}
export interface WebBootstrapResponse {
  defaultKdfIterations: number;
  registrationInviteRequired: boolean;
  websiteIconsEnabled: boolean;
}

async function isWebsiteIconProxyEnabled(env: Env): Promise<boolean> {
  return true;
}

/* The webauthn connector page proves its parent origin to the server one
   origin at a time instead of reading the full allowlist from the public
   bootstrap. Only env-configured lookups: no D1, no account state, and a
   single yes/no bit per queried origin rather than the whole list. */
async function handleWebauthnOriginCheck(request: Request, env: Env): Promise<Response> {
  let body: { origin?: unknown } = {};
  try {
    const parsed: unknown = await request.json();
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      body = parsed as { origin?: unknown };
    }
  } catch {
    body = {};
  }
  const allowed = isConfiguredWebAuthnAllowedOrigin(env, body.origin);
  return jsonResponse({ allowed });
}

function isSameOriginWriteRequest(request: Request): boolean {
  const targetOrigin = new URL(request.url).origin;
  const origin = request.headers.get('Origin');
  if (origin) {
    return origin === targetOrigin;
  }

  const referer = request.headers.get('Referer');
  if (referer) {
    try {
      return new URL(referer).origin === targetOrigin;
    } catch {
      return false;
    }
  }

  return false;
}

function getDefaultWebsiteIconSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96" role="img" aria-label="Globe icon"><circle cx="48" cy="48" r="34" fill="none" stroke="#8ea9c7" stroke-width="6"/><path d="M14 48h68M48 14c10 10 16 21.5 16 34s-6 24-16 34c-10-10-16-21.5-16-34s6-24 16-34zm-24 10c8 5 17 8 24 8s16-3 24-8m-48 48c8-5 17-8 24-8s16 3 24 8" fill="none" stroke="#8ea9c7" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function handleNwFavicon(): Response {
  return new Response(getDefaultWebsiteIconSvg(), {
    status: 200,
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': `public, max-age=${LIMITS.cache.iconTtlSeconds}, immutable`,
    },
  });
}

function handleMissingWebsiteIcon(): Response {
  return new Response(null, {
    status: 404,
    headers: {
      'Cache-Control': 'public, max-age=300',
    },
  });
}

function normalizeIconHost(rawHost: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(String(rawHost || '').trim()).toLowerCase().replace(/\.+$/, '');
  } catch {
    return null;
  }
  if (!decoded || decoded.includes('/') || decoded.includes('\\')) return null;
  try {
    const parsed = new URL(`https://${decoded}`);
    return parsed.hostname === decoded ? decoded : null;
  } catch {
    return null;
  }
}

const ICON_UPSTREAM_TIMEOUT_MS = 2500;
const ICON_MAX_BUFFER_BYTES = 256 * 1024;
const BITWARDEN_DEFAULT_GLOBE_ICON_BYTES = 500;
const BITWARDEN_DEFAULT_GLOBE_ICON_SHA256 = 'aaa64871332ad5b7d28fe8874efb19c2d9cc2f1e6de75d52b080b438225a0783';

type IconSource = {
  url: string;
  rejectImage?: {
    byteLength: number;
    sha256: string;
  };
  headers?: HeadersInit;
};

async function fetchIconSource(source: { url: string; headers?: HeadersInit }): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ICON_UPSTREAM_TIMEOUT_MS);
  try {
    return await fetch(source.url, {
      headers: source.headers,
      redirect: 'follow',
      signal: controller.signal,
      cf: {
        cacheEverything: true,
        cacheTtl: LIMITS.cache.iconTtlSeconds,
      },
    } as RequestInit & { cf: { cacheEverything: boolean; cacheTtl: number } });
  } finally {
    clearTimeout(timeout);
  }
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function getPositiveContentLength(headers: Headers): number | null {
  const raw = headers.get('Content-Length');
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

async function readIconBytes(response: Response, maxBytes: number): Promise<ArrayBuffer | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => undefined);
  }, ICON_UPSTREAM_TIMEOUT_MS);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }

  if (timedOut || totalBytes === 0) return null;

  const output = new ArrayBuffer(totalBytes);
  const bytes = new Uint8Array(output);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function iconResponse(body: BodyInit | null, contentType: string | null): Response {
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': contentType || 'image/png',
      'Cache-Control': `public, max-age=${LIMITS.cache.iconTtlSeconds}, immutable`,
      'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; sandbox",
    },
  });
}

async function handleWebsiteIcon(env: Env, host: string, fallbackMode: 'default' | 'not-found' = 'default'): Promise<Response> {
  if (!isWebsiteIconProxyEnabled(env)) {
    return fallbackMode === 'not-found' ? handleMissingWebsiteIcon() : handleNwFavicon();
  }

  const normalizedHost = normalizeIconHost(host);
  if (!normalizedHost) return fallbackMode === 'not-found' ? handleMissingWebsiteIcon() : handleNwFavicon();

  const encodedHost = encodeURIComponent(normalizedHost);
  const requestHeaders = { 'User-Agent': 'NodeWarden/1.0' };
  const upstreamSources: IconSource[] = [
    {
      url: `https://favicon.im/zh/${encodedHost}?larger=true&throw-error-on-404=true`,
      headers: requestHeaders,
    },
    {
      url: `https://icons.bitwarden.net/${encodedHost}/icon.png`,
      rejectImage: {
        byteLength: BITWARDEN_DEFAULT_GLOBE_ICON_BYTES,
        sha256: BITWARDEN_DEFAULT_GLOBE_ICON_SHA256,
      },
      headers: requestHeaders,
    },
  ];

  for (const source of upstreamSources) {
    try {
      const resp = await fetchIconSource(source);

      if (!resp.ok) continue;
      const contentType = String(resp.headers.get('Content-Type') || '').toLowerCase();
      if (!isSafeWebsiteIconContentType(contentType)) continue;

      const contentLength = getPositiveContentLength(resp.headers);
      if (contentLength !== null && contentLength > ICON_MAX_BUFFER_BYTES) continue;

      const bytes = await readIconBytes(resp, ICON_MAX_BUFFER_BYTES);
      if (!bytes) continue;
      if (
        source.rejectImage &&
        bytes.byteLength === source.rejectImage.byteLength &&
        (await sha256Hex(bytes)) === source.rejectImage.sha256
      ) {
        continue;
      }

      return iconResponse(bytes, resp.headers.get('Content-Type'));
    } catch {
      continue;
    }
  }

  return fallbackMode === 'not-found' ? handleMissingWebsiteIcon() : handleNwFavicon();
}

export async function buildWebBootstrapResponse(env: Env): Promise<WebBootstrapResponse> {
  // Deliberately minimal: this endpoint is unauthenticated, so it must not
  // disclose instance security state.
  // - JWT secret strength and threshold: an attacker learns whether token
  //   signing is forgeable. The operator is warned once per isolate in the
  //   server logs instead (see router.ts warnOnUnsafeJwtSecret).
  // - Registration invite requirement is a constant true. The live value
  //   derives from the user count and would advertise "the next
  //   registration becomes instance admin" on fresh deployments; the
  //   register endpoint itself enforces the real first-user/invite rule.
  // - The WebAuthn origin allowlist is validated server-side per origin
  //   (see /api/webauthn/origin-check); publishing it exposed operator-
  //   configured internal hostnames.
  return {
    defaultKdfIterations: LIMITS.auth.defaultKdfIterations,
    registrationInviteRequired: true,
    websiteIconsEnabled: await isWebsiteIconProxyEnabled(env),
  };
}

export async function handlePublicRoute(
  request: Request,
  env: Env,
  path: string,
  method: string,
  enforcePublicRateLimit: PublicRateLimiter
): Promise<Response | null> {
  if (path === '/.well-known/appspecific/com.chrome.devtools.json' && method === 'GET') {
    return new Response('{}', {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  }

  if ((path === '/api/web-bootstrap' || path === '/web-bootstrap') && method === 'GET') {
    const blocked = await enforcePublicRateLimit('public-read', LIMITS.rateLimit.publicReadRequestsPerMinute);
    if (blocked) return blocked;
    return jsonResponse(await buildWebBootstrapResponse(env));
  }

  if (path === '/api/webauthn/origin-check' && method === 'POST') {
    // Database-free (env-only lookup), so the isolate-local limiter guards it.
    const blocked = enforceIsolateRateLimit(request, LIMITS.rateLimit.publicReadRequestsPerMinute);
    if (blocked) return blocked;
    return handleWebauthnOriginCheck(request, env);
  }

  if (path === '/fill-assist/manifest.json' && method === 'GET') {
    const blocked = await enforcePublicRateLimit('public-read', LIMITS.rateLimit.publicReadRequestsPerMinute);
    if (blocked) return blocked;
    return handleFillAssistManifest();
  }

  if ((path === '/v1/assetlinks:check' || path === '/api/v1/assetlinks:check') && method === 'GET') {
    const blocked = await enforcePublicRateLimit('public-read', LIMITS.rateLimit.publicReadRequestsPerMinute);
    if (blocked) return blocked;
    return handleDigitalAssetLinkCheck();
  }

  const fillAssistFormsMatch = path.match(/^\/fill-assist\/([^/]+)$/i);
  if (fillAssistFormsMatch && method === 'GET') {
    const blocked = await enforcePublicRateLimit('public-read', LIMITS.rateLimit.publicReadRequestsPerMinute);
    if (blocked) return blocked;
    return handleFillAssistForms(fillAssistFormsMatch[1]);
  }

  const iconMatch = path.match(/^\/icons\/([^/]+)\/icon\.png$/i);
  if (iconMatch && method === 'GET') {
    const blocked = await enforcePublicRateLimit('public-icon', LIMITS.rateLimit.publicIconRequestsPerMinute);
    if (blocked) return blocked;
    const fallbackMode = new URL(request.url).searchParams.get('fallback') === '404' ? 'not-found' : 'default';
    return handleWebsiteIcon(env, iconMatch[1], fallbackMode);
  }

  const publicAttachmentMatch = path.match(/^\/api\/attachments\/([a-f0-9-]+)\/([a-f0-9-]+)$/i);
  if (publicAttachmentMatch && method === 'GET') {
    return handlePublicDownloadAttachment(request, env, publicAttachmentMatch[1], publicAttachmentMatch[2]);
  }

  const publicAttachmentUploadMatch = path.match(/^\/api\/ciphers\/([a-f0-9-]+)\/attachment\/([a-f0-9-]+)$/i);
  if (publicAttachmentUploadMatch && (method === 'POST' || method === 'PUT') && new URL(request.url).searchParams.has('token')) {
    return handlePublicUploadAttachment(request, env, publicAttachmentUploadMatch[1], publicAttachmentUploadMatch[2]);
  }

  const publicSendUploadMatch = path.match(/^\/api\/sends\/([^/]+)\/file\/([^/]+)\/?$/i);
  if (publicSendUploadMatch && (method === 'POST' || method === 'PUT') && new URL(request.url).searchParams.has('token')) {
    return handlePublicUploadSendFile(request, env, publicSendUploadMatch[1], publicSendUploadMatch[2]);
  }

  const sendAccessMatch = path.match(/^\/api\/sends\/access\/([^/]+)$/i);
  if (sendAccessMatch && method === 'POST') {
    const blocked = await enforcePublicRateLimit();
    if (blocked) return blocked;
    return handleAccessSend(request, env, sendAccessMatch[1]);
  }

  if (path === '/api/sends/access' && method === 'POST') {
    const blocked = await enforcePublicRateLimit();
    if (blocked) return blocked;
    return handleAccessSendV2(request, env);
  }

  const sendAccessFileV2Match = path.match(/^\/api\/sends\/access\/file\/([^/]+)\/?$/i);
  if (sendAccessFileV2Match && method === 'POST') {
    const blocked = await enforcePublicRateLimit();
    if (blocked) return blocked;
    return handleAccessSendFileV2(request, env, sendAccessFileV2Match[1]);
  }

  const sendAccessFileMatch = path.match(/^\/api\/sends\/([^/]+)\/access\/file\/([^/]+)\/?$/i);
  if (sendAccessFileMatch && method === 'POST') {
    const blocked = await enforcePublicRateLimit();
    if (blocked) return blocked;
    return handleAccessSendFile(request, env, sendAccessFileMatch[1], sendAccessFileMatch[2]);
  }

  const sendDownloadMatch = path.match(/^\/api\/sends\/([^/]+)\/([^/]+)\/?$/i);
  if (sendDownloadMatch && method === 'GET') {
    return handleDownloadSendFile(request, env, sendDownloadMatch[1], sendDownloadMatch[2]);
  }

  if ((path === '/api/auth-requests' || path === '/api/auth-requests/' || path === '/auth-requests' || path === '/auth-requests/') && method === 'POST') {
    const blocked = await enforcePublicRateLimit('public-sensitive', LIMITS.rateLimit.sensitivePublicRequestsPerMinute);
    if (blocked) return blocked;
    return handleCreateAuthRequest(request, env);
  }

  const authRequestResponseMatch = path.match(/^\/(?:api\/)?auth-requests\/([a-f0-9-]+)\/response$/i);
  if (authRequestResponseMatch && method === 'GET') {
    const blocked = await enforcePublicRateLimit('public-sensitive', LIMITS.rateLimit.sensitivePublicRequestsPerMinute);
    if (blocked) return blocked;
    return handleGetAuthRequestResponse(request, env, authRequestResponseMatch[1]);
  }

  if (path === '/identity/connect/token' && method === 'POST') {
    return handleToken(request, env);
  }

  if (path === '/api/devices/knowndevice' && method === 'GET') {
    const blocked = await enforcePublicRateLimit();
    if (blocked) return jsonResponse(false);
    return handleKnownDevice(request, env);
  }

  const clearDeviceTokenMatch = path.match(/^\/api\/devices\/identifier\/([^/]+)\/clear-token$/i);
  if (clearDeviceTokenMatch && (method === 'PUT' || method === 'POST')) {
    return new Response(null, { status: 200 });
  }

  if ((path === '/identity/connect/revocation' || path === '/identity/connect/revoke') && method === 'POST') {
    const blocked = await enforcePublicRateLimit('public-sensitive', LIMITS.rateLimit.sensitivePublicRequestsPerMinute);
    if (blocked) return blocked;
    return handleRevocation(request, env);
  }

  if (path === '/identity/accounts/prelogin' && method === 'POST') {
    const blocked = await enforcePublicRateLimit('public-sensitive', LIMITS.rateLimit.sensitivePublicRequestsPerMinute);
    if (blocked) return blocked;
    return handlePrelogin(request, env);
  }

  if (path === '/identity/accounts/prelogin/password' && method === 'POST') {
    const blocked = await enforcePublicRateLimit('public-sensitive', LIMITS.rateLimit.sensitivePublicRequestsPerMinute);
    if (blocked) return blocked;
    return handlePrelogin(request, env);
  }

  if (path === '/identity/accounts/webauthn/assertion-options' && method === 'GET') {
    const blocked = await enforcePublicRateLimit('public-sensitive', LIMITS.rateLimit.sensitivePublicRequestsPerMinute);
    if (blocked) return blocked;
    return handleGetAccountPasskeyAssertionOptions(request, env);
  }

  if ((path === '/identity/accounts/recover-2fa' || path === '/api/accounts/recover-2fa') && method === 'POST') {
    const blocked = await enforcePublicRateLimit('public-sensitive', LIMITS.rateLimit.sensitivePublicRequestsPerMinute);
    if (blocked) return blocked;
    return handleRecoverTwoFactor(request, env);
  }

  const publicMailBackedPaths = new Set([
    '/api/accounts/resend-new-device-otp',
    '/accounts/resend-new-device-otp',
    '/api/accounts/register/send-verification-email',
    '/accounts/register/send-verification-email',
    '/identity/accounts/register/send-verification-email',
    '/api/accounts/register/verification-email-clicked',
    '/accounts/register/verification-email-clicked',
    '/identity/accounts/register/verification-email-clicked',
    '/api/accounts/register/finish',
    '/accounts/register/finish',
    '/identity/accounts/register/finish',
    '/api/accounts/verify-email-token',
    '/accounts/verify-email-token',
    '/api/two-factor/send-email-login',
    '/two-factor/send-email-login',
  ]);
  if (publicMailBackedPaths.has(path) && method === 'POST') {
    const blocked = await enforcePublicRateLimit('public-sensitive', LIMITS.rateLimit.sensitivePublicRequestsPerMinute);
    if (blocked) return blocked;
    return unsupportedResponse('Email delivery is not supported by this server.');
  }

  if (path === '/api/accounts/password-hint' && method === 'POST') {
    const blocked = await enforcePublicRateLimit('public-sensitive', LIMITS.rateLimit.sensitivePublicRequestsPerMinute);
    if (blocked) return blocked;
    if (!isSameOriginWriteRequest(request)) {
      return new Response(JSON.stringify({ error: 'Forbidden origin' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return handleGetPasswordHint(request, env);
  }

  /* Config/version are pure build metadata: no D1 anywhere on the path, so
     they skip the per-isolate database-init gate (src/index.ts) and use an
     isolate-local rate limiter instead of the D1-backed one. This removes the
     cold-isolate DB wait from the hot path the Bitwarden clients hit on every
     popup open (see docs/perf/bitwarden-popup.md). The response is immutable
     per server build, so it is served with a short client cache window and an
     ETag: HTTP-cache-honoring clients skip the round-trip entirely within the
     window and get a 304 after it. */
  if ((path === '/config' || path === '/api/config') && method === 'GET') {
    const blocked = enforceIsolateRateLimit(request, LIMITS.rateLimit.publicReadRequestsPerMinute);
    if (blocked) return blocked;
    const origin = new URL(request.url).origin;
    const body = JSON.stringify(buildConfigResponse(origin));
    const etag = `W/"${await sha1Prefix(body, 16)}"`;
    const ifNoneMatch = request.headers.get('If-None-Match');
    if (ifNoneMatch && ifNoneMatch.split(',').some((candidate) => candidate.trim() === etag)) {
      return new Response(null, {
        status: 304,
        headers: { ETag: etag, 'Cache-Control': 'public, max-age=60' },
      });
    }
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=60',
        ETag: etag,
      },
    });
  }

  if (path === '/api/version' && method === 'GET') {
    const blocked = enforceIsolateRateLimit(request, LIMITS.rateLimit.publicReadRequestsPerMinute);
    if (blocked) return blocked;
    return jsonResponse(LIMITS.compatibility.bitwardenServerVersion, 200, {
      'Cache-Control': 'public, max-age=300',
    });
  }

  if (path === '/api/accounts/register' && method === 'POST') {
    const blocked = await enforcePublicRateLimit('register', LIMITS.rateLimit.registerRequestsPerMinute);
    if (blocked) return blocked;
    if (!isSameOriginWriteRequest(request)) {
      return new Response(JSON.stringify({ error: 'Forbidden origin' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return handleRegister(request, env);
  }

  if (path === '/notifications/hub/negotiate' && method === 'POST') {
    return handleNotificationsNegotiate(request, env);
  }

  if (path === '/notifications/hub' && method === 'GET') {
    return handleNotificationsHub(request, env);
  }

  if (path === '/notifications/anonymous-hub' && method === 'GET') {
    const blocked = await enforcePublicRateLimit('public-sensitive', LIMITS.rateLimit.sensitivePublicRequestsPerMinute);
    if (blocked) return blocked;
    return handleAnonymousNotificationsHub(request, env);
  }
  return null;
}
