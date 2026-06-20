# Desktop Agent Staging Preview Runbook

Use this after the backend branch has a non-production preview URL and the staging database write probe passes.

Do not use production URLs, production Supabase refs, or `dist:publish` for this runbook.

## 1. Verify Desktop Branch

```bash
cd /Users/joshfortims/ci-desktop
npm run build
npm run agent:verify
```

## 2. Verify Backend Preview

```bash
cd /Users/joshfortims/clients-ai
PREFLIGHT_ENV_FILE=.env.staging.local \
DESKTOP_AGENT_BASE_URL=<preview-url> \
DESKTOP_AGENT_MODE=owner_allowlist \
DESKTOP_AGENT_ALLOWED_OWNER_IDS=<josh-owner-user-id> \
DESKTOP_AGENT_EXPECTED_OWNER_ID=<josh-owner-user-id> \
npm run verify:desktop-agent:nonprod

PREFLIGHT_ENV_FILE=.env.staging.local npm run verify:desktop-agent:staging-db

PREFLIGHT_ENV_FILE=.env.staging.local \
DESKTOP_AGENT_DB_WRITE_PROBE=1 \
DESKTOP_AGENT_OWNER_EMAIL=<owner-email> \
npm run verify:desktop-agent:staging-db

DESKTOP_AGENT_BASE_URL=<preview-url> \
DESKTOP_AGENT_PREVIEW_VERCEL_CURL=1 \
npm run verify:desktop-agent:preview
```

If the write probe fails with a PostgREST schema-cache/table error, apply the staging-only grant migration from the backend repo:

```bash
cd /Users/joshfortims/clients-ai
PREFLIGHT_ENV_FILE=.env.staging.local \
DESKTOP_AGENT_STAGING_DB_URL=<staging-postgres-url> \
npm run desktop-agent:apply-staging-grants
```

The helper refuses the known production Supabase ref before running SQL.

## 3. Launch Desktop Against Preview

For an unprotected preview:

```bash
cd /Users/joshfortims/ci-desktop
CI_DESKTOP_APP_URL=<preview-url> \
CI_DESKTOP_AGENT_GATEWAY_URL=<preview-url> \
npm run dev
```

For a protected Vercel preview:

```bash
cd /Users/joshfortims/ci-desktop
CI_DESKTOP_APP_URL=<preview-url> \
CI_DESKTOP_AGENT_GATEWAY_URL=<preview-url> \
CI_DESKTOP_AGENT_VERCEL_BYPASS_SECRET=<Protection Bypass for Automation secret> \
npm run dev
```

The bypass secret is sent only to `*.vercel.app` gateway hosts by default. For a custom protected preview host, also set:

```bash
CI_DESKTOP_AGENT_VERCEL_BYPASS_HOSTS=<custom-preview-host>
```

## 4. Pair This Mac

1. Sign in to the preview inside the desktop app.
2. Open Settings -> Desktop.
3. Click the desktop pairing action.
4. Confirm the local setup panel shows the paired device, connection state, active job count, file scope, control mode, approval mode, and permission shortcuts.
5. Choose selected folders or full disk mode.
6. Open and grant the required macOS permission panes:
   - Full Disk Access for broad file access.
   - Screen Recording for screenshots.
   - Accessibility for keyboard/mouse control.
   - Automation for AppleScript/app automation.
7. Enable launch at login only after staging pairing and job execution are verified.

## 5. Run Local/Preview E2E

```bash
cd /Users/joshfortims/clients-ai
PREFLIGHT_ENV_FILE=.env.staging.local \
DESKTOP_AGENT_OWNER_EMAIL=<owner-email> \
DESKTOP_AGENT_BASE_URL=<preview-url> \
DESKTOP_AGENT_DESKTOP_REPO=/Users/joshfortims/ci-desktop \
npm run verify:desktop-agent:local-e2e
```

For protected Vercel previews, include:

```bash
CI_DESKTOP_AGENT_VERCEL_BYPASS_SECRET=<Protection Bypass for Automation secret>
```

## 6. Phone-Width Chat Checks

From a phone or a narrow browser viewport signed in to the preview:

- Ask Intelligence to list desktop devices.
- Ask for a screenshot from the Mac.
- Tap the screenshot, then confirm a click job queues for the same device/chat.
- Try right-click, double-click, drag, scroll, type, Return, Tab, Esc, Cmd+L, Cmd+Tab, and Cmd+W from the screenshot controls.
- Start live screenshots, then use Stop.
- Read, list, search, and watch a scoped file/folder.
- Open a browser URL.
- Request a text prompt, approval prompt, and secret prompt.
- Cancel a queued or running job.
- Revoke the device and confirm polling fails closed.

Expected behavior:

- The chat feed shows queued, running, prompt, screenshot, completed, failed, cancelled, and expired desktop events.
- High-risk actions ask locally on the Mac unless already approved for the session or device.
- Secret values are delivered to the Mac but not stored back into durable chat history.
- Revocation clears local approval grants and stops remote control.
