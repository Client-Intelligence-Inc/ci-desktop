import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { DesktopAgentSettings, ToolRequest, ToolResult } from '../agent/types';
import { resolvePathInScope } from './path-scope';

const execFileAsync = promisify(execFile);
const SYSTEM_COMMAND_DIRS = ['/usr/bin', '/bin'];

export async function runShellTool(
  request: ToolRequest,
  settings: DesktopAgentSettings,
): Promise<ToolResult> {
  if (request.tool !== 'shell.run') {
    return { ok: false, error: `Unsupported shell tool: ${request.tool}` };
  }

  if (!settings.allowShell) {
    return { ok: false, error: 'Shell capability is disabled' };
  }

  const args = request.args as { command?: string; args?: string[]; cwd?: string; timeoutMs?: number };
  if (!args?.command) return { ok: false, error: 'command is required' };
  const command = resolveShellCommand(args.command);
  const commandArgs = normalizeShellArgs(args.args);

  const cwd = resolveShellCwd(args.cwd, settings);

  const result = await execFileAsync(command, commandArgs, {
    cwd,
    timeout: Math.min(Math.max(args.timeoutMs || 10000, 1000), 60000),
    maxBuffer: 1024 * 1024,
  });

  return {
    ok: true,
    result: {
      stdout: result.stdout,
      stderr: result.stderr,
    },
  };
}

function resolveShellCommand(command: string): string {
  if (typeof command !== 'string' || command.trim() === '') {
    throw new Error('command is required');
  }

  if (command.includes('\0')) {
    throw new Error('command contains invalid characters');
  }

  if (command.includes('/')) {
    const normalized = path.normalize(command);
    if (!path.isAbsolute(normalized) || !isSystemCommandPath(normalized)) {
      throw new Error('Only system binary paths under /usr/bin or /bin are allowed');
    }
    return requireExecutableFile(normalized);
  }

  if (command !== path.basename(command)) {
    throw new Error('Only system binary names from /usr/bin or /bin are allowed');
  }

  for (const directory of SYSTEM_COMMAND_DIRS) {
    const candidate = path.join(directory, command);
    if (fs.existsSync(candidate)) {
      return requireExecutableFile(candidate);
    }
  }

  throw new Error('Only system binary names from /usr/bin or /bin are allowed');
}

function isSystemCommandPath(commandPath: string): boolean {
  return SYSTEM_COMMAND_DIRS.some((directory) => path.dirname(commandPath) === directory);
}

function requireExecutableFile(commandPath: string): string {
  const stat = fs.statSync(commandPath);
  if (!stat.isFile()) {
    throw new Error(`command must be an executable file: ${commandPath}`);
  }
  fs.accessSync(commandPath, fs.constants.X_OK);
  return commandPath;
}

function normalizeShellArgs(args: unknown): string[] {
  if (args === undefined) return [];
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) {
    throw new Error('args must be an array of strings');
  }
  return args;
}

function resolveShellCwd(cwd: string | undefined, settings: DesktopAgentSettings): string | undefined {
  if (cwd !== undefined && typeof cwd !== 'string') {
    throw new Error('cwd must be a string');
  }

  if (settings.fileAccessMode === 'full_disk') {
    return cwd ? requireDirectory(resolvePathInScope(cwd, settings)) : undefined;
  }

  if (settings.fileAccessMode === 'none') {
    throw new Error('Shell working directory requires file access scope');
  }

  const scopedCwd = cwd || settings.allowedFolders[0];
  if (!scopedCwd) {
    throw new Error('Shell working directory requires an allowed folder');
  }

  return requireDirectory(resolvePathInScope(scopedCwd, settings));
}

function requireDirectory(cwd: string): string {
  const stat = fs.statSync(cwd);
  if (!stat.isDirectory()) {
    throw new Error(`cwd must be a directory: ${cwd}`);
  }
  return cwd;
}
