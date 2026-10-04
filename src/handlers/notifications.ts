import { AuthService } from '../services/auth';
import { StorageService } from '../services/storage';
import { isAuthRequestExpired } from '../services/storage-auth-request-repo';
import type { Env, JWTPayload } from '../types';
import { errorResponse, jsonResponse } from '../utils/response';
import { generateUUID } from '../utils/uuid';
import {
  createWebSocketConnectionToken,
  verifyWebSocketConnectionToken,
} from '../utils/websocket-connection-token';

const WEBSOCKET_CONNECTION_TOKEN_TTL_MS = 60 * 1000;

function extractAccessToken(request: Request): string | null {
  const authHeader = String(request.headers.get('Authorization') || '').trim();
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

async function authenticateAccessToken(request: Request, env: Env): Promise<JWTPayload | null> {
  const accessToken = extractAccessToken(request);
  if (!accessToken) return null;

  const auth = new AuthService(env);
  return auth.verifyAccessToken(`Bearer ${accessToken}`);
}

async function issueWebSocketConnectionToken(payload: JWTPayload, env: Env): Promise<string> {
  const expiresAt = Date.now() + WEBSOCKET_CONNECTION_TOKEN_TTL_MS;
  const token = await createWebSocketConnectionToken(payload.sub, expiresAt, env.JWT_SECRET);
  const id = env.NOTIFICATIONS_HUB.idFromName(payload.sub);
  const stub = env.NOTIFICATIONS_HUB.get(id);
  const response = await stub.fetch('https://notifications/internal/ws-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token,
      userId: payload.sub,
      deviceIdentifier: payload.did || null,
      expiresAt,
    }),
  });
  if (!response.ok) throw new Error('Failed to issue websocket connection token');
  return token;
}

async function consumeWebSocketConnectionToken(request: Request, env: Env): Promise<JWTPayload | null> {
  const token = String(new URL(request.url).searchParams.get('id') || '').trim();
  const claims = await verifyWebSocketConnectionToken(token, env.JWT_SECRET);
  if (!claims) return null;

  // Verify the signed routing claim before selecting a Durable Object. Otherwise an
  // attacker could activate arbitrary object names with forged token prefixes.
  const id = env.NOTIFICATIONS_HUB.idFromName(claims.userId);
  const stub = env.NOTIFICATIONS_HUB.get(id);
  const response = await stub.fetch('https://notifications/internal/ws-token/consume', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  if (!response.ok) return null;

  const connection = (await response.json().catch(() => null)) as {
    userId?: string;
    deviceIdentifier?: string | null;
  } | null;
  if (connection?.userId !== claims.userId) return null;

  return {
    sub: claims.userId,
    did: String(connection.deviceIdentifier || '').trim() || undefined,
  } as JWTPayload;
}

async function authenticateNotificationsHub(request: Request, env: Env): Promise<JWTPayload | null> {
  if (request.headers.has('Authorization')) {
    return authenticateAccessToken(request, env);
  }

  // Preferred path: the one-time, 60-second connection ticket issued by
  // /notifications/hub/negotiate (used by the web vault).
  const viaTicket = await consumeWebSocketConnectionToken(request, env);
  if (viaTicket) return viaTicket;

  // Fallback for official clients: SignalR cannot set headers on the WebSocket
  // upgrade, so the desktop/mobile/extension apps can only authenticate with
  // access_token in the query string. Rejecting it left every official client
  // without push notifications, driving a sync-polling fallback storm (10GB
  // observed on 2026-10-03). This is the ONLY place a URL-borne token is
  // accepted, the hub carries no vault data (sync pings only), and the token
  // is the standard 2h access JWT verified with the same full checks as the
  // Authorization header path. Update the comment if this scoping changes.
  const urlToken = String(new URL(request.url).searchParams.get('access_token') || '').trim();
  if (!urlToken) return null;
  const auth = new AuthService(env);
  return auth.verifyAccessToken(`Bearer ${urlToken}`);
}

export async function handleNotificationsNegotiate(request: Request, env: Env): Promise<Response> {
  const payload = await authenticateAccessToken(request, env);
  if (!payload?.sub) return errorResponse('Unauthorized', 401);

  const connectionToken = await issueWebSocketConnectionToken(payload, env);
  return jsonResponse(
    {
      connectionId: generateUUID(),
      connectionToken,
      negotiateVersion: 1,
      availableTransports: [
        {
          transport: 'WebSockets',
          transferFormats: ['Text', 'Binary'],
        },
      ],
    },
    200,
    { 'Cache-Control': 'no-store' }
  );
}

export async function handleNotificationsHub(request: Request, env: Env): Promise<Response> {
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return errorResponse('Expected websocket', 426);
  }
  const payload = await authenticateNotificationsHub(request, env);
  if (!payload?.sub) return errorResponse('Unauthorized', 401);

  const userId = payload.sub;
  const id = env.NOTIFICATIONS_HUB.idFromName(userId);
  const stub = env.NOTIFICATIONS_HUB.get(id);
  const forwardedUrl = new URL(request.url);
  forwardedUrl.searchParams.set('nw_uid', userId);
  if (payload.did) {
    forwardedUrl.searchParams.set('nw_did', payload.did);
  }
  return stub.fetch(new Request(forwardedUrl.toString(), request));
}

export async function handleAnonymousNotificationsHub(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const authRequestId = String(url.searchParams.get('Token') || url.searchParams.get('token') || '').trim();
  if (!authRequestId) return errorResponse('Token is required', 400);
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return errorResponse('Expected websocket', 426);
  }

  const storage = new StorageService(env.DB);
  const authRequest = await storage.getAuthRequestById(authRequestId);
  if (!authRequest || isAuthRequestExpired(authRequest)) {
    return errorResponse('Not found', 404);
  }

  const id = env.NOTIFICATIONS_HUB.idFromName(authRequestId);
  const stub = env.NOTIFICATIONS_HUB.get(id);
  const forwardedUrl = new URL(request.url);
  forwardedUrl.searchParams.set('nw_auth_request_id', authRequestId);
  return stub.fetch(new Request(forwardedUrl.toString(), request));
}
