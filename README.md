# Client Intelligence Desktop

Native macOS desktop app for [Client Intelligence](https://clientintelligence.ai). Wraps the web app in an Electron shell with native window management, dock integration, and auto-updates via GitHub Releases.

## Prerequisites

- Node.js 20+
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
