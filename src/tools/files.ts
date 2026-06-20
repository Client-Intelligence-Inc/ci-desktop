import * as fs from 'fs/promises';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { DesktopAgentSettings, ToolRequest, ToolResult } from '../agent/types';
import { ensureParentDirectory, resolvePathInScope } from './path-scope';

const DEFAULT_SEARCH_LIMIT = 100;
const MAX_READ_BYTES = 5 * 1024 * 1024;
const MAX_BINARY_BYTES = 25 * 1024 * 1024;
const MAX_TAIL_BYTES = 1024 * 1024;
const execFileAsync = promisify(execFile);

export async function runFileTool(
  request: ToolRequest,
  settings: DesktopAgentSettings,
): Promise<ToolResult> {
  switch (request.tool) {
    case 'files.stat':
      return statPath(request, settings);
    case 'files.list':
      return listFiles(request, settings);
    case 'files.search':
      return searchFiles(request, settings);
    case 'files.read':
      return readFile(request, settings);
    case 'files.tail':
      return tailFile(request, settings);
    case 'files.write':
      return writeFile(request, settings);
    case 'files.read_binary':
      return readBinaryFile(request, settings);
    case 'files.write_binary':
      return writeBinaryFile(request, settings);
    case 'files.mkdir':
      return makeDirectory(request, settings);
    case 'files.copy':
      return copyPath(request, settings);
    case 'files.move':
      return movePath(request, settings);
    case 'files.delete':
      return deletePath(request, settings);
    case 'files.open':
      return openPath(request, settings);
    case 'files.reveal':
      return revealPath(request, settings);
    default:
      return { ok: false, error: `Unsupported file tool: ${request.tool}` };
  }
}

async function statPath(
  request: ToolRequest,
  settings: DesktopAgentSettings,
): Promise<ToolResult> {
  const args = request.args as { path?: string };
  if (!args?.path) return { ok: false, error: 'path is required' };

  const targetPath = resolvePathInScope(args.path, settings);
  const stat = await fs.stat(targetPath);

  return {
    ok: true,
    result: {
      path: targetPath,
      type: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other',
      size: stat.size,
      createdAt: stat.birthtime.toISOString(),
      modifiedAt: stat.mtime.toISOString(),
    },
  };
}

async function listFiles(
  request: ToolRequest,
  settings: DesktopAgentSettings,
): Promise<ToolResult> {
  const args = request.args as { path?: string };
  const folder = resolvePathInScope(args?.path || '.', settings);
  const entries = await fs.readdir(folder, { withFileTypes: true });

  return {
    ok: true,
    result: {
      path: folder,
      entries: entries.map((entry) => ({
        name: entry.name,
        path: path.join(folder, entry.name),
        type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
      })),
    },
  };
}

async function readFile(
  request: ToolRequest,
  settings: DesktopAgentSettings,
): Promise<ToolResult> {
  const args = request.args as { path?: string; encoding?: BufferEncoding };
  if (!args?.path) return { ok: false, error: 'path is required' };

  const filePath = resolvePathInScope(args.path, settings);
  const stat = await fs.stat(filePath);

  if (!stat.isFile()) {
    return { ok: false, error: 'path must be a file' };
  }

  if (stat.size > MAX_READ_BYTES) {
    return { ok: false, error: `file is too large to read directly (${stat.size} bytes)` };
  }

  const encoding = args.encoding || 'utf-8';
  const content = await fs.readFile(filePath, encoding);

  return {
    ok: true,
    result: {
      path: filePath,
      size: stat.size,
      encoding,
      content,
    },
  };
}

async function tailFile(
  request: ToolRequest,
  settings: DesktopAgentSettings,
): Promise<ToolResult> {
  const args = request.args as {
    path?: string;
    lines?: number;
    bytes?: number;
    encoding?: BufferEncoding;
  };
  if (!args?.path) return { ok: false, error: 'path is required' };

  const filePath = resolvePathInScope(args.path, settings);
  const stat = await fs.stat(filePath);

  if (!stat.isFile()) {
    return { ok: false, error: 'path must be a file' };
  }

  const bytes = Math.min(Math.max(args.bytes || MAX_TAIL_BYTES, 1), MAX_TAIL_BYTES);
  const start = Math.max(stat.size - bytes, 0);
  const handle = await fs.open(filePath, 'r');

  try {
    const buffer = Buffer.alloc(stat.size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const encoding = args.encoding || 'utf-8';
    let content = buffer.toString(encoding);
    const lines = args.lines === undefined ? 100 : Math.min(Math.max(args.lines, 1), 1000);
    const allLines = content.split(/\r?\n/);
    if (allLines.length > lines) {
      content = allLines.slice(-lines).join('\n');
    }

    return {
      ok: true,
      result: {
        path: filePath,
        size: stat.size,
        startByte: start,
        bytesRead: buffer.length,
        encoding,
        lines,
        truncated: start > 0 || allLines.length > lines,
        content,
      },
    };
  } finally {
    await handle.close();
  }
}

async function writeFile(
  request: ToolRequest,
  settings: DesktopAgentSettings,
): Promise<ToolResult> {
  const args = request.args as { path?: string; content?: string; encoding?: BufferEncoding };
  if (!args?.path) return { ok: false, error: 'path is required' };
  if (typeof args.content !== 'string') return { ok: false, error: 'content must be a string' };

  const filePath = resolvePathInScope(args.path, settings);
  ensureParentDirectory(filePath);
  const encoding = args.encoding || 'utf-8';
  await fs.writeFile(filePath, args.content, encoding);

  return {
    ok: true,
    result: {
      path: filePath,
      bytes: Buffer.byteLength(args.content, encoding),
    },
  };
}

async function readBinaryFile(
  request: ToolRequest,
  settings: DesktopAgentSettings,
): Promise<ToolResult> {
  const args = request.args as { path?: string };
  if (!args?.path) return { ok: false, error: 'path is required' };

  const filePath = resolvePathInScope(args.path, settings);
  const stat = await fs.stat(filePath);

  if (!stat.isFile()) {
    return { ok: false, error: 'path must be a file' };
  }

  if (stat.size > MAX_BINARY_BYTES) {
    return { ok: false, error: `file is too large for binary transfer (${stat.size} bytes)` };
  }

  const content = await fs.readFile(filePath);

  return {
    ok: true,
    result: {
      path: filePath,
      size: stat.size,
      encoding: 'base64',
      contentBase64: content.toString('base64'),
    },
  };
}

async function writeBinaryFile(
  request: ToolRequest,
  settings: DesktopAgentSettings,
): Promise<ToolResult> {
  const args = request.args as { path?: string; contentBase64?: string };
  if (!args?.path) return { ok: false, error: 'path is required' };
  if (typeof args.contentBase64 !== 'string') {
    return { ok: false, error: 'contentBase64 must be a string' };
  }

  const buffer = Buffer.from(args.contentBase64, 'base64');
  if (buffer.length > MAX_BINARY_BYTES) {
    return { ok: false, error: `binary content is too large (${buffer.length} bytes)` };
  }

  const filePath = resolvePathInScope(args.path, settings);
  ensureParentDirectory(filePath);
  await fs.writeFile(filePath, buffer);

  return {
    ok: true,
    result: {
      path: filePath,
      bytes: buffer.length,
      encoding: 'base64',
    },
  };
}

async function searchFiles(
  request: ToolRequest,
  settings: DesktopAgentSettings,
): Promise<ToolResult> {
  const args = request.args as {
    path?: string;
    query?: string;
    includeContent?: boolean;
    limit?: number;
  };

  if (!args?.query) return { ok: false, error: 'query is required' };

  const root = resolvePathInScope(args.path || '.', settings);
  const limit = Math.min(Math.max(args.limit || DEFAULT_SEARCH_LIMIT, 1), 500);
  const query = args.query.toLowerCase();
  const matches: Array<{ path: string; type: string; reason: string }> = [];

  await walk(root, async (entryPath, type) => {
    if (matches.length >= limit) return false;

    const basename = path.basename(entryPath).toLowerCase();
    if (basename.includes(query)) {
      matches.push({ path: entryPath, type, reason: 'name' });
      return true;
    }

    if (args.includeContent && type === 'file') {
      try {
        const stat = await fs.stat(entryPath);
        if (stat.size <= MAX_READ_BYTES) {
          const content = await fs.readFile(entryPath, 'utf-8');
          if (content.toLowerCase().includes(query)) {
            matches.push({ path: entryPath, type, reason: 'content' });
          }
        }
      } catch {
        // Skip unreadable or binary-looking files.
      }
    }

    return true;
  });

  return {
    ok: true,
    result: {
      root,
      query: args.query,
      matches,
      truncated: matches.length >= limit,
    },
  };
}

async function makeDirectory(
  request: ToolRequest,
  settings: DesktopAgentSettings,
): Promise<ToolResult> {
  const args = request.args as { path?: string };
  if (!args?.path) return { ok: false, error: 'path is required' };

  const directoryPath = resolvePathInScope(args.path, settings);
  await fs.mkdir(directoryPath, { recursive: true });

  return {
    ok: true,
    result: {
      path: directoryPath,
      created: true,
    },
  };
}

async function copyPath(
  request: ToolRequest,
  settings: DesktopAgentSettings,
): Promise<ToolResult> {
  const args = request.args as { sourcePath?: string; destinationPath?: string; overwrite?: boolean };
  if (!args?.sourcePath) return { ok: false, error: 'sourcePath is required' };
  if (!args?.destinationPath) return { ok: false, error: 'destinationPath is required' };

  const sourcePath = resolvePathInScope(args.sourcePath, settings);
  const destinationPath = resolvePathInScope(args.destinationPath, settings);
  const sourceStat = await fs.stat(sourcePath);
  await ensureDestinationAvailable(destinationPath, Boolean(args.overwrite));

  if (sourceStat.isDirectory()) {
    ensureParentDirectory(destinationPath);
    await fs.cp(sourcePath, destinationPath, {
      recursive: true,
      force: Boolean(args.overwrite),
      errorOnExist: !args.overwrite,
    });
  } else {
    ensureParentDirectory(destinationPath);
    await fs.copyFile(sourcePath, destinationPath);
  }

  return {
    ok: true,
    result: {
      sourcePath,
      destinationPath,
      type: sourceStat.isDirectory() ? 'directory' : sourceStat.isFile() ? 'file' : 'other',
      copied: true,
    },
  };
}

async function movePath(
  request: ToolRequest,
  settings: DesktopAgentSettings,
): Promise<ToolResult> {
  const args = request.args as { sourcePath?: string; destinationPath?: string; overwrite?: boolean };
  if (!args?.sourcePath) return { ok: false, error: 'sourcePath is required' };
  if (!args?.destinationPath) return { ok: false, error: 'destinationPath is required' };

  const sourcePath = resolvePathInScope(args.sourcePath, settings);
  const destinationPath = resolvePathInScope(args.destinationPath, settings);
  const sourceStat = await fs.stat(sourcePath);
  await ensureDestinationAvailable(destinationPath, Boolean(args.overwrite));
  ensureParentDirectory(destinationPath);

  if (args.overwrite) {
    await fs.rm(destinationPath, { recursive: true, force: true });
  }
  await fs.rename(sourcePath, destinationPath);

  return {
    ok: true,
    result: {
      sourcePath,
      destinationPath,
      type: sourceStat.isDirectory() ? 'directory' : sourceStat.isFile() ? 'file' : 'other',
      moved: true,
    },
  };
}

async function deletePath(
  request: ToolRequest,
  settings: DesktopAgentSettings,
): Promise<ToolResult> {
  const args = request.args as { path?: string; recursive?: boolean };
  if (!args?.path) return { ok: false, error: 'path is required' };

  const targetPath = resolvePathInScope(args.path, settings);
  const stat = await fs.stat(targetPath);
  const type = stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other';

  if (stat.isDirectory() && !args.recursive) {
    return { ok: false, error: 'recursive must be true to delete a directory' };
  }

  await fs.rm(targetPath, {
    recursive: Boolean(args.recursive),
    force: false,
  });

  return {
    ok: true,
    result: {
      path: targetPath,
      type,
      deleted: true,
    },
  };
}

async function openPath(
  request: ToolRequest,
  settings: DesktopAgentSettings,
): Promise<ToolResult> {
  const args = request.args as { path?: string };
  if (!args?.path) return { ok: false, error: 'path is required' };
  if (!canOpenLocalFiles(settings)) return { ok: false, error: 'File opening is disabled' };

  const targetPath = resolvePathInScope(args.path, settings);
  const stat = await fs.stat(targetPath);
  await execFileAsync('/usr/bin/open', [targetPath], { timeout: 10000 });

  return {
    ok: true,
    result: {
      path: targetPath,
      type: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other',
      opened: true,
    },
  };
}

async function revealPath(
  request: ToolRequest,
  settings: DesktopAgentSettings,
): Promise<ToolResult> {
  const args = request.args as { path?: string };
  if (!args?.path) return { ok: false, error: 'path is required' };
  if (!canOpenLocalFiles(settings)) return { ok: false, error: 'File reveal is disabled' };

  const targetPath = resolvePathInScope(args.path, settings);
  const stat = await fs.stat(targetPath);
  await execFileAsync('/usr/bin/open', ['-R', targetPath], { timeout: 10000 });

  return {
    ok: true,
    result: {
      path: targetPath,
      type: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other',
      revealed: true,
    },
  };
}

async function ensureDestinationAvailable(destinationPath: string, overwrite: boolean): Promise<void> {
  try {
    await fs.lstat(destinationPath);
    if (!overwrite) {
      throw new Error(`destination already exists: ${destinationPath}`);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return;
    throw error;
  }
}

function canOpenLocalFiles(settings: DesktopAgentSettings): boolean {
  return ['open_apps', 'screen', 'keyboard_mouse', 'automation'].includes(settings.controlMode);
}

async function walk(
  currentPath: string,
  visitor: (entryPath: string, type: 'file' | 'directory' | 'other') => Promise<boolean>,
): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(currentPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;

    const entryPath = path.join(currentPath, entry.name);
    const type = entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other';
    const shouldContinue = await visitor(entryPath, type);

    if (shouldContinue === false) return;
    if (entry.isDirectory()) {
      await walk(entryPath, visitor);
    }
  }
}
