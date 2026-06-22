import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

interface TelemetryEvent {
  event: string;
  properties?: Record<string, unknown>;
  timestamp: string;
  sessionId: string;
  appVersion: string;
  platform: string;
  arch: string;
}

let sessionId: string | null = null;
let enabled = false;
let eventBuffer: TelemetryEvent[] = [];
let flushInterval: ReturnType<typeof setInterval> | null = null;

const FLUSH_INTERVAL_MS = 5 * 60 * 1000;
const MAX_BUFFER_SIZE = 100;

function getSettingsPath(): string {
  return path.join(app.getPath('userData'), 'telemetry-settings.json');
}

function getAnonymousId(): string {
  const settingsPath = getSettingsPath();
  try {
    const data = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    if (data.anonymousId) return data.anonymousId;
  } catch {
    // no settings file yet
  }
  const id = crypto.randomUUID();
  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({ anonymousId: id, enabled: true }));
  } catch {
    // best-effort
  }
  return id;
}

export function initTelemetry(): void {
  const endpoint = process.env.CI_DESKTOP_TELEMETRY_ENDPOINT;
  if (!endpoint) {
    enabled = false;
    return;
  }

  try {
    const data = JSON.parse(fs.readFileSync(getSettingsPath(), 'utf-8'));
    if (data.enabled === false) {
      enabled = false;
      return;
    }
  } catch {
    // default to enabled if no settings file
  }

  enabled = true;
  sessionId = crypto.randomUUID();

  flushInterval = setInterval(() => {
    void flushEvents(endpoint);
  }, FLUSH_INTERVAL_MS);

  trackEvent('app.launched');

  app.on('before-quit', () => {
    trackEvent('app.quit');
    void flushEvents(endpoint);
  });
}

export function trackEvent(event: string, properties?: Record<string, unknown>): void {
  if (!enabled || !sessionId) return;

  const entry: TelemetryEvent = {
    event,
    properties,
    timestamp: new Date().toISOString(),
    sessionId,
    appVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
  };

  eventBuffer.push(entry);
  if (eventBuffer.length >= MAX_BUFFER_SIZE) {
    const endpoint = process.env.CI_DESKTOP_TELEMETRY_ENDPOINT;
    if (endpoint) void flushEvents(endpoint);
  }
}

export function setTelemetryEnabled(value: boolean): void {
  enabled = value;
  try {
    const settingsPath = getSettingsPath();
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    } catch {
      // fresh settings
    }
    data.enabled = value;
    if (!data.anonymousId) data.anonymousId = getAnonymousId();
    fs.writeFileSync(settingsPath, JSON.stringify(data));
  } catch {
    // best-effort
  }
}

export function isTelemetryEnabled(): boolean {
  return enabled;
}

async function flushEvents(endpoint: string): Promise<void> {
  if (eventBuffer.length === 0) return;
  const batch = eventBuffer.splice(0);
  try {
    const anonymousId = getAnonymousId();
    await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ anonymousId, events: batch }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // silently drop failed telemetry — never block the app
  }
}

export function cleanupTelemetry(): void {
  if (flushInterval) {
    clearInterval(flushInterval);
    flushInterval = null;
  }
}
