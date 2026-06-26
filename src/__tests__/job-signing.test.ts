import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac, createHash } from 'crypto';
import { deriveJobSigningSecret, verifyJobSignature } from '../agent/job-signing';
import type { DesktopJob, JobSignature } from '../agent/types';

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

function signJob(job: DesktopJob, secret: string, signedAt: string, nonce: string): string {
  return createHmac('sha256', secret)
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

describe('deriveJobSigningSecret', () => {
  it('derives a sha256-prefixed secret from device token', () => {
    const secret = deriveJobSigningSecret('test-token-123');
    expect(secret).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('produces deterministic output', () => {
    const a = deriveJobSigningSecret('my-token');
    const b = deriveJobSigningSecret('my-token');
    expect(a).toBe(b);
  });

  it('produces different output for different tokens', () => {
    const a = deriveJobSigningSecret('token-a');
    const b = deriveJobSigningSecret('token-b');
    expect(a).not.toBe(b);
  });
});

describe('verifyJobSignature', () => {
  const deviceToken = 'test-device-token';
  const signingSecret = deriveJobSigningSecret(deviceToken);

  const baseJob: DesktopJob = {
    jobId: 'job-1',
    tool: 'system.info',
    ownerUserId: 'user-1',
    targetDeviceId: 'device-1',
    chatId: 'chat-1',
    args: {},
  };

  function makeSignedJob(overrides?: Partial<DesktopJob>): DesktopJob {
    const job = { ...baseJob, ...overrides };
    const signedAt = new Date().toISOString();
    const nonce = 'test-nonce-' + Math.random().toString(36).slice(2);
    const value = signJob(job, signingSecret, signedAt, nonce);

    return {
      ...job,
      signature: {
        algorithm: 'hmac-sha256' as const,
        signedAt,
        nonce,
        value,
      },
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-22T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('accepts a valid signature', () => {
    const job = makeSignedJob();
    expect(verifyJobSignature(job, signingSecret)).toEqual({ ok: true });
  });

  it('passes when no signing secret is configured', () => {
    expect(verifyJobSignature(baseJob, undefined)).toEqual({ ok: true });
  });

  it('rejects job without signature when secret is set', () => {
    const result = verifyJobSignature(baseJob, signingSecret);
    expect(result.ok).toBe(false);
  });

  it('rejects tampered args', () => {
    const job = makeSignedJob();
    job.args = { tampered: true };
    const result = verifyJobSignature(job, signingSecret);
    expect(result.ok).toBe(false);
  });

  it('rejects tampered tool name', () => {
    const job = makeSignedJob();
    job.tool = 'shell.run';
    const result = verifyJobSignature(job, signingSecret);
    expect(result.ok).toBe(false);
  });

  it('rejects wrong signing secret', () => {
    const job = makeSignedJob();
    const wrongSecret = deriveJobSigningSecret('wrong-token');
    const result = verifyJobSignature(job, wrongSecret);
    expect(result.ok).toBe(false);
  });

  it('rejects expired signature', () => {
    const job = makeSignedJob();
    vi.advanceTimersByTime(6 * 60 * 1000);
    const result = verifyJobSignature(job, signingSecret);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('expired');
  });

  it('rejects future signature', () => {
    const futureDate = new Date(Date.now() + 2 * 60 * 1000).toISOString();
    const nonce = 'future-nonce';
    const value = signJob(baseJob, signingSecret, futureDate, nonce);
    const job: DesktopJob = {
      ...baseJob,
      signature: { algorithm: 'hmac-sha256', signedAt: futureDate, nonce, value },
    };
    const result = verifyJobSignature(job, signingSecret);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('future');
  });

  it('rejects malformed signature value', () => {
    const job: DesktopJob = {
      ...baseJob,
      signature: {
        algorithm: 'hmac-sha256',
        signedAt: new Date().toISOString(),
        nonce: 'test',
        value: 'not-hex',
      },
    };
    const result = verifyJobSignature(job, signingSecret);
    expect(result.ok).toBe(false);
  });
});
