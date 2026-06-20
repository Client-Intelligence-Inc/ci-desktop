const VERCEL_BYPASS_HEADER = 'x-vercel-protection-bypass';
const VERCEL_SET_BYPASS_COOKIE_HEADER = 'x-vercel-set-bypass-cookie';

export function getDesktopGatewayBypassHeaders(gatewayUrl: string): Record<string, string> {
  const secret = readEnv('CI_DESKTOP_AGENT_VERCEL_BYPASS_SECRET') || readEnv('VERCEL_AUTOMATION_BYPASS_SECRET');
  if (!secret || !isAllowedVercelBypassHost(gatewayUrl)) return {};

  const headers: Record<string, string> = {
    [VERCEL_BYPASS_HEADER]: secret,
  };
  const cookieMode = readEnv('CI_DESKTOP_AGENT_VERCEL_SET_BYPASS_COOKIE');
  if (cookieMode === 'true' || cookieMode === 'samesitenone') {
    headers[VERCEL_SET_BYPASS_COOKIE_HEADER] = cookieMode;
  }
  return headers;
}

function isAllowedVercelBypassHost(gatewayUrl: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(gatewayUrl).hostname.toLowerCase();
  } catch {
    return false;
  }

  if (hostname === 'vercel.app' || hostname.endsWith('.vercel.app')) return true;

  const configuredHosts = (process.env.CI_DESKTOP_AGENT_VERCEL_BYPASS_HOSTS || '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  return configuredHosts.includes(hostname);
}

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}
