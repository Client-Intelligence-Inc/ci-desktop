import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { DesktopJob, JobSignature } from './types';

const MAX_SIGNATURE_AGE_MS = 5 * 60 * 1000;
const MAX_SIGNATURE_FUTURE_SKEW_MS = 60 * 1000;

export function deriveJobSigningSecret(deviceToken: string): string {
  return `sha256:${createHash('sha256').update(String(deviceToken)).digest('hex')}`;
}

export function verifyJobSignature(
  job: DesktopJob,
  signingSecret?: string,
): { ok: true } | { ok: false; error: string } {
  if (!signingSecret) return { ok: true };

  const signature = job.signature;
  if (!signature) {
    return { ok: false, error: 'job.start.signature is required' };
  }

  if (!isValidSignatureEnvelope(signature)) {
    return { ok: false, error: 'job.start.signature is malformed' };
  }

  const freshness = validateSignatureFreshness(signature.signedAt);
  if (!freshness.ok) {
    return freshness;
  }

  const expected = signJobPayload(job, signingSecret, signature.signedAt, signature.nonce);
  const provided = Buffer.from(signature.value, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');

  if (provided.length !== expectedBuffer.length || !timingSafeEqual(provided, expectedBuffer)) {
    return { ok: false, error: 'job.start.signature verification failed' };
  }

  return { ok: true };
}

function validateSignatureFreshness(signedAt: string): { ok: true } | { ok: false; error: string } {
  const signedAtMs = Date.parse(signedAt);
  if (!Number.isFinite(signedAtMs)) {
    return { ok: false, error: 'job.start.signature.signedAt must be a valid timestamp' };
  }

  const ageMs = Date.now() - signedAtMs;
  if (ageMs > MAX_SIGNATURE_AGE_MS) {
    return { ok: false, error: 'job.start.signature has expired' };
  }
  if (ageMs < -MAX_SIGNATURE_FUTURE_SKEW_MS) {
    return { ok: false, error: 'job.start.signature is from the future' };
  }

  return { ok: true };
}

function isValidSignatureEnvelope(signature: JobSignature): boolean {
  return (
    signature.algorithm === 'hmac-sha256' &&
    typeof signature.signedAt === 'string' &&
    signature.signedAt.length > 0 &&
    typeof signature.nonce === 'string' &&
    signature.nonce.length > 0 &&
    typeof signature.value === 'string' &&
    /^[a-f0-9]{64}$/i.test(signature.value)
  );
}

function signJobPayload(
  job: DesktopJob,
  signingSecret: string,
  signedAt: string,
  nonce: string,
): string {
  return createHmac('sha256', signingSecret)
    .update(stableStringify({
      jobId: job.jobId,
      tool: job.tool,
      ownerUserId: job.ownerUserId,
      targetDeviceId: job.targetDeviceId,
      chatId: job.chatId,
      args: job.args || {},
      policy: job.policy || {},
      signedAt,
      nonce,
    }))
    .digest('hex');
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => (
      `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`
    )).join(',')}}`;
  }

  return JSON.stringify(value);
}
