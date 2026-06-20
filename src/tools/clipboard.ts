import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { DesktopAgentSettings, ToolRequest, ToolResult } from '../agent/types';

const execFileAsync = promisify(execFile);
const MAX_CLIPBOARD_TEXT_BYTES = 1024 * 1024;

export async function runClipboardTool(
  request: ToolRequest,
  _settings: DesktopAgentSettings,
): Promise<ToolResult> {
  if (process.platform !== 'darwin') {
    return { ok: false, error: 'Clipboard tools are currently supported only on macOS' };
  }

  switch (request.tool) {
    case 'clipboard.read_text':
      return readClipboardText();
    case 'clipboard.write_text':
      return writeClipboardText(request);
    default:
      return { ok: false, error: `Unsupported clipboard tool: ${request.tool}` };
  }
}

async function readClipboardText(): Promise<ToolResult> {
  const { stdout } = await execFileAsync('/usr/bin/pbpaste', [], {
    encoding: 'utf-8',
    maxBuffer: MAX_CLIPBOARD_TEXT_BYTES,
    timeout: 5000,
  });

  return {
    ok: true,
    result: {
      content: stdout,
      bytes: Buffer.byteLength(stdout, 'utf-8'),
    },
  };
}

async function writeClipboardText(request: ToolRequest): Promise<ToolResult> {
  const args = request.args as { text?: string };
  if (typeof args?.text !== 'string') return { ok: false, error: 'text is required' };

  const bytes = Buffer.byteLength(args.text, 'utf-8');
  if (bytes > MAX_CLIPBOARD_TEXT_BYTES) {
    return { ok: false, error: `clipboard text is too large (${bytes} bytes)` };
  }

  await writeToPbcopy(args.text);

  return {
    ok: true,
    result: {
      bytes,
      written: true,
    },
  };
}

function writeToPbcopy(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/pbcopy', [], {
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr || `pbcopy exited with code ${code}`));
    });
    child.stdin.end(text);
  });
}
