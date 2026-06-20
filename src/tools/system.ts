import { execFile } from 'child_process';
import * as os from 'os';
import { promisify } from 'util';
import { DesktopAgentSettings, ToolRequest, ToolResult } from '../agent/types';

const execFileAsync = promisify(execFile);

export async function runSystemTool(
  request: ToolRequest,
  _settings: DesktopAgentSettings,
): Promise<ToolResult> {
  switch (request.tool) {
    case 'system.info':
      return systemInfo();
    case 'system.storage':
      return systemStorage(request);
    case 'system.network':
      return systemNetwork(request);
    default:
      return { ok: false, error: `Unsupported system tool: ${request.tool}` };
  }
}

async function systemInfo(): Promise<ToolResult> {
  const cpus = os.cpus();

  return {
    ok: true,
    result: {
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      release: os.release(),
      uptimeSeconds: Math.floor(os.uptime()),
      loadAverage: os.loadavg(),
      cpu: {
        count: cpus.length,
        model: cpus[0]?.model,
      },
      memory: {
        totalBytes: os.totalmem(),
        freeBytes: os.freemem(),
      },
    },
  };
}

async function systemStorage(request: ToolRequest): Promise<ToolResult> {
  const args = request.args as { path?: string };
  const commandArgs = ['-kP'];
  if (args?.path) commandArgs.push(args.path);

  const { stdout } = await execFileAsync('/bin/df', commandArgs, {
    timeout: 10000,
    maxBuffer: 1024 * 1024,
  });

  const volumes = parseDf(stdout);
  return {
    ok: true,
    result: {
      path: args?.path,
      volumes,
      count: volumes.length,
    },
  };
}

async function systemNetwork(request: ToolRequest): Promise<ToolResult> {
  const args = request.args as { includeInternal?: boolean };
  const interfaces = os.networkInterfaces();
  const addresses = Object.entries(interfaces).flatMap(([name, entries]) => (
    (entries || [])
      .filter((entry) => args?.includeInternal || !entry.internal)
      .map((entry) => ({
        name,
        address: entry.address,
        family: entry.family,
        cidr: entry.cidr,
        mac: entry.mac,
        internal: entry.internal,
        scopeid: entry.scopeid,
      }))
  ));

  return {
    ok: true,
    result: {
      hostname: os.hostname(),
      addresses,
      count: addresses.length,
      includeInternal: Boolean(args?.includeInternal),
    },
  };
}

function parseDf(stdout: string): Array<{
  filesystem: string;
  sizeBytes: number;
  usedBytes: number;
  availableBytes: number;
  capacity: string;
  mount: string;
}> {
  return stdout
    .trim()
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 6)
    .map((parts) => ({
      filesystem: parts[0],
      sizeBytes: Number(parts[1]) * 1024,
      usedBytes: Number(parts[2]) * 1024,
      availableBytes: Number(parts[3]) * 1024,
      capacity: parts[4],
      mount: parts.slice(5).join(' '),
    }));
}
