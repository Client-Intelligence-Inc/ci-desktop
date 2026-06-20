# Client Intelligence Desktop

Native macOS desktop app for [Client Intelligence](https://clientintelligence.ai). Wraps the web app in an Electron shell with native window management, dock integration, and auto-updates via GitHub Releases.

## Prerequisites

- Node.js 22.12+
- Apple Developer ID certificate installed in Keychain (for signing/notarizing)

## Development

```bash
npm install
npm run dev
```

## Build

```bash
npm run dist
```

Produces a signed `.dmg` in `release/`.

## Publish

```bash
npm run dist:publish
```

Builds the `.dmg` and uploads it to GitHub Releases. The app checks for updates from this release feed automatically.

## Icon Generation

```bash
npm run generate-icon
```

Generates `build/icon.png` and `build/icon.icns` from the programmatic icon script.

## Environment Variables for Signing & Notarization

| Variable | Description |
|---|---|
| `CSC_NAME` | Developer ID Application certificate name (or use `CSC_LINK` + `CSC_KEY_PASSWORD`) |
| `APPLE_KEYCHAIN_PROFILE` | Preferred notarization credential profile created with `xcrun notarytool store-credentials` |
| `APPLE_TEAM_ID` | Apple Developer Team ID, needed for Apple ID password notarization |
| `APPLE_ID` | Apple ID email for password-based notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password fallback; omit when using `APPLE_KEYCHAIN_PROFILE` |

## Auto-Update

The app checks GitHub Releases for updates on launch (after 10s delay) and every 4 hours. Updates download silently in the background. A native notification prompts the user to restart when ready.

## Personal Mac Agent

See [docs/personal-mac-agent-blueprint.md](docs/personal-mac-agent-blueprint.md) for the build plan to turn this desktop app into a personal always-on Mac agent that can be controlled from Client Intelligence chat.

Use [docs/staging-preview-runbook.md](docs/staging-preview-runbook.md) for the staging preview sequence that pairs this desktop app to a non-production Client Intelligence backend and verifies phone-width chat control.

The current desktop implementation includes a local capability broker, trusted preload API, WebSocket and HTTPS-polling agent transports, audit log, local settings, and a mock gateway for non-production testing.

```bash
npm run agent:mock-gateway
```

This starts both the mock desktop gateway and a local chat simulator at `http://127.0.0.1:47391/`.

To lock the non-production mock gateway to one personal account while testing, set:

```bash
CI_DESKTOP_AGENT_ALLOWED_OWNER_USER_ID=josh-local npm run agent:mock-gateway
```

When set, pairing and job creation for any other owner are rejected, and the mock chat defaults its owner field to the configured value.

If you expose the local mock gateway through a tunnel or reverse proxy for phone testing, also set `CI_DESKTOP_AGENT_CHAT_API_TOKEN=<long-random-token>`. The mock chat/control APIs and WebSocket will require that token, and the mock chat UI includes a local token field that stores it in browser local storage.

Then start the app in another terminal:

```bash
npm run dev
```

To load the mock chat UI inside the desktop wrapper instead of production, run:

```bash
CI_DESKTOP_APP_URL=http://127.0.0.1:47391 npm run dev
```

The desktop agent defaults to the local mock gateway at `ws://127.0.0.1:47391/desktop-agent/connect`. From the trusted web app context, setup can be driven through `window.clientIntelligenceDesktop.agent`.

Trusted desktop bridge and in-app navigation origins are limited to HTTPS app hosts plus explicitly configured loopback local-development hosts. Plain HTTP production URLs, `file:` URLs, JavaScript URLs, and lookalike hosts are rejected before they can use desktop-agent IPC.

Gateway URL settings follow the same local-vs-production split: secure `wss://` WebSocket or `https://` HTTP polling is required for non-local gateways, while plain `ws://` or `http://` is accepted only for loopback mock gateways such as `127.0.0.1`, `localhost`, or `[::1]`.

The trusted desktop bridge also exposes `window.clientIntelligenceDesktop.agent.getCapabilities()`, which returns the capability manifest used by the agent and sent in the WebSocket `hello` event. Each capability declares input and output schemas so backend/chat callers can validate tool args before delivery and render result payloads consistently. `getStatus()` includes both `activeJobIds` and structured `activeJobs` with the running tool, owner/chat/device scope, and start time. It also includes `reconnectAttempt`, `nextReconnectAt`, and `nextReconnectDelayMs` so chat can show pending retry timing when the Mac is temporarily disconnected. `getSetupChecklist()` returns a derived readiness checklist for pairing, connection, launch-at-login, file scope, screenshots, keyboard/mouse control, automation, and shell access.

The trusted bridge `runLocalTool` method is limited to non-approval diagnostic/setup capabilities. Capabilities marked `requiresApproval: true` in the manifest are denied and audited through the bridge; they must be sent as desktop jobs so the normal approval prompt path can run.

The trusted bridge `updateSettings` method can change local preferences, but it cannot set paired `deviceId`, paired `ownerUserId`, `deviceApprovalGrants`, or add scoped `allowedFolders`. Pair/revoke owns device identity, explicit approval prompts own persistent approval grants, and folder expansion must go through `chooseAllowedFolder` so macOS presents the native folder picker.

The mock chat supports command-style jobs:

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

The desktop file capability also supports metadata, tail reads, watch streams, binary transfer, scoped file management, and local open/reveal tools for backend/chat integration: `files.stat`, `files.tail`, `files.watch`, `files.read_binary`, `files.write_binary`, `files.mkdir`, `files.copy`, `files.move`, `files.delete`, `files.open`, and `files.reveal`. Mutating file tools, file watch streams, and local file open/reveal actions require approval and still enforce selected-folder or full-disk policy. Selected-folder checks canonicalize existing path prefixes so symlinks inside allowed folders cannot escape to blocked locations.

The desktop automation capability supports guarded AppleScript via `automation.applescript` when local `controlMode` is `automation`.

The optional shell capability runs only when `allowShell` is enabled, requires approval, and shares the filesystem boundary. In selected-folder mode, `shell.run` uses the first allowed folder as its default working directory and rejects caller-supplied `cwd` values outside the allowed folders. Commands must resolve to executable system binaries in `/usr/bin` or `/bin`; bare command names are resolved only against those directories and never through the desktop process `PATH`, `cwd`, or user-controlled folders.

The desktop browser capability can open URLs in the default browser or a known local browser session with `browser.open_url` plus `browser`, including `chrome`, `safari`, `arc`, `brave`, `edge`, and `firefox`.

The desktop clipboard capability supports approval-gated `clipboard.read_text` and `clipboard.write_text`. Mock gateway job history redacts clipboard write text so it is not replayed from stored state.

The desktop secret capability stores named secrets in macOS Keychain with `secrets.save`, checks them with `secrets.exists`, deletes them with `secrets.delete`, and can type a saved secret into the focused field with `secrets.fill_focused_field`. There is intentionally no saved-secret readback tool that returns the raw secret to chat.

Local and remote capability execution validates arguments against the advertised capability input schema before dispatch, including prompt and stream jobs that bypass normal tool dispatch.

Approval prompts support one-time, session, and device-scoped approval. Every approval response is written to the local audit log with owner/chat/device scope, safe target metadata, approval scope, and allowed/denied result. Device-scoped approval is persisted locally as a tool-specific grant and reused only after Josh explicitly approves that scope.

`always_for_owner` skips prompts only for non-approval-worthy tools. High-risk tools such as screenshots, input control, file writes, secrets, clipboard, app activation/quit, automation, and shell still require approval unless covered by a valid session or device-scoped approval grant.

Pairing or revoking a personal device clears persisted device approval grants, in-memory session approvals, and cached job results so stale grants cannot carry across device or owner identity changes.

Device tokens are loaded into memory from macOS Keychain for connection/revoke operations and are stripped from the local settings JSON, including legacy settings files. Legacy plaintext tokens are removed only after a successful Keychain migration; if migration fails, the desktop does not hydrate the token and leaves the legacy value in place for a later retry instead of silently losing the only copy.

Desktop pairing fails closed by default: if the gateway does not return a real `deviceId`, `ownerUserId`, and `deviceToken`, or if the token cannot be saved to macOS Keychain, the app does not mark itself paired. Set `CI_DESKTOP_AGENT_ALLOW_OFFLINE_PAIRING=1` only for local non-production verification that intentionally uses a self-issued mock token.

For real signed-in setup, `pairPersonalDevice` also accepts `{ ownerUserId, pairingToken }`. The pairing token is a short-lived proof from the trusted web session; the desktop sends it to the gateway as `Authorization: Bearer <pairingToken>` and never stores it or includes it in the pairing JSON body. The pairing body does include `{ capabilities: { tools: getCapabilityManifest() } }` so the backend can show the exact paired Mac tool manifest immediately. Set `CI_DESKTOP_AGENT_REQUIRE_PAIRING_TOKEN=1` on the mock gateway to verify this backend requirement locally.

When enabled, the desktop agent fails closed before opening a gateway transport unless it has a paired `deviceId`, paired `ownerUserId`, and a device token loaded from Keychain or legacy migration.

For production-style `https://` gateway URLs, the desktop uses bearer device-token HTTP polling: it claims signed jobs and queued backend commands at `POST /api/desktop/devices/:deviceId/jobs/claim`, sends heartbeats to `POST /api/desktop/devices/:deviceId/heartbeat`, posts progress/screenshot/prompt/file events to `POST /api/desktop/jobs/:jobId/events`, and writes terminal results to `POST /api/desktop/jobs/:jobId/result`. User/chat cancellation and prompt replies are queued through `POST /api/desktop/jobs/:jobId/cancel` and `POST /api/desktop/jobs/:jobId/prompts/:promptId/respond`, then delivered to the Mac as `job.cancel` and `job.user_response` commands during polling. The existing WebSocket transport remains available for the local mock gateway and any future Node gateway that supports `wss://`.

Protected Vercel preview deployments can be tested without disabling Deployment Protection by launching the desktop app with `CI_DESKTOP_AGENT_VERCEL_BYPASS_SECRET=<preview bypass secret>`. The desktop sends it as `x-vercel-protection-bypass` only to `*.vercel.app` gateway hosts by default. For a custom protected preview host, also set `CI_DESKTOP_AGENT_VERCEL_BYPASS_HOSTS=preview.example.com`. The optional `CI_DESKTOP_AGENT_VERCEL_SET_BYPASS_COOKIE=true` or `samesitenone` mode is available for browser-like preview flows, but normal desktop HTTP polling does not need it.

The Client Intelligence backend branch adds owner-only Intelligence chat tools for this transport: `list_desktop_devices`, `run_desktop_capability`, `cancel_desktop_job`, and `respond_desktop_prompt`. These tools are intentionally not exposed in client workspace chat and are denied to team seats/platform admins unless the actor is the account owner.

Local audit history is stored as bounded JSONL metadata, redacts secret-like values from `target` and `error`, and is manageable through `getAudit`, `getAuditInfo`, and `clearAudit` on the trusted desktop bridge. `getAudit(limit)` normalizes invalid limits, defaults to 100 entries, and caps reads at 500 entries. Remote job and tool audit entries include owner/chat/target-device scope plus safe target metadata such as file path, app name, input coordinate, secret name, source ID, command name, or URL origin; they intentionally omit file contents, screenshots, clipboard text, URL query strings, and raw secrets.

Scoped folder access is manageable through the trusted desktop bridge with `chooseAllowedFolder`, `removeAllowedFolder`, and `clearAllowedFolders`. The local mock chat and native desktop menu/tray expose setup controls plus shortcuts to open Full Disk Access, Accessibility, Screen Recording, and Automation settings. Permission shortcuts are limited to those four known macOS panes before any native System Settings URL is opened.

The desktop app capability can inspect the current frontmost app/window with `apps.frontmost`. Bringing another app forward with `apps.activate` is approval-gated because it changes where subsequent keyboard and mouse input will land. App path arguments for `apps.open`, `apps.activate`, and `apps.quit` are limited to `.app` bundles; arbitrary local file opening must use scoped `files.open`.

Input jobs can include `expectedFrontmostApp` to fail before sending keyboard or mouse events if the Mac focus has drifted. The mock chat exposes this as `click-in`, `drag-in`, `scroll-in`, `type-in`, `hotkey-in`, and `press-in` commands, plus snap variants for post-action screenshots.

The macOS tray/menu-bar item shows agent connection state, active job count, and explicit remote-control active/idle state. It includes a local kill switch, reconnect action, revoke action, and Full Disk Access, Accessibility, Screen Recording, and Automation permission shortcuts. The desktop also shows native notifications when remote control transitions from idle to active and back. The mock gateway stores and renders structured active job summaries from desktop heartbeats so the phone-like chat can show the running tool and owner/chat/device scope.

Remote jobs preflight macOS Accessibility and Screen Recording permissions and return a chat-visible failure with setup guidance when those permissions are missing.

Screenshots in the mock chat are actionable: clicking a screenshot maps the displayed point back to Mac screen coordinates and sends an `input.click` job. Screenshot events include source metadata, encoding metadata, and screen bounds when Electron can resolve them, so full-screen captures can map phone taps accurately across displays. `windows` returns selectable screen/window source IDs; the mock chat renders those as quick actions for source-targeted JPEG screenshots or streams, and `screenshot-source` or `stream-source` can target one of those IDs from the command line. Use `screenshot-jpeg` and `stream-jpeg` for lower-bandwidth phone control. The mock gateway also accepts direct `click`, `drag`, and `scroll` commands for phone-like gesture control, plus `click-snap`, `drag-snap`, and `scroll-snap` variants that request a fresh screenshot after a successful action.

Jobs created while no desktop agent is connected are queued and replayed when a paired agent reconnects. Queued jobs expire at `createdAt + policy.timeoutMs`; expired jobs emit `job.expired`, stay terminal, and are not delivered after reconnect. Jobs cancelled while still queued also become terminal and are never replayed. Delivered jobs also have a gateway-side timeout: if a running or waiting job exceeds `startedAt + policy.timeoutMs`, the mock gateway marks it `expired`, clears pending prompts, emits `job.expired`, and sends `job.cancel` with `reason: "backend_timeout"` to the assigned desktop.

On macOS sleep/suspend, the desktop agent cancels active jobs, reports a sleep cancellation when still connected, closes the transport, and stays enabled without scheduling reconnect backoff. On wake/resume, it clears any pending backoff and reconnects immediately with a fresh socket. Stale socket close/error handlers are ignored after a newer reconnect starts.

The desktop agent ignores duplicate active `job.start` deliveries and returns a cached terminal result for recently completed duplicate jobs, so reconnect retries do not rerun the same action.

Gateway event envelopes are validated before execution. Malformed `job.start` messages fail as `job.result`, while malformed cancel/response messages are ignored with chat-visible progress details.

Jobs can target a specific paired device ID; the mock gateway routes starts, cancels, and prompt responses only to that device and replays queued work only to the matching reconnecting device. Delivered `job.start` envelopes must carry `ownerUserId`; a paired desktop rejects ownerless jobs and owner mismatches before execution. When present, `targetDeviceId` must also match the paired desktop. Set `CI_DESKTOP_AGENT_REQUIRE_TARGET_DEVICE=1` to make backend-style job creation reject untargeted owner jobs whenever that owner has more than one non-revoked device.

The mock gateway also checks desktop-originated job events. `job.progress`, `job.input_required`, `job.screenshot`, `job.file_event`, and `job.result` are accepted only when the connected desktop is the device assigned to a non-terminal job; wrong-device, unknown-job, or late terminal-job events are rejected before prompts, state, or chat delivery are updated.

Completed `job.result` payloads are validated against the assigned tool `outputSchema` before terminal state is written. Malformed desktop results are rejected as `agent.event.rejected` with `reason: "invalid_result"` and do not overwrite job state.

The mock gateway marks an online device offline after missed heartbeats and emits an owner-scoped `device.offline` event. Override the local timeout with `CI_DESKTOP_AGENT_OFFLINE_TIMEOUT_MS`.

Mock gateway job APIs accept an `ownerUserId` and `chatId`, and reject cross-owner or cross-chat device targeting, cancellation, and prompt responses. Cancellation requires an existing job, and prompt responses are accepted only for a currently pending prompt attached to that same job. Device, job, state, and event replay APIs can be scoped by `ownerUserId` and, where applicable, `chatId` for local verification of the one-account, per-chat model.

The mock chat UI includes owner, chat, and target-device controls plus an operational desktop status dashboard, setup checklist, folder/permission shortcuts, audit controls, and first-class prompt cards for approvals, text responses, and secure secret input. The dashboard summarizes connection state, reconnect timing, active desktop jobs, always-on setup, and macOS permission readiness. Command submits, screenshot clicks, approvals, secret/text responses, and cancels include the selected owner/chat/device scope.

The mock chat WebSocket supports reconnect/resume with `/chat?ownerUserId=<owner>&chatId=<chat>&after=<seq>&lastEventId=<eventId>`. The browser mock chat stores the last seen event sequence and stable event ID per owner/chat pair and asks the gateway to replay missed scoped events after reconnect. Replay responses include `replayFromSeq`, `firstSeq`, `retainedEventCount`, `maxRetainedEvents`, and `replayTruncated` so a phone client can detect when its cursor is too old for the retained event window.

Mock gateway generated `jobId` values include timestamp and random entropy. The real backend should keep the same invariant: desktop job IDs must be globally unique and must not depend on millisecond timestamps alone.

The local kill switch cancels active jobs, rejects pending prompts, reports cancellation to the gateway when connected, and prevents the explicit disconnect from scheduling a reconnect.

Per-job timeouts cover local tool execution, synthetic chat prompts, approval waits, and screenshot streams. Timed-out prompt jobs clear pending prompt state so late responses are ignored.

The mock gateway also clears pending prompts when a job is cancelled, expires, or receives a terminal `job.result`; late phone responses to those prompt IDs are rejected.

The mock gateway separates live delivery from stored history: transient chat can render screenshot previews and bounded live-only file previews/download links for file read results, while state, event replay, persisted jobs, secrets, file contents, and base64 payloads are redacted. Oversized live text previews are truncated and oversized binary previews omit downloadable base64.

Set `CI_DESKTOP_AGENT_STATE_PATH=/absolute/path/to/state.json` to persist mock gateway devices, tokens, jobs, and events across mock gateway restarts.

When mock gateway persistence is enabled, device-token lookup entries are stored as SHA-256 hashes. Existing plaintext token entries from older local state files are normalized on load.

The mock gateway also exposes non-production backend-style APIs:

```text
GET /api/state
GET /api/devices
GET /api/events?after=<seq>
GET /api/jobs
POST /api/desktop/devices/pair
POST /api/desktop/devices/:deviceId/revoke
POST /api/jobs
POST /api/jobs/:jobId/cancel
POST /api/respond
```

When `CI_DESKTOP_AGENT_CHAT_API_TOKEN` is set, `GET /api/state`, `GET /api/devices`, `GET /api/events`, `GET /api/jobs`, `POST /api/jobs`, `POST /api/jobs/:jobId/cancel`, `POST /api/respond`, and `WS /chat` require the configured mock chat API bearer token.

`GET /api/state`, `GET /api/events`, and `GET /api/jobs` accept `ownerUserId` and `chatId` as query parameters in the mock gateway. `GET /api/devices` accepts `ownerUserId`.

When `CI_DESKTOP_AGENT_REQUIRE_TOKEN=1`, `POST /api/desktop/devices/:deviceId/revoke` requires `Authorization: Bearer <deviceToken>`, and the token must belong to the revoked device.

When `CI_DESKTOP_AGENT_REQUIRE_TARGET_DEVICE=1`, `POST /api/jobs` rejects untargeted owner-scoped jobs if that owner has more than one non-revoked device. Use this while integrating backend/mobile routing so the chat surface must pick a registered Mac before sending a control job.

`POST /api/jobs` accepts either a command string or a structured `{ tool, args, policy }` job. Structured jobs are gateway-validated against the generated desktop capability contract, require object args that validate against the tool `inputSchema`, and accept only `approvalMode`, `timeoutMs`, and `screenshotAfterAction` policy fields.

When the desktop has a device token, remote `job.start` envelopes can be signed with HMAC-SHA256 using the token hash-derived signing key. The mock gateway signs live and queued job delivery for paired devices, including owner/device/chat metadata, and the desktop rejects ownerless, expired, future-dated, tampered, replayed, or mismatched jobs.

`WS /chat` accepts `ownerUserId`, `chatId`, `after`, and `lastEventId` query parameters for owner/chat-scoped live events and missed-event replay.

The generated backend/chat integration contract lives at `docs/desktop-agent-contract.json`. Regenerate it after capability changes with:

```bash
npm run agent:generate-contract
```

Run the local verification suite with:

```bash
npm run agent:verify
```

The verification suite includes a packaging preflight that validates the macOS privacy strings, entitlements, hardened runtime/notarization settings, and guarded Developer ID build script. It does not perform signing or publish a build.
