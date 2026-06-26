# Client Intelligence Mobile, TestFlight, and Desktop Agent Session Breakdown

Date: June 26, 2026  
Primary repos touched: `/Users/joshfortims/clients-ai`, `/Users/joshfortims/ci-desktop`  
Primary outcome: Client Intelligence iOS build uploaded to TestFlight, production web shell updated, internal TestFlight testing enabled, and immediate mobile/voice blockers addressed.

## Executive Summary

This session started with strategy around a three-level desktop agent rollout, then shifted into getting the current Client Intelligence platform usable as a mobile iOS app through TestFlight.

The highest-priority deliverable was achieved: iOS build `1.0 (2026062602)` was uploaded to App Store Connect, attached to an internal TestFlight group, moved into Testing status, and invites were resent to the internal testers. The app is now installable through TestFlight once an invite is accepted from the tester's email/Apple ID.

Along the way, we also hardened the mobile/native experience and fixed a serious voice transcription failure mode where short or poor recordings could cause the speech model to hallucinate text. The web changes were deployed to production at `https://clientintelligence.ai`.

## Desktop Agent Planning

We framed the desktop agent rollout in three levels:

1. **Level 1: Local desktop agent**
   - Desktop app has local access to the computer after user-granted permissions.
   - Capabilities include file system access, screen observation/recording, browser control, and accessibility/system interaction.
   - Agent is installed, started, stopped, authorized, and managed from the desktop app on that machine.
   - This is the foundation for everything else.

2. **Level 2: Same-user remote control**
   - The user's phone can control the agent running on their own desktop.
   - Same account, one desktop, one mobile controller.
   - Requires secure device pairing, live job/event transport, permissions, and clear approval/audit surfaces.

3. **Level 3: Multi-user rollout**
   - The phone-control model becomes available to every user.
   - Requires hardened onboarding, revocation, observability, quota/rate protection, support workflows, and stronger policy boundaries.

We also discussed that Level 1 is not simply "permissions"; the local agent runtime is what makes the permissions usable. File, browser, screen, and accessibility access all need a managed local process and a secure contract between the desktop app, the web platform, and the user's machine.

## Mobile App / TestFlight Work Completed

### iOS build uploaded

Uploaded iOS build:

- App: Client Intelligence
- Bundle ID: `ai.clientintelligence.app`
- Version: `1.0`
- Build: `2026062602`
- App Store Connect status after setup: available for internal TestFlight testing

Build `2026062601` was uploaded first, then `2026062602` was created and uploaded after additional native/mobile polish. Build `2026062602` is the one to use.

### App Store Connect / TestFlight setup

In App Store Connect:

- Cleared the missing compliance blocker.
- Confirmed build `1.0 (2026062602)` is attached to internal group `CI Team Internal`.
- Confirmed the build is in `Testing` status for that internal group.
- Confirmed the internal group contains 2 internal testers.
- Resent the TestFlight invites to the internal testers.

Current user action required:

- Accept the TestFlight invite from the relevant email/Apple ID on the iPhone.
- After accepting, the app should appear inside the TestFlight app.
- The `Redeem` button in TestFlight is only needed if Apple provides a redemption code; the normal path is the email invite link.

## Native iOS Shell Polish

### AppDelegate native injection

Updated the iOS native shell to inject a small WebKit user script:

- Hides/removes the Markman feedback overlay in the native app shell.
- Removes PWA/install prompts that do not belong inside an App Store shell.
- Adds native-side swipe support as a fallback for the main app mode navigation.

The native-side route mapping is:

- Brain -> `/brain`
- Intelligence -> `/chat`
- Clients -> `/clients`

This means horizontal swipes can move between the three main app modes even if the production web bundle is not yet fully refreshed.

### Build number bump

Updated the iOS Xcode project build number:

- From `1`
- To `2026062602`

This ensured App Store Connect accepted a new build with the latest native/mobile changes.

## Production Web App Changes

The iOS Capacitor app points at the production web app URL, so web/mobile UX fixes also needed to be deployed to production.

Production deployment completed:

- Domain: `https://clientintelligence.ai`
- Vercel deployment state: Ready
- Production alias: active

Sanity checks:

- `/login` returned `200`
- `/api/transcribe` returned `401` when unauthenticated, as expected
- Production deploy completed successfully through Vercel

## Mobile Shell UX Changes

### Global swipe navigation

Added touch swipe handling in the main dashboard shell:

- Swipe left advances: Brain -> Intelligence -> Clients
- Swipe right reverses: Clients -> Intelligence -> Brain
- Ignores interactive controls like inputs, textareas, buttons, links, contenteditable areas, and scroll-area viewports.
- Avoids interfering with client workspace-specific flows.

### Markman hidden globally

Removed the global Markman/Josh feedback overlay from the dashboard shell render path.

Reason:

- It was appearing as a black square/overlay in authenticated mobile QA.
- The user explicitly approved hiding/removing Markman if it created problems.

The component file still exists, but it is no longer globally mounted from the dashboard shell.

### PWA prompt suppressed in native app

Updated the PWA install prompt logic so it does not show inside Capacitor/native app contexts.

This prevents the App Store version from asking users to "install" the PWA or add the app to the home screen.

## Voice Transcription Audit and Fix

The user reported that the click-to-talk / voice transcription feature was "completely messed up" and appeared to invent text.

Audit findings:

- The voice hook records through `MediaRecorder`.
- The blob is uploaded to Supabase Storage.
- `/api/transcribe` then sends the file to `gpt-4o-transcribe`.
- The transcription prompt included strong Client Intelligence/product vocabulary.
- For tiny, accidental, silent, or low-quality recordings, that prompt could bias the model toward plausible-sounding Client Intelligence text instead of returning nothing.

Fixes implemented:

- Added a local minimum recording duration guard.
- Added a local minimum audio byte-size guard.
- Added a server-side minimum audio byte-size guard before provider transcription or queueing.
- Updated the transcription prompt to explicitly instruct the model:
  - Transcribe only clearly spoken words.
  - Do not infer, summarize, complete sentences, or guess from noise/silence.
  - Return an empty transcription if there is no intelligible speech.

Test coverage added/updated:

- Short accidental taps are rejected before upload/transcription.
- Tiny uploaded audio is rejected server-side before provider or queue.
- The speech model prompt now includes explicit anti-guessing instructions.
- Existing voice tests were updated to simulate realistic record/stop duration.

## Verification Performed

### Targeted tests

Command:

```bash
npm test -- --run __tests__/voice/use-voice-recording.test.tsx __tests__/uploads/transcribe-route-lanes.test.ts __tests__/frameworks/brain-dump-voice.test.tsx
```

Result:

- 3 test files passed
- 16 tests passed

### Production build

Command:

```bash
npm run build
```

Result:

- Next.js production build passed locally.
- Remote Vercel production build also passed.

### iOS archive/upload

Performed an iOS archive for build `2026062602`, then exported/uploaded it to App Store Connect.

Result:

- Archive created successfully.
- Upload succeeded.
- App Store Connect accepted the package.
- Build became available for internal TestFlight testing after compliance/setup.

### Authenticated mobile QA

Earlier authenticated Chrome/mobile-size QA confirmed:

- `/chat` loads in the authenticated mobile layout.
- `/settings` loads in mobile layout.
- `/market-intelligence/new` loads in mobile layout.

Observed issue:

- A black Markman overlay appeared in the mobile UI.

Resolution:

- Removed Markman from global shell rendering.
- Added native-side suppression as a backup.

## Files Changed in `clients-ai`

Primary files changed:

- `components/layout/DashboardShell.tsx`
- `components/pwa/PWAInstallPrompt.tsx`
- `ios/App/App/AppDelegate.swift`
- `ios/App/App.xcodeproj/project.pbxproj`
- `app/api/transcribe/route.ts`
- `lib/hooks/useVoiceRecording.ts`
- `__tests__/voice/use-voice-recording.test.tsx`
- `__tests__/uploads/transcribe-route-lanes.test.ts`
- `__tests__/frameworks/brain-dump-voice.test.tsx`

Important note:

- The branch also contained many unrelated desktop-agent changes from another agent.
- The production web deploy was intentionally performed from a clean temporary worktree containing only the selected mobile/voice changes, so unrelated desktop-agent work was not shipped.

## What Is Done

Done:

- iOS app build uploaded.
- Latest build `2026062602` available for TestFlight internal testing.
- Internal group attached.
- Tester invites resent.
- Production web app deployed.
- Native shell cleanup added.
- Global app-mode swipe behavior added.
- Markman hidden from mobile/native shell.
- PWA install prompt suppressed in native app.
- Voice transcription hallucination risk reduced.
- Relevant tests and builds passed.

## What Is Not Fully Done Yet

Not fully done:

- Full page-by-page mobile redesign of every dashboard route.
- Full mobile polish pass for every task card, client workspace card, dashboard table, and dense admin/workflow view.
- Full device QA on a physical iPhone after accepting the TestFlight invite.
- App Store public submission.
- External TestFlight beta review for non-internal testers.
- Dedicated Apple reviewer account setup for eventual App Review.

## Recommended Next Steps

1. Accept the TestFlight invite on the iPhone.
2. Install build `1.0 (2026062602)` through TestFlight.
3. Smoke test on-device:
   - Login
   - Chat
   - Talk mode
   - Brain/Intelligence/Clients swipe navigation
   - Clients page
   - Settings
   - Market Intelligence
4. Run a route-by-route mobile UX pass:
   - Chat
   - Clients
   - Intelligence To-dos
   - Client workspace
   - Project/task boards
   - Settings
   - Market Intelligence
5. Create a dedicated reviewer account before external TestFlight or App Store review.
6. Decide whether to submit external TestFlight for clients or keep it internal until the next mobile polish pass is complete.

## Final State

The app is now in a working internal TestFlight path. The immediate blocker is no longer App Store Connect setup; it is accepting the TestFlight invite from the iPhone-side Apple ID/email.

The build to install is:

```text
Client Intelligence 1.0 (2026062602)
```

