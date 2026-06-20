import { execFile } from 'child_process';
import * as path from 'path';
import { promisify } from 'util';
import { DesktopAgentSettings, ToolRequest, ToolResult } from '../agent/types';

const execFileAsync = promisify(execFile);

export async function runAppTool(
  request: ToolRequest,
  settings: DesktopAgentSettings,
): Promise<ToolResult> {
  try {
    if (request.tool === 'apps.list') {
      return listApps();
    }

    if (request.tool === 'apps.frontmost') {
      return frontmostApp();
    }

    if (!canControlApps(settings)) {
      return { ok: false, error: 'App control is disabled' };
    }

    const args = request.args as { name?: string; path?: string; pid?: number };

    if (request.tool === 'apps.open' || request.tool === 'apps.activate') {
      if (!args?.name && !args?.path) {
        return { ok: false, error: 'name or path is required' };
      }

      const commandArgs = args.path ? [validateAppBundlePath(args.path)] : ['-a', args.name as string];
      await execFileAsync('/usr/bin/open', commandArgs, { timeout: 10000 });

      return {
        ok: true,
        result: {
          opened: args.path || args.name,
        },
      };
    }

    if (request.tool === 'apps.quit') {
      if (args?.pid !== undefined) {
        if (!Number.isInteger(args.pid) || args.pid <= 0) {
          return { ok: false, error: 'pid must be a positive integer' };
        }
        await execFileAsync('/bin/kill', ['-TERM', String(args.pid)], { timeout: 10000 });
        return {
          ok: true,
          result: {
            quit: args.pid,
          },
        };
      }

      if (!args?.name && !args?.path) {
        return { ok: false, error: 'name, path, or pid is required' };
      }

      const appName = args.name || path.basename(validateAppBundlePath(args.path as string), '.app');
      await execFileAsync('/usr/bin/osascript', [
        '-e',
        `tell application ${JSON.stringify(appName)} to quit`,
      ], { timeout: 10000 });

      return {
        ok: true,
        result: {
          quit: appName,
        },
      };
    }

    return { ok: false, error: `Unsupported app tool: ${request.tool}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function listApps(): Promise<ToolResult> {
  const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'pid=,comm='], {
    timeout: 10000,
    maxBuffer: 1024 * 1024,
  });

  const apps = stdout
    .split('\n')
    .map((line) => {
      const match = line.trim().match(/^(\d+)\s+(.+)$/);
      if (!match) return undefined;
      const pid = Number(match[1]);
      const executablePath = match[2];
      return {
        pid,
        name: path.basename(executablePath),
        path: executablePath,
      };
    })
    .filter((app): app is { pid: number; name: string; path: string } => Boolean(app))
    .slice(0, 500);

  return {
    ok: true,
    result: {
      apps,
      count: apps.length,
      truncated: apps.length >= 500,
    },
  };
}

async function frontmostApp(): Promise<ToolResult> {
  const script = `
tell application "System Events"
  set frontProcess to first application process whose frontmost is true
  set appName to name of frontProcess
  set processId to unix id of frontProcess
  set windowTitle to ""
  try
    if (count of windows of frontProcess) > 0 then
      set windowTitle to name of front window of frontProcess
    end if
  end try
end tell
return appName & linefeed & processId & linefeed & windowTitle
`;
  const { stdout } = await execFileAsync('/usr/bin/osascript', ['-e', script], {
    timeout: 10000,
    maxBuffer: 1024 * 128,
  });
  const [name = '', pid = '', windowTitle = ''] = stdout.trimEnd().split('\n');

  return {
    ok: true,
    result: {
      name,
      pid: Number(pid) || undefined,
      windowTitle,
    },
  };
}

function canControlApps(settings: DesktopAgentSettings): boolean {
  return ['open_apps', 'screen', 'keyboard_mouse', 'automation'].includes(settings.controlMode);
}

function validateAppBundlePath(appPath: string): string {
  if (typeof appPath !== 'string' || !appPath.trim()) {
    throw new Error('app path is required');
  }

  const normalizedPath = path.normalize(appPath);
  if (path.extname(normalizedPath).toLowerCase() !== '.app') {
    throw new Error('app path must point to a .app bundle');
  }

  return normalizedPath;
}
