#!/usr/bin/env bash
set -euo pipefail

# Usage: ./scripts/release.sh [patch|minor|major]
# Bumps version, creates a git tag, and pushes to trigger the CI/CD release pipeline.

BUMP_TYPE="${1:-patch}"

if [[ "$BUMP_TYPE" != "patch" && "$BUMP_TYPE" != "minor" && "$BUMP_TYPE" != "major" ]]; then
  echo "Usage: $0 [patch|minor|major]"
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Error: Working directory is not clean. Commit or stash changes first."
  exit 1
fi

CURRENT_BRANCH="$(git branch --show-current)"
if [[ "$CURRENT_BRANCH" != "main" ]]; then
  echo "Warning: You are on branch '$CURRENT_BRANCH', not 'main'."
  read -r -p "Continue anyway? [y/N] " confirm
  if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
    exit 1
  fi
fi

CURRENT_VERSION="$(node -p "require('./package.json').version")"
echo "Current version: v$CURRENT_VERSION"

npm version "$BUMP_TYPE" --no-git-tag-version
NEW_VERSION="$(node -p "require('./package.json').version")"

git add package.json package-lock.json 2>/dev/null || git add package.json
git commit -m "chore: release v$NEW_VERSION"
git tag -a "v$NEW_VERSION" -m "Release v$NEW_VERSION"

echo ""
echo "Version bumped: v$CURRENT_VERSION -> v$NEW_VERSION"
echo "Tag created: v$NEW_VERSION"
echo ""
echo "To publish the release:"
echo "  git push origin $CURRENT_BRANCH --follow-tags"
echo ""
echo "This will trigger the CI/CD pipeline to build, sign, notarize, and publish the DMG."
