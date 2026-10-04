import { Env } from './types';
import { NotificationsHub } from './durable/notifications-hub';
import { BackupTransferRunner } from './durable/backup-transfer-runner';
import { handleRequest } from './router';
import { StorageService } from './services/storage';
import { applyCors, jsonResponse, isServerTimingVerified } from './utils/response';
import { runScheduledBackupIfDue } from './handlers/backup';
import {
  isBackendRequestPath,
  isWebVaultHidden,
  webVaultNotFoundResponse,
} from './web-vault-visibility';

let dbInitialized = false;
let dbInitError: string | null = null;
let dbInitPromise: Promise<void> | null = null;

/* Endpoints served without touching D1 anywhere on their path (see
   router-public.ts). They skip the per-isolate database-init gate and use the
   isolate-local rate limiter. */
const DATABASE_FREE_PATHS = new Set(['/config', '/api/config', '/api/version']);

/* Server-Timing attribution: lets clients (and production probes) split every
   backend response into the per-isolate database-init wait and the request
   handler itself. The db_init leg drops to ~0 on warm isolates and shows the
   true cost of cold ones — the measurable signal behind the popup-latency
   work in docs/perf/bitwarden-popup.md.

   SECURITY SCOPE: the header is a precision timing instrument. Unauthenticated
   existence-adjacent endpoints (prelogin, send access, …) must not advertise
   handler durations — a timing oracle there defeats their anti-enumeration
   design. It is therefore emitted ONLY for (a) the database-free metadata
   paths (static build responses, no secrets, no per-user work) or (b)
   requests whose credentials the router actually verified — router.ts stamps
   the response after JWT validation, so handler timing describes the
   requester's own session. The mere presence of an Authorization or
   web-session header never enables emission: an attacker can set any header,
   and on some endpoints handler duration tracks account state (e.g. the
   audit-write asymmetry on failed logins). */
function withServerTiming(response: Response, timing: string): Response {
  // WebSocket upgrade responses must be returned untouched.
  const webSocket = (response as Response & { webSocket?: unknown }).webSocket;
  if (response.status === 101 || webSocket) return response;
  try {
    const existing = response.headers.get('Server-Timing');
    response.headers.set('Server-Timing', existing ? `${existing}, ${timing}` : timing);
    return response;
  } catch {
    // Immutable headers (upstream passthrough): re-wrap preserving the stream.
    const headers = new Headers(response.headers);
    const existing = headers.get('Server-Timing');
    headers.set('Server-Timing', existing ? `${existing}, ${timing}` : timing);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}

function normalizeRequestUrl(request: Request): Request {
  const url = new URL(request.url);
  const normalizedPathname = url.pathname.length <= 1 ? url.pathname : url.pathname.replace(/\/+$/, '');
  if (normalizedPathname === url.pathname) return request;

  url.pathname = normalizedPathname;
  return new Request(url.toString(), request);
}

function addSearchIndexHeaders(request: Request, response: Response): Response {
  const url = new URL(request.url);
  const contentType = String(response.headers.get('Content-Type') || '').toLowerCase();
  const shouldNoIndex =
    url.pathname === '/robots.txt' ||
    contentType.includes('text/html');

  if (!shouldNoIndex) return response;

  const headers = new Headers(response.headers);
  headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function maybeServeAsset(request: Request, env: Env): Promise<Response | null> {
  if (!env.ASSETS) return null;
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  const url = new URL(request.url);
  if (isBackendRequestPath(url.pathname)) return null;

  const response = await env.ASSETS.fetch(request);
  return addSearchIndexHeaders(request, response);
}

async function ensureDatabaseInitialized(env: Env): Promise<void> {
  if (dbInitialized) return;

  if (!dbInitPromise) {
    dbInitPromise = (async () => {
      const storage = new StorageService(env.DB);
      await storage.initializeDatabase();
      dbInitialized = true;
      dbInitError = null;
    })()
      .catch((error: unknown) => {
        console.error('Failed to initialize database:', error);
        dbInitError = error instanceof Error ? error.message : 'Unknown database initialization error';
      })
      .finally(() => {
        dbInitPromise = null;
      });
  }

  await dbInitPromise;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    void ctx;
    const normalizedRequest = normalizeRequestUrl(request);
    const requestPath = new URL(normalizedRequest.url).pathname;

    if (isWebVaultHidden(env) && !isBackendRequestPath(requestPath)) {
      return webVaultNotFoundResponse(normalizedRequest);
    }

    const assetResponse = await maybeServeAsset(normalizedRequest, env);
    if (assetResponse) {
      return applyCors(normalizedRequest, assetResponse, env);
    }

    const timingStart = performance.now();
    /* Database-free endpoints (config/version build metadata) skip the
       per-isolate init gate entirely: nothing on their path touches D1, so
       cold isolates must not charge the Bitwarden clients' hot path for it. */
    const databaseFree = DATABASE_FREE_PATHS.has(requestPath);
    if (!databaseFree) {
      await ensureDatabaseInitialized(env);
    }
    const dbInitMs = performance.now() - timingStart;
    if (dbInitError) {
      // Log full error server-side, return generic message to client.
      console.error('DB init error (not forwarded to client):', dbInitError);
      const resp = jsonResponse(
        {
          error: 'Database not initialized',
          error_description: 'Database initialization failed. Check server logs for details.',
          ErrorModel: {
            Message: 'Service temporarily unavailable',
            Object: 'error',
          },
        },
        500
      );
      return applyCors(normalizedRequest, withServerTiming(resp, `db_init;dur=${dbInitMs.toFixed(1)}`), env);
    }

    const handlerStart = performance.now();
    const resp = await handleRequest(normalizedRequest, env);
    const handlerMs = performance.now() - handlerStart;
    const dbInitEntry = databaseFree
      ? `db_init;dur=0;desc="database-free path"`
      : `db_init;dur=${dbInitMs.toFixed(1)}`;
    const timingAllowed = databaseFree || isServerTimingVerified(resp);
    if (!timingAllowed) {
      return applyCors(normalizedRequest, resp, env);
    }
    return applyCors(
      normalizedRequest,
      withServerTiming(resp, `${dbInitEntry}, handler;dur=${handlerMs.toFixed(1)}`),
      env
    );
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    void controller;
    await ensureDatabaseInitialized(env);
    if (dbInitError) {
      console.error('Skipping scheduled backup because DB init failed:', dbInitError);
      return;
    }
    ctx.waitUntil(runScheduledBackupIfDue(env).catch((error) => {
      console.error('Scheduled backup failed:', error);
    }));
  },
};

export { NotificationsHub };
export { BackupTransferRunner };
