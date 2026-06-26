import { describe, it, expect } from 'vitest';
import {
  getURLHost,
  parseTrustedHosts,
  isLocalDevOrigin,
  isTrustedAppURL,
  isAllowedGatewayURL,
} from '../agent/origin';

describe('getURLHost', () => {
  it('extracts host from HTTPS URL', () => {
    expect(getURLHost('https://clientintelligence.ai')).toBe('clientintelligence.ai');
  });

  it('extracts host with www prefix', () => {
    expect(getURLHost('https://www.clientintelligence.ai')).toBe('www.clientintelligence.ai');
  });

  it('includes port when present', () => {
    expect(getURLHost('http://localhost:3000')).toBe('localhost:3000');
  });

  it('returns undefined for invalid URL', () => {
    expect(getURLHost('not-a-url')).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(getURLHost('')).toBeUndefined();
  });
});

describe('parseTrustedHosts', () => {
  it('parses comma-separated hosts', () => {
    expect(parseTrustedHosts('a.com,b.com,c.com')).toEqual(['a.com', 'b.com', 'c.com']);
  });

  it('trims whitespace', () => {
    expect(parseTrustedHosts(' a.com , b.com ')).toEqual(['a.com', 'b.com']);
  });

  it('filters empty entries', () => {
    expect(parseTrustedHosts('a.com,,b.com,')).toEqual(['a.com', 'b.com']);
  });

  it('returns empty array for undefined', () => {
    expect(parseTrustedHosts(undefined)).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    expect(parseTrustedHosts('')).toEqual([]);
  });
});

describe('isLocalDevOrigin', () => {
  it('accepts localhost HTTP', () => {
    expect(isLocalDevOrigin(new URL('http://localhost:3000'))).toBe(true);
  });

  it('accepts 127.0.0.1 HTTP', () => {
    expect(isLocalDevOrigin(new URL('http://127.0.0.1:3000'))).toBe(true);
  });

  it('accepts IPv6 loopback HTTP', () => {
    expect(isLocalDevOrigin(new URL('http://[::1]:3000'))).toBe(true);
  });

  it('rejects HTTPS localhost', () => {
    expect(isLocalDevOrigin(new URL('https://localhost:3000'))).toBe(false);
  });

  it('rejects external HTTP', () => {
    expect(isLocalDevOrigin(new URL('http://example.com'))).toBe(false);
  });
});

describe('isTrustedAppURL', () => {
  const trustedHosts = new Set(['clientintelligence.ai', 'www.clientintelligence.ai']);

  it('accepts HTTPS trusted host', () => {
    expect(isTrustedAppURL('https://clientintelligence.ai', trustedHosts)).toBe(true);
  });

  it('accepts HTTPS trusted host with path', () => {
    expect(isTrustedAppURL('https://clientintelligence.ai/dashboard', trustedHosts)).toBe(true);
  });

  it('accepts www variant', () => {
    expect(isTrustedAppURL('https://www.clientintelligence.ai', trustedHosts)).toBe(true);
  });

  it('rejects HTTP for trusted host', () => {
    expect(isTrustedAppURL('http://clientintelligence.ai', trustedHosts)).toBe(false);
  });

  it('rejects untrusted host', () => {
    expect(isTrustedAppURL('https://evil.com', trustedHosts)).toBe(false);
  });

  it('accepts localhost HTTP when in trusted hosts', () => {
    const withLocal = new Set(['localhost:3000']);
    expect(isTrustedAppURL('http://localhost:3000', withLocal)).toBe(true);
  });

  it('rejects invalid URL', () => {
    expect(isTrustedAppURL('not-a-url', trustedHosts)).toBe(false);
  });
});

describe('isAllowedGatewayURL', () => {
  it('accepts WSS URL', () => {
    expect(isAllowedGatewayURL('wss://gateway.clientintelligence.ai/connect')).toBe(true);
  });

  it('accepts HTTPS URL', () => {
    expect(isAllowedGatewayURL('https://gateway.clientintelligence.ai/connect')).toBe(true);
  });

  it('accepts local WS URL', () => {
    expect(isAllowedGatewayURL('ws://localhost:47391/connect')).toBe(true);
  });

  it('accepts local HTTP URL', () => {
    expect(isAllowedGatewayURL('http://127.0.0.1:47391/connect')).toBe(true);
  });

  it('rejects plain HTTP to external host', () => {
    expect(isAllowedGatewayURL('http://evil.com/connect')).toBe(false);
  });

  it('rejects invalid URL', () => {
    expect(isAllowedGatewayURL('not-a-url')).toBe(false);
  });
});
