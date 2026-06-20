import * as fs from 'fs';
import * as path from 'path';
import { DesktopAgentSettings } from '../agent/types';

export function resolvePathInScope(targetPath: string, settings: DesktopAgentSettings): string {
  if (typeof targetPath !== 'string' || targetPath.trim() === '') {
    throw new Error('A non-empty path is required');
  }

  if (settings.fileAccessMode === 'none') {
    throw new Error('File access is disabled');
  }

  const resolved = path.resolve(expandHome(targetPath));

  if (settings.fileAccessMode === 'full_disk') {
    return resolved;
  }

  const canonicalTarget = canonicalizePathForScope(resolved);
  const allowed = settings.allowedFolders
    .map((folder) => canonicalizePathForScope(path.resolve(expandHome(folder))))
    .some((folder) => isSameOrChildPath(canonicalTarget, folder));

  if (!allowed) {
    throw new Error(`Path is outside allowed folders: ${resolved}`);
  }

  return resolved;
}

export function ensureParentDirectory(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function expandHome(input: string): string {
  if (input === '~') return process.env.HOME || input;
  if (input.startsWith('~/')) return path.join(process.env.HOME || '', input.slice(2));
  return input;
}

function canonicalizePathForScope(inputPath: string): string {
  const missingParts: string[] = [];
  let current = inputPath;

  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    missingParts.unshift(path.basename(current));
    current = parent;
  }

  const canonicalBase = fs.existsSync(current) ? fs.realpathSync.native(current) : current;
  return path.resolve(canonicalBase, ...missingParts);
}

function isSameOrChildPath(candidate: string, parent: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
}
