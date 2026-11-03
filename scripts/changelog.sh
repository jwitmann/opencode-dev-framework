#!/usr/bin/env bash
# Changelog generator for opencode-dev-framework.
#
# Single source of truth, published twice: CHANGELOG.md ships in the repo
# (and the npm tarball), and CI uses the version's section as the GitHub
# release body. Bash-native, no dependencies, fully offline.
#
# Usage:
#   ./scripts/changelog.sh <prev-ref> <version> [date]
#     Prepend a CHANGELOG.md section for <version> covering <prev-ref>..HEAD.
#     Release commits ("Release v*") are excluded; the release commit itself
#     is created after generation, so it never appears.
#   ./scripts/changelog.sh --backfill
#     Rewrite CHANGELOG.md from scratch for every v1.* tag (newest first),
#     using each tag's date. Idempotent.
set -euo pipefail

cd "$(dirname "$0")/.."

REPO_URL="https://github.com/jwitmann/opencode-dev-framework"

section_for() {
  local prev="$1" range_end="$2" version="$3" date="$4"
  local feats="" fixes="" docs="" other=""

  while IFS= read -r line; do
    local hash="${line%% *}"
    local subject="${line#* }"
    # Some historical subjects embed literal \n sequences — keep the head.
    subject="${subject%%\\n*}"
    case "$subject" in
      Release\ v*) continue ;;
    esac
    local type="${subject%%:*}"
    local rest="${subject#*: }"
    [ "$rest" = "$subject" ] && rest="$subject"
    local entry="- ${rest} ([\`${hash:0:7}\`](${REPO_URL}/commit/${hash}))"
    case "$type" in
      feat) feats+="${entry}"$'\n' ;;
      fix) fixes+="${entry}"$'\n' ;;
      docs) docs+="${entry}"$'\n' ;;
      *) other+="${entry}"$'\n' ;;
    esac
  done < <(git log --reverse --format='%H %s' "${prev}..${range_end}")

  {
    echo "## [${version}] - ${date}"
    echo ""
    if [ -n "$feats" ]; then echo "### Features"; echo ""; printf '%s' "$feats"; echo ""; fi
    if [ -n "$fixes" ]; then echo "### Fixes"; echo ""; printf '%s' "$fixes"; echo ""; fi
    if [ -n "$docs" ]; then echo "### Documentation"; echo ""; printf '%s' "$docs"; echo ""; fi
    if [ -n "$other" ]; then echo "### Other"; echo ""; printf '%s' "$other"; echo ""; fi
  }
}

write_header() {
  {
    echo "# Changelog"
    echo ""
    echo "<!-- markdownlint-disable MD024 --><!-- repeated bucket headings -->"
    echo ""
    echo "Generated from conventional commits (\`scripts/changelog.sh\`)."
    echo "Single source: CI publishes each version's section as the GitHub"
    echo "release notes, so this file and the release page never diverge."
    echo ""
  }
}

# Collapse accidental blank runs (buckets, section joints) and strip
# trailing blank lines — generated file only, no fenced blocks to protect.
normalize() {
  awk 'BEGIN{blanks=0} /^$/{blanks++; if (blanks<=1) print; next} {blanks=0; print}' "$1" > "$1.tmp"
  printf '%s\n' "$(cat "$1.tmp")" > "$1"
  rm -f "$1.tmp"
}

if [ "${1:-}" = "--backfill" ]; then
  mapfile -t tags < <(git tag --sort=-v:refname | grep -E '^v1\.')
  {
    write_header
    prev=""
    ordered=()
    for (( i=${#tags[@]}-1; i>=0; i-- )); do ordered+=("${tags[i]}"); done
    for idx in "${!ordered[@]}"; do
      tag="${ordered[idx]}"
      if [ "$idx" -eq 0 ]; then
        echo "## [${tag}] - $(git log -1 --format=%cs "$tag")"
        echo ""
        echo "Initial stable release line."
        echo ""
        continue
      fi
      prev="${ordered[idx-1]}"
      section_for "$prev" "$tag" "$tag" "$(git log -1 --format=%cs "$tag")"
    done
  } > CHANGELOG.md
  normalize CHANGELOG.md
  echo "Backfilled CHANGELOG.md (${#tags[@]} versions)."
  exit 0
fi

if [ $# -lt 2 ]; then
  echo "Usage: $0 <prev-ref> <version> [date]" >&2
  exit 1
fi

tmp="$(mktemp)"
section_for "$1" "HEAD" "v$2" "${3:-$(date +%F)}" > "$tmp"
{
  write_header
  cat "$tmp"
  if [ -f CHANGELOG.md ]; then
    awk '/^## \[/{on=1} on' CHANGELOG.md || true
  fi
} > CHANGELOG.md.new
normalize CHANGELOG.md.new
mv CHANGELOG.md.new CHANGELOG.md
rm -f "$tmp"
echo "Prepended v$2 section to CHANGELOG.md."
