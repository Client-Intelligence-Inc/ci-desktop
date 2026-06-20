export function getURLHost(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

export function parseTrustedHosts(raw?: string): string[] {
  if (!raw) return [];
  return raw.split(',').map((host) => host.trim()).filter(Boolean);
}

export function isLocalDevOrigin(parsed: URL): boolean {
  return (
    parsed.protocol === 'http:' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
  );
}

export function isLocalDevGateway(parsed: URL): boolean {
  return (
    (parsed.protocol === 'ws:' || parsed.protocol === 'http:') &&
    ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
  );
}

export function isTrustedAppURL(url: string, trustedHosts: Set<string>): boolean {
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === 'https:' || isLocalDevOrigin(parsed)) &&
      trustedHosts.has(parsed.host)
    );
  } catch {
    return false;
  }
}

export function isAllowedGatewayURL(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'wss:' || parsed.protocol === 'https:' || isLocalDevGateway(parsed);
  } catch {
    return false;
  }
}
