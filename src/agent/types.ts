export type FileAccessMode = 'none' | 'selected_folders' | 'full_disk';
export type ControlMode = 'disabled' | 'open_apps' | 'screen' | 'keyboard_mouse' | 'automation';
export type ApprovalMode = 'ask_every_time' | 'session' | 'device' | 'always_for_owner';
export type AgentConnectionStatus = 'disabled' | 'disconnected' | 'connecting' | 'connected' | 'error';

export type MacPermissionName =
  | 'full_disk_access'
  | 'accessibility'
  | 'screen_recording'
  | 'automation';

export interface DesktopAgentSettings {
  deviceId?: string;
  displayName: string;
  launchAtLogin: boolean;
  enabled: boolean;
  ownerUserId?: string;
  deviceToken?: string;
  jobSigningSecret?: string;
  gatewayUrl: string;
  fileAccessMode: FileAccessMode;
  allowedFolders: string[];
  controlMode: ControlMode;
  approvalMode: ApprovalMode;
  allowShell: boolean;
  deviceApprovalGrants: ApprovalGrant[];
}

export interface ApprovalGrant {
  tool: string;
  scope: 'device';
  grantedAt: string;
}

export interface PermissionStatus {
  name: MacPermissionName;
  status: 'granted' | 'denied' | 'not_determined' | 'unknown';
  detail?: string;
}

export interface DesktopCapability {
  name: string;
  description: string;
  risk: 'low' | 'medium' | 'high';
  requiredMacPermissions: MacPermissionName[];
  requiresApproval: boolean;
  canRunUnattended: boolean;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}

export interface AgentStatus {
  connection: AgentConnectionStatus;
  enabled: boolean;
  launchAtLogin: boolean;
  deviceId?: string;
  displayName: string;
  gatewayUrl: string;
  ownerUserId?: string;
  fileAccessMode: FileAccessMode;
  allowedFolders: string[];
  controlMode: ControlMode;
  approvalMode: ApprovalMode;
  allowShell: boolean;
  permissions: PermissionStatus[];
  lastError?: string;
  lastConnectedAt?: string;
  lastHeartbeatAt?: string;
  reconnectAttempt: number;
  nextReconnectAt?: string;
  nextReconnectDelayMs?: number;
  activeJobIds: string[];
  activeJobs: ActiveJobSummary[];
  capabilities: DesktopCapability[];
}

export interface ActiveJobSummary {
  jobId: string;
  tool: string;
  ownerUserId?: string;
  targetDeviceId?: string;
  chatId?: string;
  startedAt: string;
}

export interface SetupChecklistItem {
  id: string;
  label: string;
  status: 'ready' | 'needs_action' | 'disabled' | 'unknown';
  required: boolean;
  detail: string;
  action?: string;
}

export interface SetupChecklist {
  ready: boolean;
  generatedAt: string;
  items: SetupChecklistItem[];
}

export interface PairPersonalDeviceInput {
  ownerUserId?: string;
  pairingToken?: string;
}

export interface DesktopJob {
  jobId: string;
  tool: string;
  ownerUserId?: string;
  targetDeviceId?: string;
  chatId?: string;
  args?: unknown;
  policy?: {
    approvalMode?: ApprovalMode;
    timeoutMs?: number;
    screenshotAfterAction?: boolean;
  };
  signature?: JobSignature;
}

export interface LocalDesktopJobInput {
  tool: string;
  args?: unknown;
  policy?: DesktopJob['policy'];
}

export interface LocalDesktopJobEvent {
  timestamp: string;
  type: GatewayClientEvent['type'];
  message?: string;
  payload?: unknown;
}

export interface LocalDesktopJobPrompt {
  promptId: string;
  kind: 'approval' | 'secret' | 'text';
  message: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface LocalDesktopJobScreenshot {
  receivedAt: string;
  image: Extract<GatewayClientEvent, { type: 'job.screenshot' }>['image'];
}

export interface LocalDesktopJobRecord {
  jobId: string;
  tool: string;
  args?: unknown;
  policy?: DesktopJob['policy'];
  status: 'running' | 'waiting_for_input' | 'completed' | 'failed' | 'cancelled';
  createdAt: string;
  updatedAt: string;
  pendingPrompt?: LocalDesktopJobPrompt;
  events: LocalDesktopJobEvent[];
  screenshots: LocalDesktopJobScreenshot[];
  result?: unknown;
  error?: string;
}

export interface JobSignature {
  algorithm: 'hmac-sha256';
  signedAt: string;
  nonce: string;
  value: string;
}

export interface ToolRequest {
  jobId: string;
  tool: string;
  args: unknown;
  ownerUserId?: string;
  targetDeviceId?: string;
  chatId?: string;
}

export interface ToolResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface PromptResponse {
  approved?: boolean;
  scope?: 'once' | 'session' | 'device';
  value?: string;
  secret?: string;
  message?: string;
}

export interface AuditEntry {
  timestamp: string;
  deviceId?: string;
  jobId?: string;
  ownerUserId?: string;
  targetDeviceId?: string;
  chatId?: string;
  tool?: string;
  action: string;
  target?: string;
  approvalSource?: 'once' | 'session' | 'device' | 'policy' | 'none';
  result: 'allowed' | 'denied' | 'completed' | 'failed' | 'info';
  error?: string;
}

export interface AuditInfo {
  path: string;
  entries: number;
  bytes: number;
  maxEntries: number;
}

export interface SupportBundle {
  generatedAt: string;
  appVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  status: {
    connection: AgentConnectionStatus;
    enabled: boolean;
    launchAtLogin: boolean;
    deviceId?: string;
    displayName: string;
    gatewayUrl: string;
    ownerUserId?: string;
    fileAccessMode: FileAccessMode;
    allowedFolderCount: number;
    allowedFolders: string[];
    controlMode: ControlMode;
    approvalMode: ApprovalMode;
    allowShell: boolean;
    permissions: PermissionStatus[];
    lastError?: string;
    lastConnectedAt?: string;
    lastHeartbeatAt?: string;
    reconnectAttempt: number;
    nextReconnectAt?: string;
    nextReconnectDelayMs?: number;
    activeJobCount: number;
    activeJobs: Array<Pick<ActiveJobSummary, 'jobId' | 'tool' | 'startedAt'>>;
  };
  checklist: SetupChecklist;
  capabilities: {
    count: number;
    names: string[];
    approvalRequired: number;
    highRisk: number;
    canRunUnattended: number;
  };
  audit: {
    info: Omit<AuditInfo, 'path'> & { path: string };
    recent: AuditEntry[];
  };
  localJobs: Array<{
    jobId: string;
    tool: string;
    status: LocalDesktopJobRecord['status'];
    createdAt: string;
    updatedAt: string;
    eventCount: number;
    screenshotCount: number;
    hasPendingPrompt: boolean;
    error?: string;
  }>;
}

export type GatewayClientEvent =
  | {
      type: 'hello';
      deviceId?: string;
      displayName: string;
      agentVersion: string;
      capabilities: string[];
      capabilityManifest?: DesktopCapability[];
    }
  | {
      type: 'heartbeat';
      deviceId?: string;
      activeJobIds: string[];
      activeJobs?: ActiveJobSummary[];
      capabilities?: string[];
      capabilityManifest?: DesktopCapability[];
    }
  | {
      type: 'job.progress';
      jobId: string;
      message: string;
    }
  | {
      type: 'job.result';
      jobId: string;
      status: 'completed' | 'failed' | 'cancelled';
      result?: unknown;
      error?: string;
    }
  | {
      type: 'job.screenshot';
      jobId: string;
      image: {
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
      };
    }
  | {
      type: 'job.file_event';
      jobId: string;
      event: {
        action: 'created' | 'modified' | 'deleted';
        path: string;
        type: 'file' | 'directory' | 'other';
        size?: number;
        modifiedAt?: string;
      };
    }
  | {
      type: 'job.input_required';
      jobId: string;
      promptId: string;
      kind: 'approval' | 'secret' | 'text';
      message: string;
      metadata?: Record<string, unknown>;
    };

export type GatewayServerEvent =
  | {
      type: 'job.start';
      jobId: string;
      tool: string;
      ownerUserId?: string;
      targetDeviceId?: string;
      chatId?: string;
      args?: unknown;
      policy?: DesktopJob['policy'];
      signature?: JobSignature;
    }
  | {
      type: 'job.cancel';
      jobId: string;
      reason?: string;
    }
  | {
      type: 'job.user_response';
      jobId: string;
      promptId: string;
      response: unknown;
    }
  | {
      type: 'ping';
    };
