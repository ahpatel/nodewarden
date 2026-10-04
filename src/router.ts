import { Env } from './types';
import { AuthService } from './services/auth';
import { RateLimitService, getClientIdentifier } from './services/ratelimit';
import { handleCors, errorResponse, markServerTimingVerified } from './utils/response';
import { LIMITS } from './config/limits';
import { handleAuthenticatedRoute } from './router-authenticated';
import { handlePublicRoute } from './router-public';

function jwtSecretUnsafeReason(env: Env): 'missing' | 'too_short' | null {
  const secret = (env.JWT_SECRET || '').trim();
  if (!secret) return 'missing';
  if (secret.length < LIMITS.auth.jwtSecretMinLength) return 'too_short';
  return null;
}

/* Operator warning for an unsafe JWT secret, logged once per isolate. The
   public web-bootstrap no longer classifies the secret for unauthenticated
   callers (that was an instance-security disclosure), so startup/server
   logs are where the operator learns about it. */
let jwtSecretWarningLogged = false;
function warnOnUnsafeJwtSecret(reason: 'missing' | 'too_short'): void {
  if (jwtSecretWarningLogged) return;
  jwtSecretWarningLogged = true;
  console.error(
    reason === 'missing'
      ? 'JWT_SECRET is not set. Token signing is unsafe and most endpoints are disabled. Set a strong JWT_SECRET in the Worker settings.'
      : `JWT_SECRET is shorter than ${LIMITS.auth.jwtSecretMinLength} characters. Token signing is brute-forceable. Set a stronger JWT_SECRET in the Worker settings.`
  );
}

function canServeWithUnsafeJwtSecret(path: string, method: string): boolean {
  if (method === 'OPTIONS') return true;
  if (method === 'GET' && (path === '/api/web-bootstrap' || path === '/web-bootstrap')) return true;
  if (method === 'GET' && (path === '/config' || path === '/api/config' || path === '/api/version')) return true;
  if (method === 'GET' && path === '/.well-known/appspecific/com.chrome.devtools.json') return true;
  if (method === 'GET' && path === '/fill-assist/manifest.json') return true;
  if (method === 'GET' && /^\/fill-assist\/[^/]+$/i.test(path)) return true;
  if (method === 'GET' && (path === '/v1/assetlinks:check' || path === '/api/v1/assetlinks:check')) return true;
  if (method === 'GET' && /^\/icons\/[^/]+\/icon\.png$/i.test(path)) return true;
  return false;
}

function isBulkImportPath(path: string, method: string): boolean {
  if (method !== 'POST') return false;
  if (path === '/api/ciphers/import') return true;
  if (/^\/api\/ciphers\/[a-f0-9-]+\/attachment\/v2$/i.test(path)) return true;
  if (/^\/api\/ciphers\/[a-f0-9-]+\/attachment\/[a-f0-9-]+$/i.test(path)) return true;
  return false;
}

const BODY_LIMIT_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function isLargeUploadPath(path: string): boolean {
  return (
    /^\/api\/ciphers\/[a-f0-9-]+\/attachment\/[a-f0-9-]+$/i.test(path) ||
    /^\/api\/sends\/[a-f0-9-]+\/file\/[a-f0-9-]+$/i.test(path) ||
    path === '/api/admin/backup/import'
  );
}

async function enforceRequestBodyLimit(
  request: Request,
  path: string,
  method: string
): Promise<Request | Response> {
  if (!BODY_LIMIT_METHODS.has(method) || !request.body) {
    return request;
  }

  // Large uploads skip the byte cap below; require an explicit length so a
  // chunked multipart body cannot be fully buffered before any size check.
  // This must run before the large-upload early return or it never executes.
  if (isLargeUploadPath(path)) {
    if (!request.headers.get('Content-Length')) {
      return errorResponse('Content-Length required', 411);
    }
    return request;
  }

  const contentLengthRaw = request.headers.get('Content-Length');
  if (contentLengthRaw) {
    const contentLength = Number(contentLengthRaw);
    if (Number.isFinite(contentLength) && contentLength > LIMITS.request.maxBodyBytes) {
      return errorResponse('Request body too large', 413);
    }
    if (Number.isFinite(contentLength) && contentLength >= 0) {
      return request;
    }
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > LIMITS.request.maxBodyBytes) {
      try {
        await reader.cancel();
      } catch {
        // Ignore cancellation races after the oversized body is rejected.
      }
      return errorResponse('Request body too large', 413);
    }
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body,
    redirect: request.redirect,
  });
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const clientId = getClientIdentifier(request);

  async function enforcePublicRateLimit(
    category: string = 'public',
    maxRequests: number = LIMITS.rateLimit.publicRequestsPerMinute
  ): Promise<Response | null> {
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

    const rateLimit = new RateLimitService(env.DB);
    const shouldUseStrictBudget = category === 'public-sensitive' || category === 'register' || category === 'hub-negotiate';
    const check = shouldUseStrictBudget
      ? await rateLimit.consumeStrictBudget(`${clientId}:${category}`, maxRequests)
      : await rateLimit.consumeBudget(`${clientId}:${category}`, maxRequests);
    if (check.allowed) return null;

    return new Response(
      JSON.stringify({
        error: 'Too many requests',
        error_description: `Rate limit exceeded. Try again in ${check.retryAfterSeconds} seconds.`,
      }),
      {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': String(check.retryAfterSeconds || 60),
          'X-RateLimit-Remaining': '0',
        },
      }
    );
  }

  if (method === 'OPTIONS') {
    return handleCors(request, env);
  }

  try {
    const bodyLimitResult = await enforceRequestBodyLimit(request, path, method);
    if (bodyLimitResult instanceof Response) {
      return bodyLimitResult;
    }
    request = bodyLimitResult;

    const secretIssue = jwtSecretUnsafeReason(env);
    if (secretIssue) {
      warnOnUnsafeJwtSecret(secretIssue);
      if (!canServeWithUnsafeJwtSecret(path, method)) {
        return errorResponse('Server configuration error: JWT_SECRET is not set or too weak', 500);
      }
    }

    const publicResponse = await handlePublicRoute(request, env, path, method, enforcePublicRateLimit);
    if (publicResponse) return publicResponse;

    const auth = new AuthService(env);
    const authHeader = request.headers.get('Authorization');
    const verified = await auth.verifyAccessTokenWithUser(authHeader);
    if (!verified) {
      return errorResponse('Unauthorized', 401);
    }
    const { payload, user: currentUser } = verified;

    // From here on the request's credentials are verified: every response
    // this request produces may carry Server-Timing, because handler
    // duration now describes the requester's own session (see index.ts).
    const respondVerified = async (): Promise<Response> => {
    const actingDeviceId = String(payload.did || '').trim();
    // Always rebuild the headers so a client-supplied acting-device header can
    // never survive when the token carries no device claim.
    const nextHeaders = new Headers(request.headers);
    nextHeaders.delete('X-NodeWarden-Acting-Device-Id');
    if (actingDeviceId) {
      nextHeaders.set('X-NodeWarden-Acting-Device-Id', actingDeviceId);
    }
    request = new Request(request, { headers: nextHeaders });

    const userId = payload.sub;
    if (currentUser.status !== 'active') {
      return errorResponse('Account is disabled', 403);
    }

    const rateLimit = new RateLimitService(env.DB);
    // Bulk import / attachment uploads write large payloads; they get their own
    // generous per-user budget instead of the old forgeable header bypass.
    const importBudget = isBulkImportPath(path, method)
      ? await rateLimit.consumeBudget(`${userId}:import`, LIMITS.rateLimit.importRequestsPerMinute)
      : null;
    if (importBudget && !importBudget.allowed) {
      return new Response(
        JSON.stringify({
          error: 'Too many requests',
          error_description: `Rate limit exceeded. Try again in ${importBudget.retryAfterSeconds} seconds.`,
        }),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': String(importBudget.retryAfterSeconds || 60),
            'X-RateLimit-Remaining': '0',
          },
        }
      );
    }
    const rateLimitCheck = await rateLimit.consumeBudget(`${userId}:api`, LIMITS.rateLimit.apiRequestsPerMinute);
    if (!rateLimitCheck.allowed) {
      return new Response(
        JSON.stringify({
          error: 'Too many requests',
          error_description: `Rate limit exceeded. Try again in ${rateLimitCheck.retryAfterSeconds} seconds.`,
        }),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': String(rateLimitCheck.retryAfterSeconds || 60),
            'X-RateLimit-Remaining': '0',
          },
        }
      );
    }

    // Full-vault responses are megabytes each; brake them separately from the
    // generic API budget so one session cannot sustain mass vault downloads.
    const isVaultDump =
      (path === '/api/sync' && method === 'GET') ||
      (path === '/api/ciphers' && method === 'GET');
    if (isVaultDump) {
      const vaultDumpCheck = await rateLimit.consumeBudget(
        `${userId}:vault-dump`,
        LIMITS.rateLimit.vaultDumpRequestsPerMinute
      );
      if (!vaultDumpCheck.allowed) {
        return new Response(
          JSON.stringify({
            error: 'Too many requests',
            error_description: `Vault sync rate limit exceeded. Try again in ${vaultDumpCheck.retryAfterSeconds} seconds.`,
          }),
          {
            status: 429,
            headers: {
              'Content-Type': 'application/json',
              'Retry-After': String(vaultDumpCheck.retryAfterSeconds || 60),
              'X-RateLimit-Remaining': '0',
            },
          }
        );
      }
    }

    const authenticatedResponse = await handleAuthenticatedRoute(request, env, userId, currentUser, path, method);
    if (authenticatedResponse) return authenticatedResponse;

    return errorResponse('Not found', 404);
    }; // respondVerified

    return markServerTimingVerified(await respondVerified());
  } catch (error) {
    console.error('Request error:', error);
    return errorResponse('Internal server error', 500);
  }
}
