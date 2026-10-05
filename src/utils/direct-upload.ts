import { LIMITS } from '../config/limits';
import { Env } from '../types';
import { errorResponse } from './response';

export interface DirectUploadPayload {
  body: ReadableStream;
  contentType: string;
  size: number;
}

/** Raised while streaming an upload whose bytes exceed the accepted size. */
export class UploadedPayloadTooLargeError extends Error {}


interface ParseDirectUploadOptions {
  expectedSize?: number | null;
  expectedFileName?: string | null;
  maxFileSize: number;
  tooLargeMessage: string;
  missingBodyMessage?: string;
  contentLengthRequiredMessage?: string;
  sizeMismatchMessage?: string;
  fileNameMismatchMessage?: string;
}

const MULTIPART_FORMDATA_OVERHEAD_BYTES = 256 * 1024;

export function buildDirectUploadUrl(request: Request, path: string, token: string): string {
  const version = '2023-11-03';
  const expiresAt = '2099-12-31T23:59:59Z';
  const origin = new URL(request.url).origin;
  return `${origin}${path}?sv=${encodeURIComponent(version)}&se=${encodeURIComponent(expiresAt)}&token=${encodeURIComponent(token)}`;
}

export function getSafeJwtSecret(env: Env): string | null {
  const secret = (env.JWT_SECRET || '').trim();
  if (!secret || secret.length < LIMITS.auth.jwtSecretMinLength) {
    return null;
  }
  return secret;
}

export function getMultipartRequestMaxBytes(maxFileSize: number): number {
  return maxFileSize + MULTIPART_FORMDATA_OVERHEAD_BYTES;
}

function parseContentLength(request: Request): number | null {
  const raw = request.headers.get('content-length');
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

/* Count the streamed upload bytes and fail as soon as they exceed the
   accepted size. The header-based checks above are enforced before streaming,
   but they depend on a Content-Length header being present and honest — when
   it is missing the declared size was trusted, and a lying header paired with
   a longer body streams past every header check
   (audit lead cand:upload-declared-size-unbounded). R2/S3 puts require a
   known-length stream, so the body is pumped through a FixedLengthStream
   sized to the accepted byte count: the pump enforces the cap with an
   identifiable error, the FixedLengthStream enforces the exact length for the
   blob store, and an oversize or short body fails the upload before anything
   is stored. Bytes within the cap stream through untouched. */
function capBodyBytes(
  source: ReadableStream<Uint8Array>,
  expectedBytes: number,
  tooLargeMessage: string
): ReadableStream<Uint8Array> {
  const fixed = new FixedLengthStream(expectedBytes);
  void (async () => {
    const reader = source.getReader();
    const writer = fixed.writable.getWriter();
    try {
      let count = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        count += value.byteLength;
        if (count > expectedBytes) {
          throw new UploadedPayloadTooLargeError(tooLargeMessage);
        }
        await writer.write(value);
      }
      await writer.close();
    } catch (error) {
      await reader.cancel().catch(() => {});
      await writer.abort(error).catch(() => {});
    }
  })();
  return fixed.readable as ReadableStream<Uint8Array>;
}

export async function parseDirectUploadPayload(
  request: Request,
  options: ParseDirectUploadOptions
): Promise<DirectUploadPayload | Response> {
  const {
    expectedSize = null,
    expectedFileName = null,
    maxFileSize,
    tooLargeMessage,
    missingBodyMessage = 'No file uploaded',
    contentLengthRequiredMessage = 'Content-Length is required for direct uploads',
    sizeMismatchMessage,
    fileNameMismatchMessage,
  } = options;
  const contentType = request.headers.get('content-type') || '';

  if (contentType.includes('multipart/form-data')) {
    const declaredSize = parseContentLength(request);
    if (declaredSize !== null && declaredSize > getMultipartRequestMaxBytes(maxFileSize)) {
      return errorResponse(tooLargeMessage, 413);
    }
    const formData = await request.formData();
    const file = formData.get('data') as File | null;
    if (!file) {
      return errorResponse(missingBodyMessage, 400);
    }
    if (file.size > maxFileSize) {
      return errorResponse(tooLargeMessage, 413);
    }
    if (expectedFileName && file.name !== expectedFileName) {
      return errorResponse(fileNameMismatchMessage || 'File name does not match.', 400);
    }
    if (expectedSize !== null && expectedSize !== undefined && file.size !== expectedSize) {
      return errorResponse(sizeMismatchMessage || 'File size does not match.', 400);
    }
    return {
      body: file.stream(),
      contentType: file.type || 'application/octet-stream',
      size: file.size,
    };
  }

  if (!request.body) {
    return errorResponse(missingBodyMessage, 400);
  }

  const declaredSize = parseContentLength(request);
  const uploadSize = declaredSize ?? (expectedSize && expectedSize > 0 ? expectedSize : null);
  if (uploadSize === null) {
    return errorResponse(contentLengthRequiredMessage, 400);
  }
  if (uploadSize > maxFileSize) {
    return errorResponse(tooLargeMessage, 413);
  }
  if (expectedSize !== null && expectedSize !== undefined && uploadSize !== expectedSize) {
    return errorResponse(sizeMismatchMessage || 'File size does not match.', 400);
  }

  return {
    body: capBodyBytes(request.body, uploadSize, tooLargeMessage),
    contentType: contentType || 'application/octet-stream',
    size: uploadSize,
  };
}
