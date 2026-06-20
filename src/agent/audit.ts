import { app } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AuditEntry, AuditInfo } from './types';

const DEFAULT_MAX_AUDIT_ENTRIES = 5000;
const DEFAULT_AUDIT_READ_LIMIT = 100;
const MAX_AUDIT_READ_LIMIT = 500;

export function getAuditPath(): string {
  if (process.env.CI_DESKTOP_AGENT_AUDIT_PATH) {
    return process.env.CI_DESKTOP_AGENT_AUDIT_PATH;
  }

  const userDataPath = app?.getPath?.('userData') || path.join(os.tmpdir(), 'client-intelligence-desktop');
  return path.join(userDataPath, 'desktop-agent-audit.jsonl');
}

export function appendAuditEntry(entry: Omit<AuditEntry, 'timestamp'>): void {
  const auditPath = getAuditPath();
  fs.mkdirSync(path.dirname(auditPath), { recursive: true });

  const payload: AuditEntry = {
    timestamp: new Date().toISOString(),
    ...sanitizeAuditEntry(entry),
  };

  fs.appendFileSync(auditPath, `${JSON.stringify(payload)}\n`);
  trimAuditEntries();
}

export function readAuditEntries(limit?: unknown): AuditEntry[] {
  try {
    const normalizedLimit = normalizeAuditReadLimit(limit);
    const lines = fs.readFileSync(getAuditPath(), 'utf-8').trim().split('\n').filter(Boolean);
    return lines.slice(-normalizedLimit).map((line) => sanitizeAuditEntry(JSON.parse(line) as AuditEntry));
  } catch {
    return [];
  }
}

export function clearAuditEntries(): void {
  const auditPath = getAuditPath();
  fs.mkdirSync(path.dirname(auditPath), { recursive: true });
  fs.writeFileSync(auditPath, '');
}

export function getAuditInfo(): AuditInfo {
  const auditPath = getAuditPath();
  const entries = readAuditLines().length;
  let bytes = 0;

  try {
    bytes = fs.statSync(auditPath).size;
  } catch {
    bytes = 0;
  }

  return {
    path: auditPath,
    entries,
    bytes,
    maxEntries: getMaxAuditEntries(),
  };
}

function trimAuditEntries(): void {
  const maxEntries = getMaxAuditEntries();
  if (maxEntries <= 0) return;

  const auditPath = getAuditPath();
  const lines = readAuditLines();
  if (lines.length <= maxEntries) return;

  fs.writeFileSync(auditPath, `${lines.slice(-maxEntries).join('\n')}\n`);
}

function readAuditLines(): string[] {
  try {
    return fs.readFileSync(getAuditPath(), 'utf-8').trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function getMaxAuditEntries(): number {
  const configured = Number(process.env.CI_DESKTOP_AGENT_AUDIT_MAX_ENTRIES || DEFAULT_MAX_AUDIT_ENTRIES);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : DEFAULT_MAX_AUDIT_ENTRIES;
}

function normalizeAuditReadLimit(limit: unknown): number {
  const numericLimit = typeof limit === 'number' ? limit : Number(limit);
  if (!Number.isFinite(numericLimit) || numericLimit <= 0) {
    return DEFAULT_AUDIT_READ_LIMIT;
  }
  return Math.min(Math.floor(numericLimit), MAX_AUDIT_READ_LIMIT);
}

function sanitizeAuditEntry<T extends Partial<AuditEntry>>(entry: T): T {
  return {
    ...entry,
    target: redactAuditString(entry.target),
    error: redactAuditString(entry.error),
  };
}

function redactAuditString(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return value;

  return value
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, '$1[redacted]')
    .replace(/((?:password|secret|token|api[_-]?key)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[redacted]');
}
