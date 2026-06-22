# CI/CD Secrets Setup Guide

This guide walks through configuring GitHub Actions secrets for automated macOS builds with code signing and notarization.

## Required secrets

Go to **Settings → Secrets and variables → Actions** in the GitHub repo and add:

### Code signing

| Secret | Description | How to get it |
|--------|-------------|---------------|
| `CSC_LINK` | Base64-encoded .p12 certificate file | Export your "Developer ID Application" certificate from Keychain Access as .p12, then `base64 -i certificate.p12 \| pbcopy` |
| `CSC_KEY_PASSWORD` | Password for the .p12 file | The password you set during export |

### Notarization

| Secret | Description | How to get it |
|--------|-------------|---------------|
| `APPLE_ID` | Your Apple Developer account email | Your Apple ID email address |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password for notarization | Generate at https://appleid.apple.com → Sign-In and Security → App-Specific Passwords |
| `APPLE_TEAM_ID` | Your Apple Developer Team ID | Find at https://developer.apple.com/account → Membership Details |

## Exporting the signing certificate

```bash
# 1. Find your Developer ID Application certificate in Keychain Access
security find-identity -v -p codesigning

# 2. Export as .p12 from Keychain Access:
#    - Open Keychain Access
#    - Find "Developer ID Application: Your Name (TEAM_ID)"
#    - Right-click → Export Items
#    - Save as .p12 with a strong password

# 3. Base64 encode for GitHub Secrets
base64 -i ~/Desktop/certificate.p12 | pbcopy
# Paste into CSC_LINK secret

# 4. Delete the exported .p12 file
rm ~/Desktop/certificate.p12
```

## Optional: Crash reporting (Sentry)

1. Create a Sentry project at https://sentry.io for the "Electron" platform
2. Copy the DSN from **Settings → Projects → Your Project → Client Keys (DSN)**
3. Set the environment variable `CI_DESKTOP_SENTRY_DSN` in your build:
   - For local development: add to `.env` (gitignored)
   - For CI: add as a GitHub Actions secret and pass to the build step
4. Crash reports are opt-in — only active in packaged builds, never in development
5. PII (IP address, email) is automatically stripped before sending

## Optional: Telemetry

1. Set up an HTTPS endpoint that accepts POST requests with JSON body:
   ```json
   { "anonymousId": "uuid", "events": [{ "event": "app.launched", "timestamp": "...", ... }] }
   ```
2. Set `CI_DESKTOP_TELEMETRY_ENDPOINT` to that URL
3. Telemetry is opt-in per user — users can toggle via settings
4. Events are buffered and flushed every 5 minutes
5. No PII is collected — only anonymous session IDs, event names, platform, and version

## Triggering a release

```bash
# Using the release script (recommended)
npm run release:patch   # 1.0.0 -> 1.0.1
npm run release:minor   # 1.0.0 -> 1.1.0
npm run release:major   # 1.0.0 -> 2.0.0

# Then push
git push origin main --follow-tags
```

The CI pipeline will:
1. Run tests (lint + unit tests)
2. Build the universal macOS DMG
3. Sign with Developer ID certificate
4. Notarize with Apple
5. Publish to GitHub Releases
6. Auto-generate release notes

## Verifying the setup

After configuring secrets, push a tag to trigger the release job:

```bash
git tag v1.0.1-rc.1
git push origin v1.0.1-rc.1
```

Check the Actions tab for build status. The "Verify code signature" step will confirm signing is correct.

## Troubleshooting

| Issue | Fix |
|-------|-----|
| "No signing identity found" | Verify CSC_LINK is the full base64 output with no newlines |
| "Notarization failed" | Verify APPLE_APP_SPECIFIC_PASSWORD is an app-specific password (not your account password) |
| "Team ID mismatch" | Ensure APPLE_TEAM_ID matches the team on your Developer ID certificate |
| Build succeeds but unsigned | Check the "Verify code signature" step output for details |
