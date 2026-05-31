#!/usr/bin/env bash
set -euo pipefail

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

if [[ -n "${APPLE_KEYCHAIN_PROFILE:-}" ]]; then
  unset APPLE_ID
  unset APPLE_APP_SPECIFIC_PASSWORD
fi

npm run build
npx electron-builder --mac "$@"
