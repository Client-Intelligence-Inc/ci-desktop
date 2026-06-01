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

resolve_developer_id_identity() {
  local identities
  identities="$(security find-identity -v -p codesigning 2>/dev/null || true)"

  if [[ -n "${CSC_NAME:-}" && "${CSC_NAME}" == Developer\ ID\ Application:* ]]; then
    if grep -Fq "\"${CSC_NAME}\"" <<<"${identities}"; then
      printf '%s\n' "${CSC_NAME}"
      return 0
    fi
  fi

  if [[ -n "${CSC_NAME:-}" ]]; then
    local explicit_identity="Developer ID Application: ${CSC_NAME}"
    if grep -Fq "\"${explicit_identity}\"" <<<"${identities}"; then
      printf '%s\n' "${explicit_identity}"
      return 0
    fi
  fi

  if [[ -n "${APPLE_TEAM_ID:-}" ]]; then
    local team_identity
    team_identity="$(
      grep -E "\"Developer ID Application: .+ \\(${APPLE_TEAM_ID}\\)\"" <<<"${identities}" \
        | sed -E 's/.*"([^"]+)".*/\1/' \
        | head -n 1 \
        || true
    )"
    if [[ -n "${team_identity}" ]]; then
      printf '%s\n' "${team_identity}"
      return 0
    fi
  fi

  return 1
}

developer_id_identity="$(resolve_developer_id_identity || true)"
if [[ -z "${developer_id_identity}" ]]; then
  echo "Missing Developer ID Application signing identity. Install the Developer ID Application certificate before building the macOS release." >&2
  exit 1
fi

export CSC_NAME="${developer_id_identity}"

# Prevent stale unsigned artifacts from being reused or published.
rm -rf release/mac-universal
rm -f release/*.dmg release/*.dmg.blockmap release/latest-mac.yml release/builder-debug.yml release/builder-effective-config.yaml

npm run build
npx electron-builder --mac "$@"

app_path="release/mac-universal/Client Intelligence.app"
if [[ -d "${app_path}" ]]; then
  codesign --verify --deep --strict --verbose=2 "${app_path}"
  if ! codesign -dv --verbose=4 "${app_path}" 2>&1 | grep -q "Authority=Developer ID Application:"; then
    echo "Built app is not signed with a Developer ID Application certificate." >&2
    exit 1
  fi
fi
