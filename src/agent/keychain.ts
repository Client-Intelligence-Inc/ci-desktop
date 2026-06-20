import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const DEVICE_TOKEN_SERVICE_NAME = 'Client Intelligence Desktop Agent';
const SECRET_SERVICE_NAME = 'Client Intelligence Desktop Agent Secrets';

export async function saveDeviceToken(account: string, token: string): Promise<void> {
  await saveGenericPassword(DEVICE_TOKEN_SERVICE_NAME, account, token);
}

export async function loadDeviceToken(account: string): Promise<string | undefined> {
  return loadGenericPassword(DEVICE_TOKEN_SERVICE_NAME, account);
}

export async function deleteDeviceToken(account: string): Promise<void> {
  await deleteGenericPassword(DEVICE_TOKEN_SERVICE_NAME, account);
}

export async function saveNamedSecret(account: string, secret: string): Promise<void> {
  await saveGenericPassword(SECRET_SERVICE_NAME, account, secret);
}

export async function loadNamedSecret(account: string): Promise<string | undefined> {
  return loadGenericPassword(SECRET_SERVICE_NAME, account);
}

export async function deleteNamedSecret(account: string): Promise<void> {
  await deleteGenericPassword(SECRET_SERVICE_NAME, account);
}

async function saveGenericPassword(service: string, account: string, value: string): Promise<void> {
  if (process.env.CI_DESKTOP_AGENT_DISABLE_KEYCHAIN === '1') {
    throw new Error('macOS Keychain is disabled by environment');
  }
  if (process.platform !== 'darwin') throw new Error('macOS Keychain is required');

  await deleteGenericPassword(service, account).catch(() => undefined);
  await execFileAsync('/usr/bin/security', [
    'add-generic-password',
    '-a',
    account,
    '-s',
    service,
    '-w',
    value,
  ]);
}

async function loadGenericPassword(service: string, account: string): Promise<string | undefined> {
  if (process.platform !== 'darwin') return undefined;

  try {
    const result = await execFileAsync('/usr/bin/security', [
      'find-generic-password',
      '-a',
      account,
      '-s',
      service,
      '-w',
    ]);
    return result.stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function deleteGenericPassword(service: string, account: string): Promise<void> {
  if (process.platform !== 'darwin') return;

  await execFileAsync('/usr/bin/security', [
    'delete-generic-password',
    '-a',
    account,
    '-s',
    service,
  ]);
}
