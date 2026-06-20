import { shell } from 'electron';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { DesktopAgentSettings, ToolRequest, ToolResult } from '../agent/types';

const execFileAsync = promisify(execFile);
const KNOWN_BROWSERS: Record<string, string> = {
  arc: 'Arc',
  brave: 'Brave Browser',
  chrome: 'Google Chrome',
  edge: 'Microsoft Edge',
  firefox: 'Firefox',
  safari: 'Safari',
};

export async function runBrowserTool(
  request: ToolRequest,
  _settings: DesktopAgentSettings,
): Promise<ToolResult> {
  if (request.tool !== 'browser.open_url') {
    return { ok: false, error: `Unsupported browser tool: ${request.tool}` };
  }

  const args = request.args as { url?: string; browser?: string };
  if (!args?.url) {
    return { ok: false, error: 'url is required' };
  }

  const parsed = new URL(args.url);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { ok: false, error: 'Only http and https URLs can be opened remotely' };
  }

  const browserName = resolveBrowserName(args.browser);
  if (browserName) {
    await execFileAsync('/usr/bin/open', ['-a', browserName, parsed.toString()], { timeout: 10000 });
  } else {
    await shell.openExternal(parsed.toString());
  }

  return {
    ok: true,
    result: {
      opened: parsed.toString(),
      browser: browserName,
    },
  };
}

function resolveBrowserName(browser?: string): string | undefined {
  if (!browser) return undefined;
  const normalized = browser.trim().toLowerCase();
  if (!normalized) return undefined;

  const knownBrowser = KNOWN_BROWSERS[normalized];
  if (!knownBrowser) {
    throw new Error(`Unsupported browser: ${browser}`);
  }

  return knownBrowser;
}
