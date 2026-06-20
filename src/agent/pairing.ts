import * as http from 'http';
import * as https from 'https';
import { getDesktopGatewayBypassHeaders } from './http-headers';

export interface PairDeviceRequest {
  ownerUserId: string;
  displayName: string;
  existingDeviceId?: string;
  capabilities?: unknown;
  pairingToken?: string;
}

export interface PairDeviceResponse {
  deviceId: string;
  deviceToken: string;
  ownerUserId: string;
}

export async function pairDeviceWithGateway(
  gatewayUrl: string,
  request: PairDeviceRequest,
): Promise<PairDeviceResponse> {
  const url = getPairingURL(gatewayUrl);
  const { pairingToken, ...body } = request;
  const payload = JSON.stringify(body);
  const transport = url.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const req = transport.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        ...getDesktopGatewayBypassHeaders(gatewayUrl),
        ...(pairingToken ? { authorization: `Bearer ${pairingToken}` } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data) as Partial<PairDeviceResponse> & { error?: string };
          if (!res.statusCode || res.statusCode >= 400) {
            reject(new Error(parsed.error || `Pairing failed with HTTP ${res.statusCode}`));
            return;
          }
          if (!parsed.deviceId || !parsed.deviceToken || !parsed.ownerUserId) {
            reject(new Error('Pairing response was missing required fields'));
            return;
          }
          resolve({
            deviceId: parsed.deviceId,
            deviceToken: parsed.deviceToken,
            ownerUserId: parsed.ownerUserId,
          });
        } catch (error) {
          reject(error);
        }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

export async function revokeDeviceWithGateway(
  gatewayUrl: string,
  deviceId: string,
  deviceToken?: string,
): Promise<void> {
  const url = getRevokeURL(gatewayUrl, deviceId);
  const transport = url.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const req = transport.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: {
        ...getDesktopGatewayBypassHeaders(gatewayUrl),
        ...(deviceToken ? { authorization: `Bearer ${deviceToken}` } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        if (!res.statusCode || res.statusCode >= 400) {
          try {
            const parsed = JSON.parse(data) as { error?: string };
            reject(new Error(parsed.error || `Revoke failed with HTTP ${res.statusCode}`));
          } catch {
            reject(new Error(`Revoke failed with HTTP ${res.statusCode}`));
          }
          return;
        }
        resolve();
      });
    });

    req.on('error', reject);
    req.end();
  });
}

function getPairingURL(gatewayUrl: string): URL {
  const parsed = new URL(gatewayUrl);
  parsed.protocol = parsed.protocol === 'wss:' || parsed.protocol === 'https:' ? 'https:' : 'http:';
  parsed.pathname = '/api/desktop/devices/pair';
  parsed.search = '';
  parsed.hash = '';
  return parsed;
}

function getRevokeURL(gatewayUrl: string, deviceId: string): URL {
  const parsed = new URL(gatewayUrl);
  parsed.protocol = parsed.protocol === 'wss:' || parsed.protocol === 'https:' ? 'https:' : 'http:';
  parsed.pathname = `/api/desktop/devices/${encodeURIComponent(deviceId)}/revoke`;
  parsed.search = '';
  parsed.hash = '';
  return parsed;
}
