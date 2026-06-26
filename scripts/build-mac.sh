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

run_notarization_preflight() {
  if [[ "${CI_DESKTOP_SKIP_NOTARIZATION_PREFLIGHT:-}" == "1" ]]; then
    echo "Skipping Apple notarization preflight because CI_DESKTOP_SKIP_NOTARIZATION_PREFLIGHT=1." >&2
    return 0
  fi

  if ! command -v xcrun >/dev/null 2>&1; then
    echo "Missing xcrun. Install Xcode command line tools before building the macOS release." >&2
    exit 1
  fi

  local args=()
  if [[ -n "${APPLE_KEYCHAIN_PROFILE:-}" ]]; then
    args=(--keychain-profile "${APPLE_KEYCHAIN_PROFILE}")
  elif [[ -n "${APPLE_ID:-}" && -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]]; then
    args=(--apple-id "${APPLE_ID}" --password "${APPLE_APP_SPECIFIC_PASSWORD}" --team-id "${APPLE_TEAM_ID}")
  else
    echo "Missing Apple notarization credentials. Set APPLE_KEYCHAIN_PROFILE or APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, and APPLE_TEAM_ID before building the macOS release." >&2
    exit 1
  fi

  local output
  local status
  set +e
  output="$(xcrun notarytool history "${args[@]}" 2>&1)"
  status=$?
  set -e

  if [[ ${status} -eq 0 ]]; then
    return 0
  fi

  if grep -Eiq "agreement|expired|HTTP status code: 403" <<<"${output}"; then
    echo "Apple notarization preflight failed: the Apple Developer team has a missing or expired agreement. Accept the current Apple Developer Program agreements in App Store Connect / Apple Developer, then rerun this build." >&2
    exit 1
  fi

  echo "Apple notarization preflight failed. Verify notarization credentials and team access before building:" >&2
  echo "${output}" >&2
  exit 1
}

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
if [[ -n "${developer_id_identity}" ]]; then
  export CSC_NAME="${developer_id_identity#Developer ID Application: }"
elif [[ -n "${CSC_LINK:-}" && -n "${CSC_KEY_PASSWORD:-}" ]]; then
  echo "Using CSC_LINK signing certificate; Developer ID authority will be verified after build." >&2
else
  echo "Missing Developer ID Application signing identity. Install the Developer ID Application certificate before building the macOS release." >&2
  exit 1
fi

run_notarization_preflight

# Prevent stale unsigned artifacts from being reused or published.
rm -rf release/mac-universal
rm -f release/*.dmg release/*.dmg.blockmap release/latest-mac.yml release/builder-debug.yml release/builder-effective-config.yaml

npm run build
npx electron-builder --mac "$@"

app_path="release/mac-universal/Client Intelligence.app"
if [[ -d "${app_path}" ]]; then
  codesign --verify --deep --strict --verbose=2 "${app_path}"
  signing_details="$(codesign -dv --verbose=4 "${app_path}" 2>&1)"
  if [[ "${signing_details}" != *"Authority=Developer ID Application:"* ]]; then
    echo "Built app is not signed with a Developer ID Application certificate." >&2
    echo "${signing_details}" >&2
    exit 1
  fi
  gatekeeper_details="$(spctl -a -vvv -t execute "${app_path}" 2>&1)"
  if [[ "${gatekeeper_details}" != *"source=Notarized Developer ID"* ]]; then
    echo "Built app did not pass Gatekeeper assessment as a notarized Developer ID app." >&2
    echo "${gatekeeper_details}" >&2
    exit 1
  fi
fi
