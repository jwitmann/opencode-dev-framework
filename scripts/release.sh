#!/usr/bin/env bash
# Release script for opencode-dev-framework.
#
# Usage:
#   ./scripts/release.sh [patch|minor|major]
#
# Defaults to `patch` if no bump type is given.
#
# What it does:
#   1. Runs the full validation suite (format, lint, lint:md, typecheck, test, build).
#   2. Bumps the version in BOTH package.json and package-lock.json via `npm version`.
#   3. Commits and creates a git tag.
#   4. Prints the push command (does NOT push automatically).
set -euo pipefail

BUMP="${1:-patch}"

if [[ "$BUMP" != "patch" && "$BUMP" != "minor" && "$BUMP" != "major" ]]; then
  echo "Usage: $0 [patch|minor|major]"
  exit 1
fi

cd "$(dirname "$0")/.."

echo "==> Running validation..."
npm run format:check
npm run lint
npm run lint:md
npm run typecheck
npm run test
npm run build

echo ""
echo "==> Bumping version ($BUMP)..."
npm version --no-git-tag-version "$BUMP"

NEW_VERSION=$(node -p "require('./package.json').version")
TAG="v$NEW_VERSION"

echo ""
echo "==> Committing and tagging..."
git add package.json package-lock.json
git commit -m "Release $TAG"
git tag -a "$TAG" -m "Release $TAG"

echo ""
echo "==> Done! Current version: $NEW_VERSION"
echo ""
echo "To publish, push the tag:"
echo "  git push origin main --tags"
echo ""
echo "CI will publish to npm automatically."
