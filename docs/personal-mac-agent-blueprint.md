# Personal Mac Agent Blueprint

## Goal

Build a personal, always-on Mac agent for Josh's Client Intelligence account. The phone chat should be able to use the Mac Studio's local storage, apps, browser sessions, screen, keyboard, and mouse through the Client Intelligence desktop app.

The system should feel like the phone is an extension of the Mac:

- Send tasks from Client Intelligence chat on web or mobile.
- Route those tasks only to Josh's registered desktop app instances.
- Let the desktop app perform local actions on the Mac.
- Stream screenshots, progress, questions, approvals, and results back into the same chat.
- Keep the Mac reachable without opening inbound ports.
- Keep local execution controlled by the desktop app, not by arbitrary website code.

## Non-Goals For The First Version

- Platform-wide rollout for every Client Intelligence user.
- Multi-tenant admin UI.
- Unrestricted remote shell exposed directly to the chat backend.
- Full video-quality remote desktop as the first milestone.
- Silent macOS permission grants. macOS requires user approval for Accessibility, Screen Recording, Full Disk Access, and app automation.

## Architecture

```text
Phone / Web Chat
  <-> Client Intelligence API
  <-> Desktop Agent Gateway
  <-> outbound WebSocket from Mac Studio desktop app
  <-> local capability broker inside Electron main process
  <-> filesystem, browser, apps, screen, keyboard, mouse
```

The desktop app owns all local execution. The backend can ask the desktop app to run a known tool, but the backend should not receive raw unrestricted control of Node, `fs`, or `child_process`.

## Core Principle

Treat the desktop app as a trusted local broker.

Do this:

```text
chat intent -> backend authorization -> desktop job -> local tool validation -> local action -> result
```

Avoid this:

```text
remote page/backend -> arbitrary local code execution
```

## User Experience

### Device Pairing

1. Josh installs or opens Client Intelligence Desktop on the Mac Studio.
2. The desktop app detects the signed-in Client Intelligence session.
3. The app registers itself as a personal device, for example `Josh's Mac Studio`.
4. The backend issues a device-scoped token.
5. The desktop app stores that token in macOS Keychain.
6. Chat UI shows device status: `Mac Studio online`.

### Remote Task From Phone

```text
Josh:
"Use my Mac Studio and find the proposal I was working on yesterday."

Client Intelligence:
"Searching your Mac Studio..."

Mac Agent:
- searches approved folders or full disk, depending on permission settings
- returns candidate files
- asks follow-up questions if needed

Client Intelligence:
"I found three likely files. The newest is ... Want me to open it or summarize it?"
```

### Two-Way Control Loop

```text
Josh:
"Open Chrome on my Mac Studio and log into the vendor portal."

Agent:
"Chrome is open. I need the 2FA code."

Josh:
"482911"

Agent:
"Logged in. Here is what I see."
[screenshot]
```

### Approval Flow

```text
Agent:
"This requires Accessibility permission to click inside Chrome. Approve this action?"

Josh:
"Approve for this session."
```

Approval decisions should be explicit, scoped, and auditable.

## Main Components

### 1. Desktop Agent Runtime

Location: Electron main process in this repo.

Responsibilities:

- Maintain a persistent authenticated connection to Client Intelligence.
- Register the local device and advertise available capabilities.
- Receive jobs from the backend.
- Execute jobs through a local capability broker.
- Stream logs, screenshots, prompts, and final results back to the backend.
- Persist local agent settings.
- Reconnect after network failures, sleep/wake, app restart, and backend deploys.
- Launch at login when enabled.

Suggested modules:

```text
src/agent/connection.ts       WebSocket lifecycle, reconnect, heartbeat
src/agent/device.ts           device identity and registration
src/agent/jobs.ts             job dispatch, cancellation, timeout handling
src/agent/capabilities.ts     capability registry and permission checks
src/agent/audit.ts            local audit log
src/agent/settings.ts         local settings persistence
src/agent/keychain.ts         secure token storage
src/tools/files.ts            filesystem tools
src/tools/browser.ts          browser tools
src/tools/apps.ts             app open/activate tools
src/tools/screen.ts           screenshot/screen tools
src/tools/input.ts            mouse/keyboard tools
src/tools/secrets.ts          secret handoff tools
src/tools/shell.ts            optional guarded shell tools
```

### 2. Preload Bridge

Location: `src/preload.ts`.

Responsibilities:

- Expose a narrow desktop API to `clientintelligence.ai`.
- Let the web app display desktop status and request local setup flows.
- Never expose raw Node APIs.

Example shape:

```ts
window.clientIntelligenceDesktop = {
  platform: 'darwin',
  appVersion: '...',
  isDesktopApp: true,
  agent: {
    getStatus: () => Promise<AgentStatus>,
    getCapabilities: () => Promise<DesktopCapability[]>,
    getSetupChecklist: () => Promise<SetupChecklist>,
    connect: () => Promise<AgentStatus>,
    disconnect: () => Promise<AgentStatus>,
    pairPersonalDevice: (ownerUserId) => Promise<AgentStatus>,
    revokePersonalDevice: () => Promise<AgentStatus>,
    updateSettings: (patch) => Promise<AgentStatus>,
    chooseAllowedFolder: () => Promise<AgentStatus>,
    removeAllowedFolder: (folder) => Promise<AgentStatus>,
    clearAllowedFolders: () => Promise<AgentStatus>,
    openPermissionSettings: (permission) => Promise<boolean>,
    runLocalTool: (tool, args) => Promise<ToolResult>,
    getAudit: (limit) => Promise<AuditEntry[]>,
    getAuditInfo: () => Promise<AuditInfo>,
    clearAudit: () => Promise<AuditInfo>,
  },
};
```

### 3. Backend Desktop Agent Gateway

Location: Client Intelligence backend, not this Electron repo unless backend code is colocated elsewhere.

Responsibilities:

- Authenticate desktop devices.
- Maintain online device sessions.
- Route chat jobs to the correct device.
- Persist job state.
- Relay progress events from desktop to chat.
- Relay chat responses, approvals, and secrets from phone to desktop.
- Enforce that only Josh's account can control Josh's devices.

Suggested backend concepts:

```text
DesktopDevice
DesktopSession
DesktopJob
DesktopJobEvent
DesktopApproval
DesktopSecretExchange
```

### 4. Chat Tool Router

Location: Client Intelligence chat backend.

Responsibilities:

- Decide when a chat request needs the personal Mac.
- Select the target device.
- Create a desktop job.
- Stream desktop events into chat.
- Pause when the desktop asks for user input.
- Resume when Josh responds.
- Handle cancellation.

Example chat-visible tools:

```text
desktop.status
desktop.search_files
desktop.read_file
desktop.open_file
desktop.reveal_file
desktop.open_browser
desktop.open_app
desktop.read_clipboard
desktop.write_clipboard
desktop.screenshot
desktop.click
desktop.type_text
desktop.hotkey
desktop.press_key
desktop.ask_user
desktop.request_approval
desktop.request_secret
```

## Authentication And Pairing

### Personal-Only MVP

The first implementation can be hard-scoped to Josh's user ID.

Rules:

- Only Josh's authenticated Client Intelligence account can register devices.
- Only Josh's account can list, target, or control those devices.
- Device tokens are scoped to one device and one account.
- Device tokens are stored in macOS Keychain and loaded into memory only when needed for connect/revoke.
- Device tokens must not be persisted in local JSON settings.
- The backend can revoke any device token.

### Pairing Flow

1. Desktop app loads `https://clientintelligence.ai`.
2. User signs in normally.
3. Web app calls preload bridge: `agent.connect()`.
4. Web app calls preload bridge with a short-lived pairing proof from the current signed-in session.
5. Backend verifies the session belongs to Josh.
6. Backend returns a device token and device record.
7. Desktop app stores token in Keychain.
8. Desktop app opens WebSocket with device token.

### Token Types

```text
User session token
  Browser/web session. Used only to initiate pairing.

Device token
  Long-lived, revocable, scoped to one local desktop app install.

Job token
  Short-lived token or signed job envelope used for individual jobs.
```

## WebSocket Protocol

Use an outbound secure WebSocket from the desktop app:

```text
wss://clientintelligence.ai/api/desktop-agent/connect
```

### Desktop -> Backend Events

```json
{
  "type": "hello",
  "deviceId": "dev_...",
  "agentVersion": "1.0.0",
  "capabilities": ["files.read", "screen.screenshot", "input.click"]
}
```

```json
{
  "type": "heartbeat",
  "deviceId": "dev_...",
  "activeJobIds": ["job_..."]
}
```

```json
{
  "type": "job.progress",
  "jobId": "job_...",
  "message": "Opened Chrome"
}
```

```json
{
  "type": "job.screenshot",
  "jobId": "job_...",
  "image": {
    "mimeType": "image/jpeg",
    "data": "base64..."
  }
}
```

```json
{
  "type": "job.input_required",
  "jobId": "job_...",
  "promptId": "prompt_...",
  "kind": "approval",
  "message": "Approve clicking inside Chrome for this session?"
}
```

```json
{
  "type": "job.result",
  "jobId": "job_...",
  "status": "completed",
  "result": {}
}
```

### Backend -> Desktop Commands

```json
{
  "type": "job.start",
  "jobId": "job_...",
  "tool": "desktop.open_browser",
  "args": {
    "url": "https://example.com"
  },
  "policy": {
    "approvalMode": "session",
    "timeoutMs": 120000
  }
}
```

```json
{
  "type": "job.user_response",
  "jobId": "job_...",
  "promptId": "prompt_...",
  "response": {
    "approved": true,
    "scope": "session"
  }
}
```

```json
{
  "type": "job.cancel",
  "jobId": "job_...",
  "reason": "user_cancelled"
}
```

The desktop agent validates gateway event envelopes before execution. `job.start` requires a non-empty `jobId`, non-empty `tool`, and an object `policy` when supplied; `policy.approvalMode` must be one of the supported approval modes, and `policy.timeoutMs` must be a positive number. Malformed `job.start` messages that include a valid `jobId` are reported as failed `job.result` events. Malformed `job.cancel` and `job.user_response` messages are ignored with `job.progress` details so the chat surface can show why an action was not applied.

## Capability Model

Every tool needs:

- Name
- Description
- Required local macOS permission
- Required user policy permission
- Input schema
- Output schema
- Timeout
- Audit level
- Whether it can run unattended

The desktop app exposes a capability manifest through `window.clientIntelligenceDesktop.agent.getCapabilities()` and includes the same manifest in the WebSocket `hello` event. This gives the chat/router a single source of truth for available tools, risk level, macOS permission requirements, approval needs, unattended execution, input schema, and output schema.

Example:

```ts
type DesktopCapability = {
  name: string;
  description: string;
  risk: 'low' | 'medium' | 'high';
  requiredMacPermissions: MacPermission[];
  requiresApproval: boolean;
  canRunUnattended: boolean;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
};
```

### Initial Capabilities

| Capability | Purpose | macOS Permission |
| --- | --- | --- |
| `files.choose_folder` | Select allowed folders | User-selected file access |
| `files.stat` | Inspect file or folder metadata | Full Disk Access or scoped folder |
| `files.list` | List files in allowed scope | Full Disk Access or scoped folder |
| `files.search` | Search names/content | Full Disk Access or scoped folder |
| `files.read` | Read file content | Full Disk Access or scoped folder |
| `files.write` | Write files | Full Disk Access or scoped folder |
| `files.read_binary` | Download a binary file as base64 | Full Disk Access or scoped folder |
| `files.write_binary` | Upload/write base64 binary content | Full Disk Access or scoped folder |
| `browser.open_url` | Open URL in default browser | None |
| `apps.list` | List running local processes | None |
| `apps.frontmost` | Inspect current frontmost app and active window title | Accessibility |
| `apps.open` | Open local app | None |
| `apps.activate` | Bring app forward before remote input | Accessibility and approval |
| `apps.quit` | Quit local app by name/path/PID | Explicit high-risk approval |
| `system.info` | Inspect Mac CPU, memory, uptime, and OS info | None |
| `system.storage` | Inspect mounted volume storage capacity | None |
| `system.network` | Inspect local network interfaces and addresses | None |
| `screen.sources` | List available screen/window capture sources | Screen Recording |
| `screen.screenshot` | Capture screen | Screen Recording |
| `screen.stream` | Send repeated screenshots until duration, frame limit, or cancellation | Screen Recording |
| `input.click` | Click coordinates | Accessibility |
| `input.drag` | Drag between screen coordinates | Accessibility |
| `input.scroll` | Scroll focused app or screen coordinate | Accessibility |
| `input.type_text` | Type into focused app | Accessibility |
| `input.hotkey` | Send keyboard shortcuts | Accessibility |
| `input.press_key` | Press special keys like Return, Escape, Tab, arrows, Delete, and function keys | Accessibility |
| `automation.applescript` | Control apps | Automation and Accessibility |
| `shell.run` | Optional advanced local commands inside the configured file scope | Explicit high-risk approval |

All input tools can include optional `expectedFrontmostApp`. When present, the desktop verifies the current frontmost app before sending keyboard or mouse events and fails clearly if focus has drifted.

App path arguments for `apps.open`, `apps.activate`, and `apps.quit` are constrained to `.app` bundle paths. Opening arbitrary local documents or folders must go through scoped `files.open` so selected-folder/full-disk policy still applies.

`shell.run` is disabled by default. When enabled, it still follows the filesystem boundary: selected-folder mode defaults the working directory to the first allowed folder and rejects `cwd` values outside the allowed folders; full-disk mode may run from any valid directory. Commands must resolve to executable system binaries in `/usr/bin` or `/bin`; bare names are resolved only against those directories and never through ambient `PATH`, `cwd`, or user-controlled folders.

## Permission Modes

### Filesystem

```text
No access
Selected folders only
Full Disk Access
```

The recommended first setup for Josh's Mac Studio is Full Disk Access because the goal is to make the phone an extension of the computer. Still keep a visible local kill switch.

Selected-folder enforcement must canonicalize existing path prefixes before allowing access, so symlinks inside an allowed folder cannot be used to read or write blocked locations outside that folder.

### Computer Control

```text
View only
Open apps/browser
Screen snapshots
Keyboard/mouse control
AppleScript/app automation
Advanced shell
```

### Approval Modes

```text
Ask every time
Approve for this session
Approve for this device
Always allow for Josh's account
Disabled
```

For the personal MVP, `Always allow for Josh's account` applies only to non-approval-worthy/low-risk tools. Approval-worthy tools such as screenshots, input control, file writes, secrets, clipboard, app activation/quit, automation, and shell still require approval unless Josh has explicitly granted a valid session or device-scoped approval.

## macOS Permissions

The app should include setup checks and buttons that open the correct System Settings panes where possible.

Required permissions:

- Full Disk Access: broad filesystem access.
- Accessibility: keyboard, mouse, app activation, UI control.
- Screen Recording: screenshots and visual observation.
- Automation: Apple Events / AppleScript control of target apps.

Implementation notes:

- macOS does not allow the app to grant these silently.
- Permissions should be checked at startup and before each capability runs.
- If missing, the desktop agent should report a chat-visible blocked state with instructions.
- For unsigned development builds, permissions may reset when app identity changes.

## Security Requirements

### Account Scoping

- Hard-code or configure an allowlist for Josh's user ID during MVP.
- Reject pairing requests from any other account.
- Reject job requests unless `job.userId === device.ownerUserId`.

### Origin Scoping

The preload bridge should only serve trusted origins:

```text
https://clientintelligence.ai
https://www.clientintelligence.ai
```

The implemented desktop shell uses the same trusted-origin predicate for bridge IPC, permission checks, and main-window navigation. Production app origins must be HTTPS; local mock/dev origins may use plain HTTP only on loopback hosts such as `localhost`, `127.0.0.1`, or `[::1]`. Plain HTTP production URLs, `file:` URLs, JavaScript URLs, and lookalike hosts are rejected.

Gateway URL settings use the matching transport policy: production and non-local desktop-agent gateways must use `wss://`; plain `ws://` is accepted only for loopback local-development gateways such as `localhost`, `127.0.0.1`, or `[::1]`.

### Tool Validation

- Validate every command against schemas.
- Normalize and resolve file paths.
- Prevent path traversal outside allowed scopes when scoped mode is enabled.
- Redact secrets from logs.
- Set per-job and per-tool timeouts.
- Support cancellation.
- Persist device-scoped approvals only after Josh explicitly approves that scope.

### Secrets

Do not store passwords in normal chat transcripts.

Use a secure secret handoff:

1. Desktop asks for a secret.
2. Chat UI renders a secure input.
3. Backend relays encrypted or short-lived secret payload to the desktop.
4. Desktop uses the secret.
5. Secret is discarded unless Josh explicitly chooses to save it.
6. Saved secrets go to macOS Keychain, not local JSON files.

Current local saved-secret behavior uses named Keychain items scoped to the owner and desktop device. The supported tool path is `secrets.save`, `secrets.exists`, `secrets.delete`, and `secrets.fill_focused_field`. The desktop app does not expose a saved-secret readback tool; saved values can be filled into the focused Mac field, but are not returned through chat or gateway history.

2FA codes can be accepted as normal chat text if Josh chooses, but credentials and API keys should use the secure prompt.

### Audit Log

Store local audit entries in the desktop app data directory and optionally mirror metadata to the backend.

Audit entry fields:

```text
timestamp
deviceId
jobId
chatId
tool
target app/path/domain
approval source
result
error summary
```

Avoid storing full file contents, screenshots, passwords, or tokens in audit logs.

Current local audit behavior stores bounded JSONL metadata in the desktop app data directory. The audit module records device, owner, target-device, chat, job, tool, action, safe target, approval source, result, and error-summary metadata. Every approval response records an `approval.decision` audit entry with the selected one-time/session/device scope and allowed/denied result; device-scoped grants also record `approval.grant.device` after the local policy grant is persisted. Capability audit targets are intentionally narrow: file path, app name, input coordinate, secret name, source ID, command name, or URL origin. The audit layer omits file contents, screenshots, clipboard text, URL query strings, and raw secrets; it also redacts secret-like values in `target` and `error`, trims old entries after the configured maximum, and exposes trusted bridge controls for reading audit entries, reading audit file metadata, and clearing audit history. Trusted bridge audit reads normalize invalid limits, default to 100 entries, and cap reads at 500 entries. For local verification, `CI_DESKTOP_AGENT_AUDIT_PATH` and `CI_DESKTOP_AGENT_AUDIT_MAX_ENTRIES` can override the file path and retention limit.

## Reliability Requirements

### Desktop App

- Launch at login.
- Auto-reconnect WebSocket with exponential backoff.
- Detect sleep/wake and reconnect immediately on wake.
- Heartbeat every 20-30 seconds.
- Mark device offline if heartbeat misses exceed threshold.
- Persist queued job state for resumable jobs where safe.
- Cancel unsafe in-flight UI control jobs after disconnect.
- Keep local agent state separate from renderer state.

### Backend

- Persist job state.
- Make job events append-only.
- Support reconnect and resume by `lastEventId`.
- Enforce job timeout.
- Allow user cancellation from chat.
- Show clear device offline messaging.

### Chat UX

- Show `Mac Studio online/offline`.
- Show current active job.
- Stream progress messages.
- Render screenshots inline.
- Let Josh cancel a job.
- Let Josh approve, deny, or answer questions.
- Let Josh choose between available registered devices if more than one exists.

## Live Screen Strategy

Start with snapshot mode.

### Phase 1: Snapshot Mode

- Desktop captures screenshots on demand or every few seconds during active control.
- Screenshots are compressed JPEG/PNG and sent as job events.
- Chat displays the latest screenshot.
- User can ask follow-up instructions based on screenshots.

This is enough for most agent workflows and much simpler to ship.

### Phase 2: Live Mode

- Use WebRTC or a dedicated low-latency media channel.
- Stream screen frames to chat.
- Allow click/type events to return to desktop.
- Keep chat transcript as the command layer.

Live mode is more complex because it needs bandwidth management, frame pacing, and stronger safeguards.

## Implementation Phases

### Phase 0: Product And Security Decisions

Deliverables:

- Confirm Josh's Client Intelligence user ID.
- Decide initial allowed Mac device name.
- Decide default approval mode.
- Decide whether shell commands are included in MVP.
- Decide where backend code lives.

Recommended MVP settings:

```text
Owner: Josh only
Default file mode: Full Disk Access, if Josh grants it
Default control mode: Screen snapshots + app/browser open + keyboard/mouse
Shell: disabled until core flow is stable
Live video: deferred
```

### Phase 1: Desktop Capability Broker

Deliverables in this repo:

- Add `src/agent/*` modules.
- Add local settings store.
- Add local audit log.
- Add tool registry.
- Add file tools for selected folders.
- Add `shell.openExternal` browser URL tool.
- Add app open/activate tool.
- Add screenshot tool.
- Add permission status checks.
- Add preload API for status and setup.

Validation:

- `npm run build`
- Local manual test from renderer/preload bridge.
- Verify missing permission errors are clear.

### Phase 2: Device Pairing And WebSocket

Deliverables:

- Backend endpoint to create/revoke desktop device tokens.
- Backend WebSocket endpoint for desktop connections.
- Desktop device registration flow.
- Keychain token storage.
- Desktop connection lifecycle with heartbeat.
- Device online/offline status in chat.

Validation:

- Restart app and verify device reconnects.
- Sleep/wake Mac and verify reconnect.
- Revoke device token and verify disconnect.

### Phase 3: Chat Job Routing

Deliverables:

- Chat tool router creates desktop jobs.
- Backend sends jobs over WebSocket.
- Desktop executes jobs and streams events.
- Chat displays progress and final results.
- User can cancel jobs.

Validation:

- From phone/browser chat, ask desktop to open a URL.
- Ask desktop to search a selected folder.
- Ask desktop for a screenshot.
- Cancel an in-flight job.

### Phase 4: Two-Way Prompts And Approvals

Deliverables:

- `job.input_required` events.
- Approval buttons in chat.
- Secure secret input flow.
- Resume job after user response.
- Session-scoped approvals.

Validation:

- Desktop asks for 2FA code.
- Desktop asks for permission to use keyboard/mouse.
- Desktop receives approval from phone and continues.

### Phase 5: Keyboard, Mouse, And App Automation

Deliverables:

- Accessibility permission detection.
- Click tool.
- Type text tool.
- Hotkey tool.
- AppleScript automation tool for selected apps.
- Screenshot-after-action option.

Validation:

- Open Chrome, focus address bar, type URL, press Return.
- Capture screenshot after each action.
- Ask for user approval when target app changes.

### Phase 6: Full Disk And Advanced Local Work

Deliverables:

- Full Disk Access setup flow.
- Content search across approved scopes.
- File read/write/tail/watch with policy checks.
- Optional shell command capability behind explicit high-risk approval.
- File upload/download between Mac and chat.
- Scoped local file open/reveal actions from chat.

Validation:

- Search Documents/Desktop.
- Summarize a local file.
- Write a generated file to an approved folder.
- Confirm audit log entries.

### Phase 7: Live Screen Mode

Deliverables:

- WebRTC or low-latency stream transport.
- Live screenshot/frame viewer in chat.
- Pointer/click mapping from phone viewport to Mac coordinates.
- Bandwidth and frame-rate controls.
- Strong visible active-control state on the Mac.

Validation:

- View live Mac screen from phone.
- Click and type into a browser session.
- Recover after network drop.

## Suggested Backend Data Model

```ts
type DesktopDevice = {
  id: string;
  ownerUserId: string;
  displayName: string;
  platform: 'darwin';
  appVersion: string;
  capabilities: string[];
  status: 'online' | 'offline' | 'revoked';
  createdAt: string;
  lastSeenAt: string;
  revokedAt?: string;
};
```

```ts
type DesktopJob = {
  id: string;
  ownerUserId: string;
  deviceId: string;
  chatId: string;
  status: 'queued' | 'running' | 'waiting_for_user' | 'completed' | 'failed' | 'cancelled' | 'expired';
  tool: string;
  args: unknown;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  timeoutAt: string;
};
```

```ts
type DesktopJobEvent = {
  id: string;
  jobId: string;
  type: 'progress' | 'screenshot' | 'input_required' | 'result' | 'error';
  payload: unknown;
  createdAt: string;
};
```

## Suggested Desktop Settings Model

```ts
type DesktopAgentSettings = {
  deviceId?: string;
  displayName: string;
  launchAtLogin: boolean;
  enabled: boolean;
  ownerUserId?: string;
  fileAccessMode: 'none' | 'selected_folders' | 'full_disk';
  allowedFolders: string[];
  controlMode: 'disabled' | 'open_apps' | 'screen' | 'keyboard_mouse' | 'automation';
  approvalMode: 'ask_every_time' | 'session' | 'device' | 'always_for_owner';
  allowShell: boolean;
  deviceApprovalGrants: Array<{
    tool: string;
    scope: 'device';
    grantedAt: string;
  }>;
};
```

Store non-sensitive settings in `app.getPath('userData')`. Store tokens and saved credentials in macOS Keychain. Device approval grants are tool-specific local policy records, not backend-wide permissions.

## Desktop Repo Implementation Notes

Current state:

- `src/main.ts` creates the Electron window and enforces trusted navigation.
- `src/preload.ts` exposes basic app metadata and a trusted `clientIntelligenceDesktop.agent` bridge.
- `build/entitlements.mac.plist` already includes user-selected file read/write entitlement.
- `src/agent/*` contains the desktop agent runtime, settings, audit log, permission checks, WebSocket/HTTPS-polling connection, and IPC handlers.
- `src/tools/*` contains local capability implementations for files, browser/app control, screenshots, keyboard/mouse, Keychain-backed saved secrets, and guarded shell.
- `scripts/mock-agent-gateway.js` provides a local non-production WebSocket gateway for testing the phone/backend/device pattern without touching the live platform.
- Capability arguments are validated against the advertised manifest input schema before local or remote dispatch, including prompt and stream jobs.
- Local audit entries are bounded, redacted, include owner/chat/device scope and safe target metadata, and are manageable through the trusted desktop bridge; the mock chat includes show/clear audit controls when loaded inside the Electron app.
- Scoped folder access is manageable through the trusted desktop bridge with choose/remove/clear operations. The mock chat exposes folder setup controls and shortcuts to the macOS Full Disk Access, Accessibility, Screen Recording, and Automation settings panes. Permission shortcut inputs are runtime-validated against those known pane IDs before native System Settings URLs are opened.
- App control path arguments are constrained to `.app` bundles; scoped file/folder opening is handled by `files.open`.
- The trusted bridge `runLocalTool` path is limited to non-approval diagnostic/setup capabilities. Capabilities marked `requiresApproval: true` are denied and audited through the bridge and must be sent as desktop jobs so the normal approval prompt path can run.
- The trusted bridge `updateSettings` path can change local preferences, but cannot set paired `deviceId`, paired `ownerUserId`, `deviceApprovalGrants`, or add scoped `allowedFolders`; pair/revoke owns identity, explicit approval prompts own persistent approval grants, and folder expansion must go through `chooseAllowedFolder` so macOS presents the native folder picker.
- Desktop pairing fails closed by default: if the gateway does not return a real `deviceId`, `ownerUserId`, and `deviceToken`, or if the token cannot be saved to macOS Keychain, the app does not mark itself paired. Self-issued local tokens are allowed only with `CI_DESKTOP_AGENT_ALLOW_OFFLINE_PAIRING=1` for non-production verification.
- `pairPersonalDevice` accepts `{ ownerUserId, pairingToken }` for real setup. The pairing token is a short-lived proof from the trusted signed-in web session; the desktop sends it as `Authorization: Bearer <pairingToken>` to the pairing endpoint, does not serialize it into the JSON body, and does not persist it. The pairing body includes `{ capabilities: { tools: getCapabilityManifest() } }` so the backend can store and show the exact local desktop tool manifest before the first heartbeat. The local mock gateway can require this proof with `CI_DESKTOP_AGENT_REQUIRE_PAIRING_TOKEN=1`.
- Pairing or revoking a personal device clears persisted device approval grants, in-memory session approvals, and cached job results so stale grants cannot carry across device or owner identity changes.
- The desktop agent ignores duplicate active `job.start` deliveries and returns cached terminal results for recently completed duplicate jobs.
- Desktop status and mock gateway device state expose both `activeJobIds` and structured `activeJobs` with tool, owner/chat/device metadata, and start time so chat and local UI can show the current active job.
- Desktop status exposes `reconnectAttempt`, `nextReconnectAt`, and `nextReconnectDelayMs` so chat can show pending retry timing when the Mac is temporarily disconnected.
- When enabled, the desktop agent fails closed before opening a gateway transport unless it has a paired `deviceId`, paired `ownerUserId`, and a device token loaded from Keychain or legacy migration. Legacy plaintext tokens are stripped only after a successful Keychain migration; if migration fails, the token is not hydrated and the legacy value is left in place for a later retry.
- Production-style `https://` gateway URLs use bearer device-token HTTP polling: claim signed jobs and queued backend commands at `POST /api/desktop/devices/:deviceId/jobs/claim`, send heartbeat to `POST /api/desktop/devices/:deviceId/heartbeat`, post progress/screenshot/prompt/file events to `POST /api/desktop/jobs/:jobId/events`, and post terminal results to `POST /api/desktop/jobs/:jobId/result`. User/chat cancellation and prompt replies are queued through `POST /api/desktop/jobs/:jobId/cancel` and `POST /api/desktop/jobs/:jobId/prompts/:promptId/respond`, then delivered to the Mac as `job.cancel` and `job.user_response` commands during polling. The local mock gateway still uses `ws://127.0.0.1:47391/desktop-agent/connect`.
- The Client Intelligence backend branch registers owner-only Intelligence chat tools for paired Macs: `list_desktop_devices`, `run_desktop_capability`, `cancel_desktop_job`, and `respond_desktop_prompt`. These are account-level tools, not client-workspace tools, and team seats/platform admins are denied unless the actor is the account owner.
- On macOS sleep/suspend, the desktop cancels active jobs, reports a sleep cancellation when still connected, closes the transport, and stays enabled without scheduling reconnect backoff. On wake/resume, it clears pending backoff and reconnects immediately with a fresh socket; stale socket close/error handlers are ignored after a newer reconnect begins.
- The desktop shell includes a macOS tray/menu-bar item with connection status, active job count, explicit remote-control active/idle state, local kill switch, reconnect, revoke, and Full Disk Access, Accessibility, Screen Recording, and Automation permission shortcuts. Native notifications fire when remote control transitions from idle to active and back.
- Launch-at-login is exposed through desktop status, the setup checklist, and local mock chat setup controls so always-on readiness can be configured from the trusted chat surface.
- Remote jobs preflight macOS Accessibility and Screen Recording permissions and report missing permission failures back through chat-visible job progress/result events.
- Explicit disconnect/kill-switch and revoke paths cancel active jobs, reject pending prompts, report cancellation when connected, and do not schedule reconnect.
- Per-job timeouts cover local execution, approval prompts, synthetic chat prompts, screenshot streams, and backend-side running job enforcement. Timed-out prompts are removed from pending state so late chat responses are ignored.
- The mock gateway clears pending prompts when a job is cancelled, expires, or receives a terminal `job.result`; late phone responses to cleared prompt IDs are rejected.
- The mock gateway separates transient live payload delivery from stored history: screenshot previews and bounded live-only file previews/download links can render in live chat, but replay/state/persisted jobs redact secrets, file contents, screenshot data, and base64 payloads. Oversized live text previews are truncated and oversized binary previews omit downloadable base64.
- The mock gateway supports device-targeted jobs and routes starts, cancels, prompt responses, and queued replay only to the selected paired device. With `CI_DESKTOP_AGENT_REQUIRE_TARGET_DEVICE=1`, backend-style job creation may auto-route only when the owner has one non-revoked device; with multiple devices it rejects untargeted jobs and requires `deviceId`.
- The mock gateway accepts desktop-originated job events only from the device assigned to a non-terminal job. Unknown-job, wrong-device, or late terminal-job progress, prompt, screenshot, file, and result events are rejected before they can mutate job state, create pending prompts, or relay to chat.
- The mock gateway validates completed desktop `job.result` payloads against the assigned tool `outputSchema`; malformed result payloads are rejected as `agent.event.rejected` with `reason: "invalid_result"` and do not overwrite job state.
- Delivered `job.start` envelopes must include `ownerUserId`. A paired desktop rejects ownerless jobs and owner mismatches before execution. When `targetDeviceId` is present, it must match the paired desktop. Signed job payloads include owner, target-device, and chat metadata to prevent tampering.
- Mock gateway generated `jobId` values include timestamp and random entropy. Production backend job IDs must be globally unique and must not depend on millisecond timestamps alone.
- The local mock gateway can be locked to a single personal owner for non-production testing with `CI_DESKTOP_AGENT_ALLOWED_OWNER_USER_ID=<ownerUserId>`. When set, pairing and job creation for other owners are rejected and the mock chat defaults to that owner.
- The mock gateway marks online devices offline after missed heartbeats and emits owner-scoped `device.offline` events. The local timeout can be overridden with `CI_DESKTOP_AGENT_OFFLINE_TIMEOUT_MS`.
- The mock gateway enforces owner- and chat-scoped job controls in the local API model: cross-owner and cross-chat target, cancel, and prompt-response requests are rejected, unknown job cancellation is rejected, prompt responses must reference a currently pending prompt on the same job, and job/state/event APIs can be filtered by `ownerUserId` and `chatId`.
- The mock chat UI exposes owner, chat, and target-device controls, an operational desktop status dashboard, setup checklist, folder/permission shortcuts, audit controls, and first-class prompt cards for approvals, text responses, and secure secret input; it includes selected scope on commands, screenshot clicks, approvals, text/secret responses, and cancels, requests owner/chat-scoped gateway state, and resumes missed events after reconnect by sequence or stable event ID.
- The mock gateway exposes local saved-secret commands for save/check/fill/delete while redacting raw secret values from stored jobs and replayable state.
- Persisted mock gateway device-token lookup entries are stored as SHA-256 hashes, with legacy plaintext local state normalized on load.

Expected changes:

- Replace the mock gateway with the real Client Intelligence backend gateway in a non-production branch/environment.
- Port the local mock chat components for device status, screenshots, prompts, approval buttons, and secure secret input into the real Client Intelligence chat in a non-production branch/environment.
- Add production-grade backend persistence for devices, sessions, jobs, and job events.
- Prove and harden the macOS input automation library choice under signing and notarization.

Potential dependencies:

```text
ws                         WebSocket client/server support if backend needs Node ws
keytar                     macOS Keychain token storage
zod                        command schema validation
node-mac-permissions       permission checks, if compatible
```

Current implementation uses `ws`, macOS `security` CLI for Keychain storage, and a bounded polling watcher for `files.watch`. It does not require `keytar` or `chokidar` yet.

## Local Non-Production Test Flow

Run the mock gateway:

```bash
npm run agent:mock-gateway
```

This starts the local desktop gateway and a browser-based mock chat at:

```text
http://127.0.0.1:47391/
```

The local mock gateway intentionally mirrors the eventual backend shape without touching production:

```text
GET /api/state?ownerUserId=...&chatId=... Snapshot of devices, jobs, events, and pending prompts, optionally scoped to an owner/chat
GET /api/devices?ownerUserId=... Registered/connected local desktop agents, optionally scoped to an owner
GET /api/events?after=<seq>&ownerUserId=...&chatId=... Replay append-only events after a sequence cursor, optionally scoped to an owner/chat
GET /api/jobs?ownerUserId=...&chatId=...  Recent desktop jobs, optionally scoped to an owner/chat
POST /api/desktop/devices/pair Pair a local personal device and issue a mock token
POST /api/desktop/devices/:deviceId/revoke Revoke a device and invalidate its mock token
POST /api/jobs                 Create and relay a desktop job
POST /api/jobs/:jobId/cancel   Cancel a desktop job
POST /api/respond              Resume a waiting prompt with approval/text/secret input
WS /desktop-agent/connect      Desktop agent channel
WS /chat?ownerUserId=...&chatId=...&after=<seq>&lastEventId=<eventId> Mock chat event stream with owner/chat-scoped missed-event replay
```

Set `CI_DESKTOP_AGENT_ALLOWED_OWNER_USER_ID=<ownerUserId>` to make the mock gateway personal-only for local testing. This rejects pair and job requests for other owners while leaving multi-owner verification available when the variable is unset.

Set `CI_DESKTOP_AGENT_CHAT_API_TOKEN=<long-random-token>` when exposing the local mock gateway through a tunnel or reverse proxy for phone testing. The mock chat/control HTTP APIs require `Authorization: Bearer <token>`, and browser WebSocket clients pass the same token through the mock chat UI.

When `CI_DESKTOP_AGENT_REQUIRE_TOKEN=1`, the revoke endpoint requires `Authorization: Bearer <deviceToken>` and rejects tokens that do not belong to the `:deviceId` being revoked.

Set `CI_DESKTOP_AGENT_REQUIRE_TARGET_DEVICE=1` to make untargeted owner-scoped jobs fail when that owner has more than one non-revoked device. This mirrors the production chat requirement to pick a registered Mac before sending control jobs.

`POST /api/jobs` accepts command text for local mock chat ergonomics and structured `{ tool, args, policy }` jobs for backend-style callers. Structured jobs are rejected before persistence or delivery unless the tool is in the generated desktop capability contract, `args` is an object that validates against the tool `inputSchema`, and `policy` contains only supported `approvalMode`, `timeoutMs`, and `screenshotAfterAction` fields.

Remote `job.start` envelopes support short-lived HMAC-SHA256 signatures. The local mock gateway signs live and queued job delivery with a key derived from the paired device token hash, and the desktop rejects ownerless, unsigned, expired, future-dated, tampered, replayed, or owner/device-mismatched jobs when it has a signing secret. User-facing state and device APIs redact the token hash used for signing.

The generated backend/chat contract is `docs/desktop-agent-contract.json`. It is built from the actual desktop capability manifest and describes owner scope, gateway endpoints, client/server events, job policy, redaction rules, mock commands, and tool schemas. Regenerate it with `npm run agent:generate-contract`; `npm run agent:verify` checks that it has not drifted.

Run the desktop app in a second terminal:

```bash
npm run dev
```

To load the mock chat UI inside the Electron wrapper instead of the production Client Intelligence app, run:

```bash
CI_DESKTOP_APP_URL=http://127.0.0.1:47391 npm run dev
```

From the trusted Client Intelligence web context inside the desktop app, pair and connect the local personal device:

```js
await window.clientIntelligenceDesktop.agent.pairPersonalDevice('josh-local');
await window.clientIntelligenceDesktop.agent.updateSettings({
  fileAccessMode: 'selected_folders',
  allowedFolders: ['/Users/joshfortims/Desktop'],
  controlMode: 'screen'
});
```

Then use the mock gateway terminal:

```text
open https://clientintelligence.ai
open-browser chrome :: https://clientintelligence.ai
chrome https://clientintelligence.ai
safari https://clientintelligence.ai
screenshot
screenshot-jpeg 70 1440 900
screenshot-source window:123 1440 900 jpeg 70
sources
windows
stream 15 3000
stream-jpeg 15 3000 65
stream-source window:123 15 3000 jpeg 65
applescript return "ok"
apps
frontmost
activate-app Google Chrome
quit-app TextEdit
sysinfo
storage /
network
network-all
clip-read
clip-write Text to place on the Mac clipboard
stat /Users/joshfortims/Desktop/proposal.pdf
list /Users/joshfortims/Desktop
tail /Users/joshfortims/Desktop/agent.log :: 50
watch /Users/joshfortims/Desktop/Inbox :: 60 :: 3000
download /Users/joshfortims/Desktop/proposal.pdf
upload /Users/joshfortims/Desktop/agent-note.txt :: SGVsbG8=
mkdir /Users/joshfortims/Desktop/CI
copy /Users/joshfortims/Desktop/source.txt :: /Users/joshfortims/Desktop/CI/source.txt
move /Users/joshfortims/Desktop/CI/source.txt :: /Users/joshfortims/Desktop/CI/final.txt
delete /Users/joshfortims/Desktop/CI/final.txt
file-open /Users/joshfortims/Desktop/proposal.pdf
reveal /Users/joshfortims/Desktop/proposal.pdf
search /Users/joshfortims/Desktop :: proposal
click 800 500 right 1
click-in Google Chrome :: 800 500 left 1
click-snap 800 500 left 1
click-snap-in Google Chrome :: 800 500 left 1
drag 200 500 200 200 350
drag-in Google Chrome :: 200 500 200 200 350
drag-snap 200 500 200 200 350
drag-snap-in Google Chrome :: 200 500 200 200 350
scroll -900 0 800 500
scroll-in Google Chrome :: -900 0 800 500
scroll-snap -900 0 800 500
scroll-snap-in Google Chrome :: -900 0 800 500
type hello from the Mac
type-in Google Chrome :: hello from the Mac
hotkey l command
hotkey-in Google Chrome :: l command
press return
press-in Google Chrome :: return
press escape
secret-save login :: one-time-password
secret-exists login
secret-fill login
secret-delete login
ask What should I do next?
secret Enter the one-time code
approval Approve this action?
```

This exercises the full local relay path without pushing to or modifying the live Client Intelligence platform.

The mock chat UI renders `job.input_required` events with approval buttons, text inputs, and password-style secret inputs, then sends `job.user_response` back to the desktop agent.

Screenshots rendered in the mock chat are actionable. The page maps the clicked display position back to Mac screen coordinates with screenshot bounds metadata when available, then submits an `input.click` job. `windows` returns selectable screen/window source IDs, and the mock chat renders quick actions for source-targeted JPEG screenshots or streams; `screenshot-source` or `stream-source` can target one of those IDs from the command line. JPEG screenshot and stream commands are available for lower-bandwidth phone control. The mock gateway also accepts direct click, drag, and scroll commands plus snap variants that request a fresh screenshot after a successful action, which is the local test path for phone tap-to-control and gesture feedback behavior.

If a desktop job is created while no agent is connected, the mock gateway stores it as `queued`. When a paired agent reconnects and sends `hello`, non-expired queued jobs are replayed to that agent, marked `running`, and given a delivery attempt count. Queued jobs expire at `createdAt + policy.timeoutMs`; expired jobs emit `job.expired`, stay terminal, and are not delivered after reconnect. If Josh cancels a queued job from chat before the Mac reconnects, it becomes terminal `cancelled` and is not replayed later.

Delivered jobs also have a gateway-side timeout. If a `running` or `waiting_for_user` job exceeds `startedAt + policy.timeoutMs` without a terminal desktop result, the mock gateway marks it terminal `expired`, clears pending prompts, emits `job.expired`, and sends `job.cancel` with `reason: "backend_timeout"` to the assigned desktop. Late desktop events for expired/cancelled/completed jobs are rejected and do not overwrite terminal state.

Set `CI_DESKTOP_AGENT_STATE_PATH=/absolute/path/to/state.json` to make the local mock gateway persist devices, mock tokens, jobs, and events across process restarts. Non-terminal jobs restore as `queued`; paired/online devices restore as `offline`; revoked devices stay revoked.

Events include a stable `id` and monotonically increasing `seq`. Chat clients can reconnect and call `GET /api/events?after=<seq>` or `GET /api/events?lastEventId=<eventId>` to replay missed gateway, device, job, prompt, and screenshot events. Replay responses include `replayFromSeq`, `firstSeq`, `retainedEventCount`, `maxRetainedEvents`, and `replayTruncated` so a phone client can detect stale cursors whose older events have fallen out of the retention window. The mock chat WebSocket also supports direct resume with `WS /chat?ownerUserId=<owner>&after=<lastSeq>&lastEventId=<eventId>` so a phone-like chat client receives missed owner-scoped events before live updates continue.

Run local verification:

```bash
npm run agent:verify
```

Verification currently covers:

- TypeScript compile.
- Mock device pairing endpoint returns a device ID and token.
- Token-authenticated agent connection marks the paired device online.
- Heartbeat timeout verification confirms the mock gateway marks stale connected devices offline and emits `device.offline`.
- Settings security verification confirms device tokens are stripped from local settings JSON while legacy settings tokens remain available for Keychain migration.
- Pairing security verification confirms failed legacy token migration does not hydrate an in-memory token and does not remove the only legacy token copy before a future retry can move it into Keychain.
- Agent lifecycle verification confirms enabled startup fails closed without paired device ID, paired owner ID, or device token instead of opening an unauthenticated gateway socket.
- Audit security verification confirms local audit retention, clear behavior, bounded audit read limits, owner/chat/device scoped metadata, safe file and URL-origin targets, omission of file contents and URL query tokens, and redaction of token/password/bearer-shaped values.
- Device revocation invalidates the token, closes the active socket, and rejects reconnect.
- Local file write/list/read/search inside an allowed folder.
- Local file metadata and binary base64 read/write inside an allowed folder.
- Scoped file management verification covers directory creation, copy, move, file delete, recursive directory delete, and denial outside allowed folders.
- Keychain-backed saved secret save/check/delete on macOS without returning raw secret values in tool results.
- Device-scoped approval policy creation, reuse, scope defaults, and settings normalization.
- Approval policy verification confirms `always_for_owner` skips prompts only for low-risk tools and still prompts for approval-worthy tools.
- Agent lifecycle verification confirms allowed and denied approval responses write scoped audit entries and denied approvals prevent local tool execution.
- Denial for file access outside the allowed folder.
- Mock gateway startup.
- WebSocket job relay to a fake desktop agent.
- Multi-device routing verification confirms a job targeted to one paired device is not delivered to another connected paired device.
- Agent event authorization verification confirms a desktop cannot report results for a job assigned to another paired device.
- Multi-owner and multi-chat verification confirms one owner/chat cannot target, cancel, or respond to another owner/chat desktop job.
- Mock gateway verification confirms unknown cancellation is rejected, cancelled queued jobs do not replay after reconnect, and prompt responses are accepted only for pending prompts attached to the same job.
- Mock gateway verification confirms job cancellation and terminal job results clear pending prompts so late phone responses are rejected.
- Desktop lifecycle verification confirms ownerless jobs and owner/device metadata mismatches are rejected before local execution.
- Mock gateway verification confirms the optional personal owner lock rejects pairing and jobs for other owners and defaults unscoped local jobs to the configured owner.
- Mock gateway verification confirms optional mock chat API bearer-token auth rejects unauthenticated state/job/WebSocket control requests and accepts valid tokens for phone/tunnel testing.
- Origin security verification confirms desktop bridge/navigation trust is limited to HTTPS app hosts and loopback local-development origins, rejects plain HTTP production URLs, file URLs, JavaScript URLs, and lookalike hosts, and enforces `wss://` for non-local gateway URLs.
- Bridge security verification confirms trusted `runLocalTool` allows non-approval diagnostic tools but denies and audits approval-required capabilities before dispatch, confirms `updateSettings` cannot forge paired identity, persistent approval grants, scoped folder grants, or insecure production gateway URLs, confirms unknown permission shortcuts are rejected before opening native settings, confirms the native picker path can add selected folders, and confirms pair/revoke clears stale device approval grants.
- Pairing security verification confirms the pairing proof is sent as an authorization bearer token and not serialized into the JSON body, confirms failed gateway pairing and failed Keychain token persistence do not persist a fake device identity, confirms failed legacy token migration leaves the legacy token available for retry, writes denied audit entries, and permits self-issued local pairing only when `CI_DESKTOP_AGENT_ALLOW_OFFLINE_PAIRING=1`.
- Owner/chat-scoped state/event verification confirms one owner/chat cannot view another owner's or chat's jobs and replayable event history through scoped APIs.
- Chat reconnect verification confirms a phone-like chat socket can resume missed owner/chat-scoped events by sequence cursor or stable event ID, reports stale-cursor truncation metadata, and does not receive another owner's live job events.
- Mock chat setup verification confirms folder setup, launch-at-login setup, readiness checklist, and macOS permission shortcut controls are exposed through the trusted desktop bridge.
- Mock chat UI verification confirms owner/chat/device targeting controls are present and wired into job, cancel, and response requests.
- Mock chat UI verification confirms desktop status cards summarize connection, reconnect timing, active jobs, setup, and macOS permission readiness.
- Mock chat UI verification confirms first-class prompt cards exist for approvals, text responses, secure secret input, and resolved prompt state.
- Prompt relay to a fake chat client.
- Approval response relay back to the fake desktop agent.
- Gateway state API includes created jobs.
- Job cancellation relays to the fake desktop agent.
- Agent lifecycle verification covers kill-switch cancellation of an active prompt job and confirms explicit disconnect does not reconnect.
- Agent lifecycle and mock gateway verification cover structured active job status while work is running, confirm active job summaries clear after cancellation or empty heartbeats, and confirm gateway state sanitizes arbitrary heartbeat fields.
- Agent lifecycle verification covers reconnect retry status after an unexpected socket close and confirms the retry fields clear after reconnect.
- Agent lifecycle verification covers duplicate active jobs and cached terminal results for recently completed duplicate jobs.
- Agent lifecycle verification covers malformed gateway event envelopes for start, cancel, response, and policy validation.
- Agent lifecycle verification covers required signed job envelopes, valid signatures, expired/future-dated signatures, tampered signature rejection, replayed nonce rejection, and cached duplicate-job retries with fresh signatures.
- Agent lifecycle verification covers prompt job timeout cleanup and stale response rejection.
- Mock stream and source-targeted stream commands relay as `screen.stream` jobs.
- Mock `sources`, `windows`, and source-targeted screenshot commands relay to `screen.sources`/`screen.screenshot` for screen/window source selection.
- Mock chat UI verification confirms `screen.sources` results render source quick actions for source-targeted screenshots and streams.
- Screenshot dimensions relay through `job.screenshot`.
- Screenshot source metadata, encoding metadata, and screen bounds relay through `job.screenshot` so chat can map phone taps back to Mac coordinates and tune bandwidth with JPEG quality.
- Structured and command-style `input.click` jobs relay to the desktop agent with valid policy fields, mouse button, click-count, and optional screenshot-after-action support.
- Mock `drag`, `scroll`, and snap commands relay to approval-gated Accessibility input tools for phone-like gesture control and post-action screen feedback.
- Input jobs can include `expectedFrontmostApp`; the desktop verifies the current frontmost app before sending keyboard or mouse events and fails clearly if focus has drifted.
- Mock `click-in`, `drag-in`, `scroll-in`, `type-in`, `hotkey-in`, and `press-in` commands relay guarded input jobs with `expectedFrontmostApp`; snap-in variants also preserve post-action screenshot feedback.
- Mock `press` commands relay to approval-gated `input.press_key` for Return, Escape, Tab, arrow, Delete, and function-key control.
- Local tool verification covers unsupported mouse buttons, keyboard modifiers, and special keys returning structured tool failures instead of uncaught input automation exceptions.
- Mock `apps`, `frontmost`, `activate-app`, and `quit-app` commands relay to app list, target-app inspection, approval-gated app activation, and approval-gated app quit tools.
- Local tool verification confirms app-control path arguments reject non-`.app` paths so `apps.open` cannot bypass scoped `files.open`.
- Mock `open-browser`, `chrome`, and `safari` commands relay to browser-targeted URL opening for known local browser sessions.
- Mock `sysinfo` and `storage` commands relay to read-only system status tools.
- Mock `network` and `network-all` commands relay to read-only local network status tools.
- Mock `clip-read` and `clip-write` commands relay to approval-gated clipboard tools, and stored job history redacts clipboard write text.
- Mock gateway verification rejects unknown structured tools, non-object args, invalid capability schema values, missing required capability args, unknown capability args, invalid policy values, and unsupported policy fields.
- Mock gateway verification rejects completed desktop result payloads that violate the assigned tool output schema, including wrong property types and unexpected raw payload fields.
- Mock `stat`, `tail`, `watch`, `download`, and `upload` commands relay to `files.stat`, `files.tail`, `files.watch`, `files.read_binary`, and `files.write_binary`.
- Agent lifecycle verification covers a real scoped `files.watch` job emitting a structured `job.file_event`.
- Mock `mkdir`, `copy`, `move`, `delete`, and `delete-recursive` commands relay to scoped file management tools.
- Mock `file-open` and `reveal` commands relay to scoped local file open/reveal tools.
- Mock `secret-save`, `secret-exists`, `secret-fill`, and `secret-delete` commands relay to the saved-secret tools and redact raw saved secret values from job history APIs.
- Guarded `automation.applescript` jobs relay and execute when automation mode is enabled.
- Offline jobs are queued and replayed when the desktop agent reconnects, unless they expire or are cancelled before delivery.
- Queued job expiration verification confirms stale offline jobs become terminal `expired` records, emit `job.expired`, and are not delivered after reconnect.
- Running job expiration verification confirms hung delivered jobs become terminal `expired`, send backend timeout cancellation to the desktop, clear prompt state, emit `job.expired`, and reject late desktop results.
- Queued jobs retain their target device and only replay to the matching device connection.
- Optional mock gateway state persistence restores devices, mock tokens, queued jobs, and recent events after restart.
- Mock gateway persistence verification confirms issued mock device tokens are not stored in plaintext and token lookup entries use SHA-256 hashes.
- Event replay uses a persisted sequence cursor and returns events after `after=<seq>`.
- Mock gateway verification confirms live screenshot and file previews are transient, while event replay/state/jobs APIs redact screenshot data, secrets, file text, and base64 payloads.
- Mock gateway verification confirms oversized live text file previews are capped and marked truncated while replayable state continues to omit raw file content.
- Capability manifest verification ensures every advertised desktop tool has metadata plus input and output schemas.
- Capability schema verification covers valid, missing, mistyped, unknown, and URL-format input validation, plus output schema presence for normal tools, stream tools, file reads, screenshots, and redacted secret prompts; lifecycle verification covers remote prompt validation failure.
- Contract verification ensures `docs/desktop-agent-contract.json` stays synced with the desktop capability manifest and protocol surface.
- TypeScript compilation and packaging preflight cover the app menu, tray/menu-bar kill switch wiring, native permission shortcuts, and visible active-control indicator.
- Packaging preflight verification covers macOS privacy strings for screen capture, accessibility, and Apple Events, entitlements, hardened runtime/notarization settings, and the guarded Developer ID build script without signing or publishing.
- Permission preflight compiles through the same remote job execution path and is covered by the full TypeScript build.

Automation options need a proof-of-concept before choosing:

```text
AppleScript via osascript
Electron desktopCapturer for screenshots
Native helper for CGEvent keyboard/mouse control
robotjs or nut.js if compatible with signing/notarization
```

## Backend API Sketch

```http
POST /api/desktop/devices/pair
Authorization: user session
```

Returns:

```json
{
  "deviceId": "dev_...",
  "deviceToken": "secret...",
  "ownerUserId": "user_josh"
}
```

```http
GET /api/desktop/devices
Authorization: user session
```

Returns Josh's registered devices.

```http
POST /api/desktop/devices/:deviceId/revoke
Authorization: user session or device bearer token
```

Revokes only a device owned by Josh. Device-originated revoke calls must prove possession of that device's token.

```http
POST /api/desktop/jobs
Authorization: user session
```

Creates a job for a device.

```http
POST /api/desktop/jobs/:jobId/cancel
Authorization: user session
```

Cancels a job.

```http
POST /api/desktop/jobs/:jobId/respond
Authorization: user session
```

Sends approval, answer, or secret response to a waiting job.

```http
WS /api/desktop-agent/connect
Authorization: device token
```

Persistent desktop connection.

## Testing Plan

### Unit Tests

- Path scope validation.
- Tool schema validation.
- Device/job authorization.
- Approval policy decisions.
- Event serialization.

### Integration Tests

- Pair device.
- Connect WebSocket.
- Send job.
- Receive progress.
- Complete job.
- Cancel job.
- Reconnect and resume.

### Manual macOS Tests

- Fresh install.
- Grant Full Disk Access.
- Grant Accessibility.
- Grant Screen Recording.
- Launch at login.
- Sleep/wake reconnect.
- Restart app reconnect.
- Restart backend reconnect.
- Revoke device token.
- Uninstall/reinstall behavior.

### Phone Tests

- Start job from mobile chat.
- Receive screenshot.
- Approve action.
- Provide 2FA code.
- Cancel job.
- Continue after temporary phone disconnect.

## Failure States

| Failure | Expected Behavior |
| --- | --- |
| Mac offline | Chat says device is offline and can queue or retry later |
| Missing permission | Chat explains required permission and desktop shows setup prompt |
| Job timeout | Desktop stops action and reports timeout |
| Backend reconnect | Desktop reconnects and resumes safe jobs |
| User cancels | Desktop stops action and confirms cancellation |
| Token revoked | Desktop disconnects and requires re-pairing |
| Unsafe file path | Desktop rejects request before touching filesystem |
| Secret requested | Chat uses secure input, not normal transcript storage |

## Rollout Checklist

- Josh-only account gate is enabled.
- Device token revocation works.
- Local kill switch works.
- Desktop status is visible in chat.
- macOS permissions are documented in-app.
- Audit log records local actions.
- Screenshots are not stored longer than needed.
- Secret prompts do not persist credentials in transcript.
- App auto-starts at login.
- WebSocket reconnect works after sleep/wake.
- Build is signed and notarized.

## Open Decisions

1. Should shell commands be available in the MVP, or only after file/app/screen control is stable?
2. Should Full Disk Access be the default recommendation, or should the first build start with selected folders?
3. Should screenshots be stored in backend job history or only streamed transiently?
4. Which backend repository owns the Desktop Agent Gateway?
5. Which macOS input automation library is most reliable with signing and notarization?
6. Should the Mac show a persistent visible indicator while remote control is active?
7. Should the app support multiple personal Macs immediately, or only one Mac Studio for MVP?

## Recommended First Build Slice

Build the smallest end-to-end path:

1. Pair desktop app to Josh's account.
2. Show `Mac Studio online` in chat.
3. From phone chat, send a job to open a URL on the Mac.
4. Desktop app opens the URL.
5. Desktop app sends a screenshot back to chat.
6. Chat displays the screenshot.
7. User can cancel the job.

After this works, add file search/read, then keyboard/mouse, then secure prompts, then live mode.
