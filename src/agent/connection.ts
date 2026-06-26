import WebSocket from 'ws';
import { app } from 'electron';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  approvalGrantScope,
  hasDeviceApprovalGrant,
  shouldRequestApproval,
  withDeviceApprovalGrant,
} from './approvals';
import {
  getCapabilityManifest,
  getCapabilityNames,
  runCapability,
  summarizeAuditTarget,
  validateCapabilityInput,
} from './capabilities';
import { appendAuditEntry } from './audit';
import { getDesktopGatewayBypassHeaders } from './http-headers';
import { getPermissionStatuses } from './permissions';
import { verifyJobSignature } from './job-signing';
import { resolvePathInScope } from '../tools/path-scope';
import {
  ActiveJobSummary,
  AgentConnectionStatus,
  DesktopAgentSettings,
  DesktopJob,
  GatewayClientEvent,
  GatewayServerEvent,
  PromptResponse,
} from './types';

type SettingsProvider = () => DesktopAgentSettings;
type SettingsPersistor = (patch: Partial<DesktopAgentSettings>) => DesktopAgentSettings;
type StatusListener = () => void;
type ClientEventListener = (event: GatewayClientEvent) => void;
type JobResultEvent = Extract<GatewayClientEvent, { type: 'job.result' }>;
type FileWatchSnapshot = Map<string, {
  type: 'file' | 'directory' | 'other';
  size?: number;
  modifiedMs?: number;
  modifiedAt?: string;
}>;
type RecentJobResult = {
  result: JobResultEvent;
  rememberedAt: number;
};

const RECENT_JOB_TTL_MS = 30 * 60 * 1000;
const MAX_RECENT_JOBS = 500;
const MAX_FILE_WATCH_ENTRIES = 2000;
const SIGNED_JOB_NONCE_TTL_MS = 10 * 60 * 1000;
const MAX_SIGNED_JOB_NONCES = 2000;

export class AgentConnection {
  private socket: WebSocket | null = null;
  private httpPollTimer: NodeJS.Timeout | null = null;
  private httpPollInFlight = false;
  private status: AgentConnectionStatus = 'disconnected';
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private nextReconnectAt: string | undefined;
  private nextReconnectDelayMs: number | undefined;
  private intentionalDisconnect = false;
  private readonly activeJobIds = new Set<string>();
  private readonly activeJobs = new Map<string, ActiveJobSummary>();
  private readonly cancelledJobIds = new Set<string>();
  private readonly localJobIds = new Set<string>();
  private readonly recentJobResults = new Map<string, RecentJobResult>();
  private readonly seenJobSignatureNonces = new Map<string, number>();
  private readonly sessionApprovals = new Set<string>();
  private readonly pendingPrompts = new Map<string, {
    jobId: string;
    resolve: (response: PromptResponse) => void;
    reject: (error: Error) => void;
  }>();
  private lastError: string | undefined;
  private lastConnectedAt: string | undefined;
  private lastHeartbeatAt: string | undefined;
  private listeners = new Set<StatusListener>();
  private clientEventListeners = new Set<ClientEventListener>();

  constructor(
    private readonly getSettings: SettingsProvider,
    private readonly persistSettings?: SettingsPersistor,
  ) {}

  onStatusChange(listener: StatusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onClientEvent(listener: ClientEventListener): () => void {
    this.clientEventListeners.add(listener);
    return () => this.clientEventListeners.delete(listener);
  }

  getSnapshot(): {
    connection: AgentConnectionStatus;
    lastError?: string;
    lastConnectedAt?: string;
    lastHeartbeatAt?: string;
    reconnectAttempt: number;
    nextReconnectAt?: string;
    nextReconnectDelayMs?: number;
    activeJobIds: string[];
    activeJobs: ActiveJobSummary[];
  } {
    return {
      connection: this.status,
      lastError: this.lastError,
      lastConnectedAt: this.lastConnectedAt,
      lastHeartbeatAt: this.lastHeartbeatAt,
      reconnectAttempt: this.reconnectAttempt,
      nextReconnectAt: this.nextReconnectAt,
      nextReconnectDelayMs: this.nextReconnectDelayMs,
      activeJobIds: [...this.activeJobIds],
      activeJobs: [...this.activeJobs.values()],
    };
  }

  connect(): void {
    const settings = this.getSettings();

    if (!settings.enabled) {
      this.setStatus('disabled');
      return;
    }

    const readiness = validateConnectionReadiness(settings);
    if (!readiness.ok) {
      this.lastError = readiness.error;
      this.clearReconnectTimer();
      this.setStatus('error');
      return;
    }

    if (
      this.socket &&
      (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    this.clearReconnectTimer();
    this.clearHttpPollTimer();
    this.intentionalDisconnect = false;
    this.setStatus('connecting');

    if (isHttpGatewayURL(settings.gatewayUrl)) {
      this.connectHttp();
      return;
    }

    const headers: Record<string, string> = {
      'x-ci-agent-version': getAgentVersion(),
      'x-ci-device-name': settings.displayName,
    };

    if (settings.deviceToken) {
      headers.authorization = `Bearer ${settings.deviceToken}`;
    }

    const socket = new WebSocket(settings.gatewayUrl, { headers });
    this.socket = socket;

    socket.on('open', () => {
      if (this.socket !== socket) return;
      this.reconnectAttempt = 0;
      this.lastError = undefined;
      this.lastConnectedAt = new Date().toISOString();
      this.setStatus('connected');
      this.send({
        type: 'hello',
        deviceId: settings.deviceId,
        displayName: settings.displayName,
        agentVersion: getAgentVersion(),
        capabilities: getCapabilityNames(),
        capabilityManifest: getCapabilityManifest(),
      });
      this.startHeartbeat();
    });

    socket.on('message', (data) => {
      if (this.socket !== socket) return;
      void this.handleMessage(data.toString());
    });

    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.stopHeartbeat();
      this.socket = null;
      this.cancelInFlightJobs('desktop_agent_disconnected', false);
      const shouldReconnect = this.getSettings().enabled && !this.intentionalDisconnect;
      this.intentionalDisconnect = false;
      this.setStatus(this.getSettings().enabled ? 'disconnected' : 'disabled');
      if (shouldReconnect) {
        this.scheduleReconnect();
      }
    });

    socket.on('error', (error) => {
      if (this.socket !== socket) return;
      this.lastError = error instanceof Error ? error.message : String(error);
      this.setStatus('error');
    });
  }

  reconnectNow(reason = 'desktop_agent_reconnect'): void {
    const settings = this.getSettings();
    if (!settings.enabled) {
      this.disconnect();
      this.setStatus('disabled');
      return;
    }

    this.clearReconnectTimer();
    this.stopHeartbeat();
    this.clearHttpPollTimer();
    this.reconnectAttempt = 0;
    this.cancelInFlightJobs(reason, false);

    const socket = this.socket;
    if (socket) {
      this.socket = null;
      this.intentionalDisconnect = true;
      socket.close();
      this.intentionalDisconnect = false;
    }

    this.connect();
  }

  pauseForSleep(reason = 'desktop_agent_sleep'): void {
    this.clearReconnectTimer();
    this.stopHeartbeat();
    this.clearHttpPollTimer();
    this.intentionalDisconnect = true;
    this.cancelInFlightJobs(reason, true);
    this.socket?.close();
    this.socket = null;
    this.setStatus(this.getSettings().enabled ? 'disconnected' : 'disabled');
  }

  disconnect(): void {
    this.clearReconnectTimer();
    this.stopHeartbeat();
    this.clearHttpPollTimer();
    this.intentionalDisconnect = true;
    this.cancelInFlightJobs('desktop_agent_kill_switch', true);
    this.socket?.close();
    this.socket = null;
    this.setStatus('disconnected');
  }

  clearAuthorizationState(): void {
    this.sessionApprovals.clear();
    this.recentJobResults.clear();
    this.seenJobSignatureNonces.clear();
  }

  runLocalJob(job: DesktopJob): { ok: true } | { ok: false; error: string } {
    if (typeof job.jobId !== 'string' || !job.jobId) {
      return { ok: false, error: 'Local desktop job requires a jobId' };
    }
    if (typeof job.tool !== 'string' || !job.tool) {
      return { ok: false, error: 'Local desktop job requires a tool name' };
    }

    const event: Extract<GatewayServerEvent, { type: 'job.start' }> = {
      type: 'job.start',
      jobId: job.jobId,
      tool: job.tool,
      ownerUserId: job.ownerUserId,
      targetDeviceId: job.targetDeviceId,
      chatId: job.chatId,
      args: job.args,
      policy: job.policy,
    };

    const policyValidation = validateJobPolicy(event.policy);
    if (!policyValidation.ok) return policyValidation;

    const scopeValidation = validateJobScope(event, this.getSettings());
    if (!scopeValidation.ok) return scopeValidation;

    this.localJobIds.add(event.jobId);
    void this.runJob(event).finally(() => {
      const deleteTimer = setTimeout(() => {
        this.localJobIds.delete(event.jobId);
      }, RECENT_JOB_TTL_MS);
      deleteTimer.unref?.();
    });
    return { ok: true };
  }

  respondToLocalPrompt(jobId: string, promptId: string, response: PromptResponse): boolean {
    if (!this.localJobIds.has(jobId)) return false;
    this.resolvePrompt(jobId, promptId, response);
    return true;
  }

  cancelLocalJob(jobId: string, reason = 'local_control_center_cancelled'): boolean {
    if (!this.localJobIds.has(jobId)) return false;
    this.cancelJob(jobId, reason, true);
    return true;
  }

  send(event: GatewayClientEvent): void {
    if (this.routeLocalClientEvent(event)) return;

    if (isHttpGatewayURL(this.getSettings().gatewayUrl)) {
      void this.sendHttpEvent(event);
      return;
    }
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(event));
  }

  private connectHttp(): void {
    void this.pollHttpGateway();
    this.httpPollTimer = setInterval(() => {
      void this.pollHttpGateway();
    }, 2500);
    this.httpPollTimer.unref?.();
  }

  private async pollHttpGateway(): Promise<void> {
    if (this.httpPollInFlight) return;
    this.httpPollInFlight = true;
    const settings = this.getSettings();

    try {
      if (!settings.deviceId || !settings.deviceToken) {
        throw new Error('HTTP desktop gateway requires a paired device token');
      }

      const response = await fetch(getDesktopGatewayAPIURL(
        settings.gatewayUrl,
        `/api/desktop/devices/${encodeURIComponent(settings.deviceId)}/jobs/claim?limit=3`,
      ), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${settings.deviceToken}`,
          'content-type': 'application/json',
          'x-ci-agent-version': getAgentVersion(),
          'x-ci-device-name': settings.displayName,
          ...getDesktopGatewayBypassHeaders(settings.gatewayUrl),
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP desktop gateway claim failed with ${response.status}`);
      }

      const payload = await response.json() as { jobs?: unknown[]; commands?: unknown[] };
      this.reconnectAttempt = 0;
      this.lastError = undefined;
      if (this.status !== 'connected') {
        this.lastConnectedAt = new Date().toISOString();
        this.setStatus('connected');
        this.startHeartbeat();
      }

      for (const job of Array.isArray(payload.jobs) ? payload.jobs : []) {
        if (isRecord(job)) {
          // HTTP polling must stay free to claim follow-up commands while a job
          // is waiting on approval, secrets, or user input.
          void this.handleMessage(JSON.stringify(job));
        }
      }
      for (const command of Array.isArray(payload.commands) ? payload.commands : []) {
        if (isRecord(command)) {
          await this.handleMessage(JSON.stringify(command));
        }
      }
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.stopHeartbeat();
      this.cancelInFlightJobs('desktop_agent_http_gateway_error', false);
      this.setStatus('error');
    } finally {
      this.httpPollInFlight = false;
    }
  }

  private async sendHttpEvent(event: GatewayClientEvent): Promise<void> {
    const settings = this.getSettings();
    if (!settings.deviceId || !settings.deviceToken) return;

    const request = mapHttpClientEvent(settings, event);
    if (!request) return;

    try {
      const response = await fetch(getDesktopGatewayAPIURL(settings.gatewayUrl, request.path), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${settings.deviceToken}`,
          'content-type': 'application/json',
          'x-ci-agent-version': getAgentVersion(),
          'x-ci-device-name': settings.displayName,
          ...getDesktopGatewayBypassHeaders(settings.gatewayUrl),
        },
        body: JSON.stringify(request.body),
      });
      if (!response.ok) {
        throw new Error(`HTTP desktop gateway event failed with ${response.status}`);
      }
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.emitStatus();
    }
  }

  private async handleMessage(raw: string): Promise<void> {
    let event: unknown;

    try {
      event = JSON.parse(raw);
    } catch {
      this.lastError = 'Received invalid JSON from desktop gateway';
      this.emitStatus();
      return;
    }

    if (!isRecord(event) || typeof event.type !== 'string') {
      this.lastError = 'Received invalid gateway event envelope';
      this.emitStatus();
      return;
    }

    switch (event.type) {
      case 'job.start':
        if (!this.validateJobStartEnvelope(event)) return;
        await this.runJob(event);
        break;
      case 'job.cancel':
        if (!this.validateJobCancelEnvelope(event)) return;
        this.cancelJob(event.jobId, event.reason || 'cancelled', true);
        break;
      case 'job.user_response':
        if (!this.validateJobUserResponseEnvelope(event)) return;
        this.resolvePrompt(event.jobId, event.promptId, event.response as PromptResponse);
        break;
      case 'ping':
        this.sendHeartbeat();
        break;
      default:
        this.lastError = 'Received unknown gateway event';
        this.emitStatus();
    }
  }

  private validateJobStartEnvelope(event: Record<string, unknown>): event is Extract<GatewayServerEvent, { type: 'job.start' }> {
    if (typeof event.jobId !== 'string' || !event.jobId) {
      this.lastError = 'Received job.start without a valid jobId';
      this.emitStatus();
      return false;
    }

    if (typeof event.tool !== 'string' || !event.tool) {
      this.sendJobResult({
        type: 'job.result',
        jobId: event.jobId,
        status: 'failed',
        error: 'job.start.tool must be a non-empty string',
      });
      return false;
    }

    const policyValidation = validateJobPolicy(event.policy);
    if (!policyValidation.ok) {
      this.sendJobResult({
        type: 'job.result',
        jobId: event.jobId,
        status: 'failed',
        error: policyValidation.error,
      });
      return false;
    }

    const scopeValidation = validateJobScope(event, this.getSettings());
    if (!scopeValidation.ok) {
      this.sendJobResult({
        type: 'job.result',
        jobId: event.jobId,
        status: 'failed',
        error: scopeValidation.error,
      });
      return false;
    }

    const signatureValidation = verifyJobSignature(event as unknown as DesktopJob, this.getSettings().jobSigningSecret);
    if (!signatureValidation.ok) {
      this.sendJobResult({
        type: 'job.result',
        jobId: event.jobId,
        status: 'failed',
        error: signatureValidation.error,
      });
      return false;
    }

    const nonceValidation = this.rememberJobSignatureNonce(event as unknown as DesktopJob);
    if (!nonceValidation.ok) {
      this.sendJobResult({
        type: 'job.result',
        jobId: event.jobId,
        status: 'failed',
        error: nonceValidation.error,
      });
      return false;
    }

    return true;
  }

  private rememberJobSignatureNonce(job: DesktopJob): { ok: true } | { ok: false; error: string } {
    const settings = this.getSettings();
    if (!settings.jobSigningSecret || !job.signature) return { ok: true };

    this.pruneSeenJobSignatureNonces();
    if (this.seenJobSignatureNonces.has(job.signature.nonce)) {
      return { ok: false, error: 'job.start.signature nonce has already been used' };
    }

    this.seenJobSignatureNonces.set(job.signature.nonce, Date.now());
    while (this.seenJobSignatureNonces.size > MAX_SIGNED_JOB_NONCES) {
      const first = this.seenJobSignatureNonces.keys().next().value;
      if (!first) break;
      this.seenJobSignatureNonces.delete(first);
    }

    return { ok: true };
  }

  private pruneSeenJobSignatureNonces(): void {
    const cutoff = Date.now() - SIGNED_JOB_NONCE_TTL_MS;
    for (const [nonce, seenAt] of this.seenJobSignatureNonces) {
      if (seenAt < cutoff) {
        this.seenJobSignatureNonces.delete(nonce);
      }
    }
  }

  private validateJobCancelEnvelope(event: Record<string, unknown>): event is Extract<GatewayServerEvent, { type: 'job.cancel' }> {
    if (typeof event.jobId !== 'string' || !event.jobId) {
      this.lastError = 'Received job.cancel without a valid jobId';
      this.emitStatus();
      return false;
    }

    if (event.reason !== undefined && typeof event.reason !== 'string') {
      this.send({
        type: 'job.progress',
        jobId: event.jobId,
        message: 'Ignored malformed job.cancel: reason must be a string',
      });
      return false;
    }

    return true;
  }

  private validateJobUserResponseEnvelope(event: Record<string, unknown>): event is Extract<GatewayServerEvent, { type: 'job.user_response' }> {
    if (typeof event.jobId !== 'string' || !event.jobId) {
      this.lastError = 'Received job.user_response without a valid jobId';
      this.emitStatus();
      return false;
    }

    if (typeof event.promptId !== 'string' || !event.promptId) {
      this.send({
        type: 'job.progress',
        jobId: event.jobId,
        message: 'Ignored malformed job.user_response: promptId must be a non-empty string',
      });
      return false;
    }

    if (!('response' in event)) {
      this.send({
        type: 'job.progress',
        jobId: event.jobId,
        message: 'Ignored malformed job.user_response: response is required',
      });
      return false;
    }

    return true;
  }

  private async runJob(event: Extract<GatewayServerEvent, { type: 'job.start' }>): Promise<void> {
    const settings = this.getSettings();
    const recentResult = this.recentJobResults.get(event.jobId);
    if (recentResult) {
      this.send({
        type: 'job.progress',
        jobId: event.jobId,
        message: 'Duplicate job ignored; returning cached result',
      });
      this.send(recentResult.result);
      return;
    }

    if (this.activeJobIds.has(event.jobId)) {
      this.send({
        type: 'job.progress',
        jobId: event.jobId,
        message: 'Duplicate job ignored; already running',
      });
      return;
    }

    this.activeJobIds.add(event.jobId);
    this.activeJobs.set(event.jobId, {
      jobId: event.jobId,
      tool: event.tool,
      ownerUserId: event.ownerUserId,
      targetDeviceId: event.targetDeviceId,
      chatId: event.chatId,
      startedAt: new Date().toISOString(),
    });
    this.emitStatus();
    this.send({ type: 'job.progress', jobId: event.jobId, message: `Starting ${event.tool}` });

    appendAuditEntry({
      deviceId: settings.deviceId,
      jobId: event.jobId,
      ownerUserId: event.ownerUserId,
      targetDeviceId: event.targetDeviceId,
      chatId: event.chatId,
      tool: event.tool,
      action: 'job.start',
      target: summarizeAuditTarget(event.tool, event.args),
      result: 'allowed',
    });

    const timeoutMs = Math.min(Math.max(event.policy?.timeoutMs || 120000, 1000), 10 * 60 * 1000);
    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error(`Job timed out after ${timeoutMs}ms`)), timeoutMs);
      timeoutHandle.unref?.();
    });

    try {
      await Promise.race([
        this.ensureJobCanRun(event, settings),
        timeout,
      ]);

      if (isSyntheticPromptTool(event.tool)) {
        const response = await Promise.race([
          this.runSyntheticPrompt(event),
          timeout,
        ]);
        if (this.cancelledJobIds.has(event.jobId)) return;
        this.sendJobResult({
          type: 'job.result',
          jobId: event.jobId,
          status: 'completed',
          result: redactPromptResponse(response),
        });
        return;
      }

      if (event.tool === 'screen.stream') {
        await Promise.race([
          this.runScreenshotStream(event, settings, timeoutMs),
          timeout,
        ]);
        return;
      }

      if (event.tool === 'files.watch') {
        await Promise.race([
          this.runFileWatch(event, settings, timeoutMs),
          timeout,
        ]);
        return;
      }

      const result = await Promise.race([
        runCapability({
          jobId: event.jobId,
          tool: event.tool,
          args: event.args || {},
          ownerUserId: event.ownerUserId,
          targetDeviceId: event.targetDeviceId,
          chatId: event.chatId,
        }, settings),
        timeout,
      ]);

      if (this.cancelledJobIds.has(event.jobId)) return;

      if (result.ok && event.tool === 'screen.screenshot') {
        await this.sendScreenshotResult(event.jobId, result.result);
      }

      if (
        result.ok &&
        event.policy?.screenshotAfterAction &&
        event.tool !== 'screen.screenshot'
      ) {
        await Promise.race([
          this.sendPostActionScreenshot(event, settings),
          timeout,
        ]);
      }

      this.sendJobResult({
        type: 'job.result',
        jobId: event.jobId,
        status: result.ok ? 'completed' : 'failed',
        result: redactLargeScreenshot(result.result),
        error: result.error,
      });
    } catch (error) {
      if (this.cancelledJobIds.has(event.jobId)) return;
      const message = error instanceof Error ? error.message : String(error);
      this.rejectPendingPromptsForJob(event.jobId, message);
      this.sendJobResult({
        type: 'job.result',
        jobId: event.jobId,
        status: 'failed',
        error: message,
      });
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      this.activeJobIds.delete(event.jobId);
      this.activeJobs.delete(event.jobId);
      this.cancelledJobIds.delete(event.jobId);
      this.emitStatus();
    }
  }

  private async ensureJobCanRun(
    event: Extract<GatewayServerEvent, { type: 'job.start' }>,
    settings: DesktopAgentSettings,
  ): Promise<void> {
    if (this.cancelledJobIds.has(event.jobId)) {
      throw new Error('Job was cancelled');
    }

    const validation = validateCapabilityInput(event.tool, event.args || {});
    if (!validation.ok) {
      throw new Error(validation.error || 'Invalid capability input');
    }

    if (isSyntheticPromptTool(event.tool)) return;

    const missingPermissions = await getMissingRunnablePermissions(event.tool, settings);
    if (missingPermissions.length) {
      this.send({
        type: 'job.progress',
        jobId: event.jobId,
        message: `Missing macOS permission: ${missingPermissions.join(', ')}`,
      });
      throw new Error(`Missing macOS permission: ${missingPermissions.join(', ')}. Open the desktop app permission settings and grant access before retrying.`);
    }

    await this.ensureExpectedFrontmostApp(event, settings);

    const approvalMode = event.policy?.approvalMode || settings.approvalMode;

    const needsApproval = shouldRequestApproval({
      approvalMode,
      isApprovalWorthy: isApprovalWorthyTool(event.tool),
      hasSessionApproval: this.sessionApprovals.has(event.tool),
      hasDeviceApproval: hasDeviceApprovalGrant(settings, event.tool),
    });
    if (!needsApproval) return;

    const response = await this.requestInput({
      jobId: event.jobId,
      kind: 'approval',
      message: `Approve ${event.tool} on ${settings.displayName}?`,
      metadata: {
        tool: event.tool,
        args: summarizeArgs(event.args),
        approvalMode,
      },
    });

    const scope = approvalGrantScope(response, approvalMode);
    appendAuditEntry({
      deviceId: settings.deviceId,
      jobId: event.jobId,
      ownerUserId: event.ownerUserId,
      targetDeviceId: event.targetDeviceId,
      chatId: event.chatId,
      tool: event.tool,
      action: 'approval.decision',
      target: summarizeAuditTarget(event.tool, event.args),
      approvalSource: scope,
      result: response.approved ? 'allowed' : 'denied',
      error: response.approved ? undefined : 'User denied approval',
    });

    if (!response.approved) {
      throw new Error('User denied approval');
    }

    if (scope === 'session') {
      this.sessionApprovals.add(event.tool);
    }

    if (scope === 'device') {
      const deviceApprovalGrants = withDeviceApprovalGrant(settings, event.tool);
      this.persistSettings?.({ deviceApprovalGrants });
      appendAuditEntry({
        deviceId: settings.deviceId,
        jobId: event.jobId,
        ownerUserId: event.ownerUserId,
        targetDeviceId: event.targetDeviceId,
        chatId: event.chatId,
        tool: event.tool,
        action: 'approval.grant.device',
        approvalSource: 'device',
        result: 'allowed',
      });
    }
  }

  private async ensureExpectedFrontmostApp(
    event: Extract<GatewayServerEvent, { type: 'job.start' }>,
    settings: DesktopAgentSettings,
  ): Promise<void> {
    const expectedFrontmostApp = getExpectedFrontmostApp(event);
    if (!expectedFrontmostApp) return;

    const frontmost = await runCapability({
      jobId: event.jobId,
      tool: 'apps.frontmost',
      args: {},
      ownerUserId: event.ownerUserId,
      targetDeviceId: event.targetDeviceId,
      chatId: event.chatId,
    }, settings);
    if (!frontmost.ok) {
      throw new Error(`Could not verify frontmost app before ${event.tool}: ${frontmost.error || 'apps.frontmost failed'}`);
    }

    const result = frontmost.result as { name?: unknown; windowTitle?: unknown };
    const currentApp = typeof result?.name === 'string' ? result.name : '';
    const windowTitle = typeof result?.windowTitle === 'string' ? result.windowTitle : '';
    if (normalizeAppName(currentApp) === normalizeAppName(expectedFrontmostApp)) {
      this.send({
        type: 'job.progress',
        jobId: event.jobId,
        message: `Frontmost app verified: ${currentApp}${windowTitle ? ` (${windowTitle})` : ''}`,
      });
      return;
    }

    this.send({
      type: 'job.progress',
      jobId: event.jobId,
      message: `Frontmost app mismatch before ${event.tool}: expected ${expectedFrontmostApp}, current ${currentApp || 'unknown'}`,
    });
    throw new Error(`Frontmost app mismatch: expected ${expectedFrontmostApp}, current ${currentApp || 'unknown'}`);
  }

  private async runSyntheticPrompt(
    event: Extract<GatewayServerEvent, { type: 'job.start' }>,
  ): Promise<PromptResponse> {
    const args = event.args as { message?: string };

    switch (event.tool) {
      case 'agent.ask_user':
        return this.requestInput({
          jobId: event.jobId,
          kind: 'text',
          message: args?.message || 'Input is required to continue.',
        });
      case 'agent.request_secret':
        return this.requestInput({
          jobId: event.jobId,
          kind: 'secret',
          message: args?.message || 'A secret is required to continue.',
        });
      case 'agent.request_approval':
        return this.requestInput({
          jobId: event.jobId,
          kind: 'approval',
          message: args?.message || 'Approval is required to continue.',
        });
      default:
        throw new Error(`Unsupported prompt tool: ${event.tool}`);
    }
  }

  private async runScreenshotStream(
    event: Extract<GatewayServerEvent, { type: 'job.start' }>,
    settings: DesktopAgentSettings,
    timeoutMs: number,
  ): Promise<void> {
    const args = event.args as {
      width?: number;
      height?: number;
      sourceId?: string;
      format?: string;
      quality?: number;
      intervalMs?: number;
      durationMs?: number;
      maxFrames?: number;
    };

    const intervalMs = Math.min(Math.max(args?.intervalMs || 3000, 1000), 30000);
    const durationMs = Math.min(Math.max(args?.durationMs || timeoutMs, 1000), timeoutMs);
    const maxFrames = Math.min(Math.max(args?.maxFrames || Math.ceil(durationMs / intervalMs), 1), 300);
    const startedAt = Date.now();
    let framesSent = 0;

    this.send({
      type: 'job.progress',
      jobId: event.jobId,
      message: `Starting screenshot stream every ${intervalMs}ms`,
    });

    while (
      !this.cancelledJobIds.has(event.jobId) &&
      framesSent < maxFrames &&
      Date.now() - startedAt < durationMs
    ) {
      const result = await runCapability({
        jobId: event.jobId,
        tool: 'screen.screenshot',
        args: {
          width: args?.width,
          height: args?.height,
          sourceId: args?.sourceId,
          format: args?.format,
          quality: args?.quality,
        },
        ownerUserId: event.ownerUserId,
        targetDeviceId: event.targetDeviceId,
        chatId: event.chatId,
      }, settings);

      if (!result.ok) {
        this.sendJobResult({
          type: 'job.result',
          jobId: event.jobId,
          status: 'failed',
          error: result.error || 'Screenshot stream failed',
        });
        return;
      }

      const screenshot = result.result as ScreenshotToolResult;
      if (screenshot.mimeType && screenshot.data) {
        framesSent += 1;
        this.send({
          type: 'job.screenshot',
          jobId: event.jobId,
          image: formatScreenshotImage(screenshot),
        });
        this.send({
          type: 'job.progress',
          jobId: event.jobId,
          message: `Sent screenshot frame ${framesSent}`,
        });
      }

      if (framesSent >= maxFrames || Date.now() - startedAt >= durationMs) break;
      await sleep(intervalMs);
    }

    if (this.cancelledJobIds.has(event.jobId)) return;

    this.sendJobResult({
      type: 'job.result',
      jobId: event.jobId,
      status: 'completed',
      result: {
        framesSent,
        intervalMs,
        durationMs: Date.now() - startedAt,
      },
    });
  }

  private async runFileWatch(
    event: Extract<GatewayServerEvent, { type: 'job.start' }>,
    settings: DesktopAgentSettings,
    timeoutMs: number,
  ): Promise<void> {
    const args = event.args as {
      path?: string;
      recursive?: boolean;
      intervalMs?: number;
      durationMs?: number;
      maxEvents?: number;
    };

    const targetPath = resolvePathInScope(args?.path || '.', settings);
    const targetStat = await fs.stat(targetPath);
    const recursive = Boolean(args?.recursive);
    const intervalMs = Math.min(Math.max(args?.intervalMs || 3000, 1000), 30000);
    const durationMs = Math.min(Math.max(args?.durationMs || timeoutMs, 1000), timeoutMs);
    const maxEvents = Math.min(Math.max(args?.maxEvents || 100, 1), 1000);
    const startedAt = Date.now();
    let eventsSent = 0;
    let previous = await collectFileWatchSnapshot(targetPath, targetStat.isDirectory(), recursive);

    this.send({
      type: 'job.progress',
      jobId: event.jobId,
      message: `Watching ${targetPath} every ${intervalMs}ms`,
    });

    while (
      !this.cancelledJobIds.has(event.jobId) &&
      eventsSent < maxEvents &&
      Date.now() - startedAt < durationMs
    ) {
      await sleep(intervalMs);
      if (this.cancelledJobIds.has(event.jobId)) return;

      const current = await collectFileWatchSnapshot(targetPath, targetStat.isDirectory(), recursive);
      const changes = diffFileWatchSnapshots(previous, current);
      previous = current;

      for (const change of changes) {
        if (this.cancelledJobIds.has(event.jobId) || eventsSent >= maxEvents) break;
        eventsSent += 1;
        this.send({
          type: 'job.file_event',
          jobId: event.jobId,
          event: change,
        });
        this.send({
          type: 'job.progress',
          jobId: event.jobId,
          message: `Detected ${change.action}: ${change.path}`,
        });
      }
    }

    if (this.cancelledJobIds.has(event.jobId)) return;

    this.sendJobResult({
      type: 'job.result',
      jobId: event.jobId,
      status: 'completed',
      result: {
        path: targetPath,
        recursive,
        eventsSent,
        intervalMs,
        durationMs: Date.now() - startedAt,
      },
    });
  }

  private async sendPostActionScreenshot(
    event: Extract<GatewayServerEvent, { type: 'job.start' }>,
    settings: DesktopAgentSettings,
  ): Promise<void> {
    const missingPermissions = await getMissingRunnablePermissions('screen.screenshot', settings);
    if (missingPermissions.length) {
      this.send({
        type: 'job.progress',
        jobId: event.jobId,
        message: `Skipped post-action screenshot; missing macOS permission: ${missingPermissions.join(', ')}`,
      });
      return;
    }

    const screenshot = await runCapability({
      jobId: event.jobId,
      tool: 'screen.screenshot',
      args: {},
      ownerUserId: event.ownerUserId,
      targetDeviceId: event.targetDeviceId,
      chatId: event.chatId,
    }, settings);

    if (!screenshot.ok) {
      this.send({
        type: 'job.progress',
        jobId: event.jobId,
        message: `Skipped post-action screenshot: ${screenshot.error || 'screenshot failed'}`,
      });
      return;
    }

    await this.sendScreenshotResult(event.jobId, screenshot.result);
  }

  private async sendScreenshotResult(jobId: string, result: unknown): Promise<void> {
    const screenshot = result as ScreenshotToolResult;
    if (screenshot.mimeType && screenshot.data) {
      const event: GatewayClientEvent = {
        type: 'job.screenshot',
        jobId,
        image: formatScreenshotImage(screenshot),
      };
      if (this.localJobIds.has(jobId)) {
        this.send(event);
        return;
      }
      if (isHttpGatewayURL(this.getSettings().gatewayUrl)) {
        await this.sendHttpEvent(event);
        return;
      }
      this.send(event);
    }
  }

  private requestInput(input: {
    jobId: string;
    kind: 'approval' | 'secret' | 'text';
    message: string;
    metadata?: Record<string, unknown>;
  }): Promise<PromptResponse> {
    const promptId = `prompt_${Date.now()}_${Math.random().toString(16).slice(2)}`;

    this.send({
      type: 'job.input_required',
      jobId: input.jobId,
      promptId,
      kind: input.kind,
      message: input.message,
      metadata: input.metadata,
    });

    return new Promise((resolve, reject) => {
      this.pendingPrompts.set(promptId, {
        jobId: input.jobId,
        resolve,
        reject,
      });
    });
  }

  private resolvePrompt(jobId: string, promptId: string, response: PromptResponse): void {
    const pending = this.pendingPrompts.get(promptId);
    if (!pending || pending.jobId !== jobId) {
      this.send({
        type: 'job.progress',
        jobId,
        message: `Ignored response for unknown prompt ${promptId}`,
      });
      return;
    }

    this.pendingPrompts.delete(promptId);
    pending.resolve(response || {});
  }

  private rejectPendingPromptsForJob(jobId: string, reason: string): void {
    for (const [promptId, pending] of this.pendingPrompts) {
      if (pending.jobId === jobId) {
        this.pendingPrompts.delete(promptId);
        pending.reject(new Error(reason));
      }
    }
  }

  private cancelJob(jobId: string, reason: string, notifyGateway: boolean): void {
    this.cancelledJobIds.add(jobId);
    this.rejectPendingPromptsForJob(jobId, reason);
    this.activeJobIds.delete(jobId);
    this.activeJobs.delete(jobId);

    if (notifyGateway) {
      this.sendJobResult({
        type: 'job.result',
        jobId,
        status: 'cancelled',
        error: reason,
      });
    }

    appendAuditEntry({
      deviceId: this.getSettings().deviceId,
      jobId,
      action: 'job.cancel',
      result: 'info',
      error: reason,
    });

    this.emitStatus();
  }

  private cancelInFlightJobs(reason: string, notifyGateway: boolean): void {
    const jobIds = [...this.activeJobIds];
    for (const jobId of jobIds) {
      this.cancelJob(jobId, reason, notifyGateway);
    }
  }

  private sendJobResult(result: JobResultEvent): void {
    this.rememberJobResult(result);
    this.send(result);
  }

  private rememberJobResult(result: JobResultEvent): void {
    this.pruneRecentJobResults();
    this.recentJobResults.set(result.jobId, {
      result,
      rememberedAt: Date.now(),
    });
  }

  private pruneRecentJobResults(): void {
    const cutoff = Date.now() - RECENT_JOB_TTL_MS;
    for (const [jobId, result] of this.recentJobResults) {
      if (result.rememberedAt < cutoff) {
        this.recentJobResults.delete(jobId);
      }
    }

    while (this.recentJobResults.size > MAX_RECENT_JOBS) {
      const first = this.recentJobResults.keys().next().value;
      if (!first) break;
      this.recentJobResults.delete(first);
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), 25000);
    this.sendHeartbeat();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private clearHttpPollTimer(): void {
    if (this.httpPollTimer) clearInterval(this.httpPollTimer);
    this.httpPollTimer = null;
    this.httpPollInFlight = false;
  }

  private sendHeartbeat(): void {
    this.lastHeartbeatAt = new Date().toISOString();
    this.send({
      type: 'heartbeat',
      deviceId: this.getSettings().deviceId,
      activeJobIds: [...this.activeJobIds],
      activeJobs: [...this.activeJobs.values()],
      capabilities: getCapabilityNames(),
      capabilityManifest: getCapabilityManifest(),
    });
    this.emitStatus();
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    const delay = Math.min(30000, 1000 * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.nextReconnectDelayMs = delay;
    this.nextReconnectAt = new Date(Date.now() + delay).toISOString();
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
    this.emitStatus();
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.nextReconnectAt = undefined;
    this.nextReconnectDelayMs = undefined;
  }

  private setStatus(status: AgentConnectionStatus): void {
    this.status = status;
    this.emitStatus();
  }

  private emitStatus(): void {
    for (const listener of this.listeners) listener();
  }

  private routeLocalClientEvent(event: GatewayClientEvent): boolean {
    if (!isJobScopedClientEvent(event) || !this.localJobIds.has(event.jobId)) return false;
    for (const listener of this.clientEventListeners) listener(event);
    return true;
  }
}

function isSyntheticPromptTool(tool: string): boolean {
  return ['agent.ask_user', 'agent.request_secret', 'agent.request_approval'].includes(tool);
}

function getAgentVersion(): string {
  return app?.getVersion?.() || 'development';
}

function isHttpGatewayURL(gatewayUrl: string): boolean {
  try {
    const parsed = new URL(gatewayUrl);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function getDesktopGatewayAPIURL(gatewayUrl: string, pathname: string): string {
  const parsed = new URL(gatewayUrl);
  return new URL(pathname, `${parsed.protocol}//${parsed.host}`).toString();
}

function mapHttpClientEvent(
  settings: DesktopAgentSettings,
  event: GatewayClientEvent,
): { path: string; body: Record<string, unknown> } | null {
  switch (event.type) {
    case 'heartbeat':
      return {
        path: `/api/desktop/devices/${encodeURIComponent(settings.deviceId || '')}/heartbeat`,
        body: {
          activeJobIds: event.activeJobIds,
          activeJobs: event.activeJobs || [],
          capabilities: {
            names: event.capabilities || [],
            tools: event.capabilityManifest || [],
          },
        },
      };
    case 'job.result':
      return {
        path: `/api/desktop/jobs/${encodeURIComponent(event.jobId)}/result`,
        body: {
          status: event.status,
          result: event.result,
          error: event.error,
        },
      };
    case 'job.progress':
      return {
        path: `/api/desktop/jobs/${encodeURIComponent(event.jobId)}/events`,
        body: {
          eventType: 'job.progress',
          payload: { message: event.message },
        },
      };
    case 'job.screenshot':
      return {
        path: `/api/desktop/jobs/${encodeURIComponent(event.jobId)}/events`,
        body: {
          eventType: 'job.screenshot',
          payload: { image: event.image },
        },
      };
    case 'job.file_event':
      return {
        path: `/api/desktop/jobs/${encodeURIComponent(event.jobId)}/events`,
        body: {
          eventType: 'job.file_event',
          payload: { event: event.event },
        },
      };
    case 'job.input_required':
      return {
        path: `/api/desktop/jobs/${encodeURIComponent(event.jobId)}/events`,
        body: {
          eventType: 'job.input_required',
          payload: {
            promptId: event.promptId,
            kind: event.kind,
            message: event.message,
            metadata: event.metadata || {},
          },
        },
      };
    case 'hello':
      return null;
  }
}

function isApprovalWorthyTool(tool: string): boolean {
  return (
    tool === 'shell.run' ||
    tool === 'apps.activate' ||
    tool === 'apps.quit' ||
    tool === 'files.write' ||
    tool === 'files.write_binary' ||
    tool === 'files.mkdir' ||
    tool === 'files.copy' ||
    tool === 'files.move' ||
    tool === 'files.delete' ||
    tool === 'files.open' ||
    tool === 'files.reveal' ||
    tool === 'files.watch' ||
    tool === 'screen.screenshot' ||
    tool === 'screen.stream' ||
    tool.startsWith('clipboard.') ||
    tool.startsWith('secrets.') ||
    tool.startsWith('input.') ||
    tool.startsWith('automation.')
  );
}

function getExpectedFrontmostApp(event: Extract<GatewayServerEvent, { type: 'job.start' }>): string | undefined {
  if (!event.tool.startsWith('input.')) return undefined;
  const args = event.args;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined;
  const expected = (args as { expectedFrontmostApp?: unknown }).expectedFrontmostApp;
  return typeof expected === 'string' && expected.trim() ? expected.trim() : undefined;
}

function normalizeAppName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\.app$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function getMissingRunnablePermissions(
  tool: string,
  settings: DesktopAgentSettings,
): Promise<string[]> {
  const capability = getCapabilityManifest().find((candidate) => candidate.name === tool);
  if (!capability || capability.requiredMacPermissions.length === 0) return [];

  const permissions = await getPermissionStatuses();
  const statusByName = new Map(permissions.map((permission) => [permission.name, permission.status]));
  const missing: string[] = [];

  for (const permission of capability.requiredMacPermissions) {
    if (permission === 'full_disk_access') {
      // Full Disk Access is not reliably introspectable and selected-folder mode does not require it.
      if (settings.fileAccessMode !== 'full_disk') continue;
      continue;
    }

    if (permission === 'automation') {
      // Automation is granted per target app and macOS does not expose one global status.
      continue;
    }

    if (permission === 'screen_recording') {
      // Electron/macOS screen capture status is not reliable enough to use as a
      // hard preflight gate across signed local builds. Let DesktopCapturer be
      // the authority: it either returns a real image or a concrete OS error.
      continue;
    }
    const status = statusByName.get(permission);
    if (status === 'denied' || status === 'not_determined') {
      missing.push(permission);
    }
  }

  return missing;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function summarizeArgs(args: unknown): unknown {
  if (!args || typeof args !== 'object') return args;

  const summary = { ...(args as Record<string, unknown>) };
  for (const key of Object.keys(summary)) {
    if (/password|secret|token|key/i.test(key)) {
      summary[key] = '[redacted]';
    }
    if (typeof summary[key] === 'string' && String(summary[key]).length > 300) {
      summary[key] = `${String(summary[key]).slice(0, 300)}...`;
    }
  }

  return summary;
}

function redactPromptResponse(response: PromptResponse): PromptResponse {
  if (response.secret) {
    return {
      ...response,
      secret: '[redacted]',
    };
  }

  return response;
}

function redactLargeScreenshot(result: unknown): unknown {
  if (!result || typeof result !== 'object') return result;

  const maybeScreenshot = result as { data?: unknown };
  if (typeof maybeScreenshot.data !== 'string') return result;

  return {
    ...maybeScreenshot,
    data: `[base64 omitted: ${maybeScreenshot.data.length} chars]`,
  };
}

interface ScreenshotToolResult {
  mimeType?: string;
  data?: string;
  width?: number;
  height?: number;
  format?: 'png' | 'jpeg';
  quality?: number;
  sourceId?: string;
  name?: string;
  sourceType?: 'screen' | 'window';
  displayId?: string;
  bounds?: { x: number; y: number; width: number; height: number };
  scaleFactor?: number;
}

function formatScreenshotImage(screenshot: ScreenshotToolResult): {
  mimeType: string;
  data: string;
  width?: number;
  height?: number;
  format?: 'png' | 'jpeg';
  quality?: number;
  sourceId?: string;
  name?: string;
  sourceType?: 'screen' | 'window';
  displayId?: string;
  bounds?: { x: number; y: number; width: number; height: number };
  scaleFactor?: number;
} {
  return {
    mimeType: screenshot.mimeType || 'image/png',
    data: screenshot.data || '',
    width: screenshot.width,
    height: screenshot.height,
    format: screenshot.format,
    quality: screenshot.quality,
    sourceId: screenshot.sourceId,
    name: screenshot.name,
    sourceType: screenshot.sourceType,
    displayId: screenshot.displayId,
    bounds: screenshot.bounds,
    scaleFactor: screenshot.scaleFactor,
  };
}

async function collectFileWatchSnapshot(
  targetPath: string,
  isDirectory: boolean,
  recursive: boolean,
): Promise<FileWatchSnapshot> {
  const snapshot: FileWatchSnapshot = new Map();

  if (!isDirectory) {
    await addFileWatchEntry(snapshot, targetPath);
    return snapshot;
  }

  await walkWatchDirectory(snapshot, targetPath, recursive);
  return snapshot;
}

async function walkWatchDirectory(
  snapshot: FileWatchSnapshot,
  directoryPath: string,
  recursive: boolean,
): Promise<void> {
  if (snapshot.size >= MAX_FILE_WATCH_ENTRIES) return;

  await addFileWatchEntry(snapshot, directoryPath);
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });

  for (const entry of entries) {
    if (snapshot.size >= MAX_FILE_WATCH_ENTRIES) return;
    const entryPath = path.join(directoryPath, entry.name);
    await addFileWatchEntry(snapshot, entryPath);

    if (recursive && entry.isDirectory()) {
      await walkWatchDirectory(snapshot, entryPath, recursive);
    }
  }
}

async function addFileWatchEntry(snapshot: FileWatchSnapshot, entryPath: string): Promise<void> {
  try {
    const stat = await fs.stat(entryPath);
    snapshot.set(entryPath, {
      type: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other',
      size: stat.isFile() ? stat.size : undefined,
      modifiedMs: stat.mtimeMs,
      modifiedAt: stat.mtime.toISOString(),
    });
  } catch {
    // A file can disappear while a snapshot is being collected; the next diff will reflect it.
  }
}

function diffFileWatchSnapshots(
  previous: FileWatchSnapshot,
  current: FileWatchSnapshot,
): Array<Extract<GatewayClientEvent, { type: 'job.file_event' }>['event']> {
  const changes: Array<Extract<GatewayClientEvent, { type: 'job.file_event' }>['event']> = [];

  for (const [entryPath, currentEntry] of current) {
    const previousEntry = previous.get(entryPath);
    if (!previousEntry) {
      changes.push(toFileWatchEvent('created', entryPath, currentEntry));
      continue;
    }

    if (
      currentEntry.type !== previousEntry.type ||
      currentEntry.size !== previousEntry.size ||
      currentEntry.modifiedMs !== previousEntry.modifiedMs
    ) {
      changes.push(toFileWatchEvent('modified', entryPath, currentEntry));
    }
  }

  for (const [entryPath, previousEntry] of previous) {
    if (!current.has(entryPath)) {
      changes.push(toFileWatchEvent('deleted', entryPath, previousEntry));
    }
  }

  return changes;
}

function toFileWatchEvent(
  action: 'created' | 'modified' | 'deleted',
  entryPath: string,
  entry: FileWatchSnapshot extends Map<string, infer T> ? T : never,
): Extract<GatewayClientEvent, { type: 'job.file_event' }>['event'] {
  return {
    action,
    path: entryPath,
    type: entry.type,
    size: entry.size,
    modifiedAt: entry.modifiedAt,
  };
}

function validateJobPolicy(policy: unknown): { ok: true } | { ok: false; error: string } {
  if (policy === undefined) return { ok: true };
  if (!isRecord(policy)) return { ok: false, error: 'job.start.policy must be an object' };

  const allowedKeys = new Set(['approvalMode', 'timeoutMs', 'screenshotAfterAction']);
  for (const key of Object.keys(policy)) {
    if (!allowedKeys.has(key)) {
      return { ok: false, error: `job.start.policy.${key} is not allowed` };
    }
  }

  if (
    policy.approvalMode !== undefined &&
    !['ask_every_time', 'session', 'device', 'always_for_owner'].includes(String(policy.approvalMode))
  ) {
    return { ok: false, error: 'job.start.policy.approvalMode must be a valid approval mode' };
  }

  if (
    policy.timeoutMs !== undefined &&
    (typeof policy.timeoutMs !== 'number' || !Number.isFinite(policy.timeoutMs) || policy.timeoutMs <= 0)
  ) {
    return { ok: false, error: 'job.start.policy.timeoutMs must be a positive number' };
  }

  if (
    policy.screenshotAfterAction !== undefined &&
    typeof policy.screenshotAfterAction !== 'boolean'
  ) {
    return { ok: false, error: 'job.start.policy.screenshotAfterAction must be a boolean' };
  }

  return { ok: true };
}

function validateJobScope(
  event: Record<string, unknown>,
  settings: DesktopAgentSettings,
): { ok: true } | { ok: false; error: string } {
  if (event.ownerUserId !== undefined && typeof event.ownerUserId !== 'string') {
    return { ok: false, error: 'job.start.ownerUserId must be a string' };
  }
  if (event.targetDeviceId !== undefined && typeof event.targetDeviceId !== 'string') {
    return { ok: false, error: 'job.start.targetDeviceId must be a string' };
  }
  if (event.chatId !== undefined && typeof event.chatId !== 'string') {
    return { ok: false, error: 'job.start.chatId must be a string' };
  }

  if (settings.ownerUserId) {
    if (event.ownerUserId === undefined || event.ownerUserId === '') {
      return { ok: false, error: 'job.start.ownerUserId is required for this desktop device owner' };
    }

    if (event.ownerUserId !== settings.ownerUserId) {
      return { ok: false, error: 'job.start.ownerUserId does not match this desktop device owner' };
    }
  }

  if (
    event.targetDeviceId &&
    settings.deviceId &&
    event.targetDeviceId !== settings.deviceId
  ) {
    return { ok: false, error: 'job.start.targetDeviceId does not match this desktop device' };
  }

  return { ok: true };
}

function validateConnectionReadiness(
  settings: DesktopAgentSettings,
): { ok: true } | { ok: false; error: string } {
  if (!settings.deviceId) {
    return { ok: false, error: 'Desktop agent is not paired to a deviceId' };
  }
  if (!settings.ownerUserId) {
    return { ok: false, error: 'Desktop agent is not paired to an ownerUserId' };
  }
  if (!settings.deviceToken) {
    return { ok: false, error: 'Desktop agent device token is missing from Keychain' };
  }
  return { ok: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isJobScopedClientEvent(event: GatewayClientEvent): event is GatewayClientEvent & { jobId: string } {
  return (
    Boolean(event && typeof event === 'object') &&
    'jobId' in event &&
    typeof (event as { jobId?: unknown }).jobId === 'string'
  );
}
