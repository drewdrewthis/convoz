#!/usr/bin/env bash
# Sends this checkout to the owner's dev build of the web app (the /dev/ pages). It runs the fast-lane gate as the base branch has
# it, then force-pushes HEAD to the dev-web branch; .github/workflows/dev-web.yml builds it with base /dev/ and uploads the
# artifact, and the relay on the server puts it live (a new release folder, then the current symlink renamed over the old one).
# It holds no key and reaches no server. Usage: scripts/dev-web-push.sh
set -euo pipefail

BASE_REF="${BASE_REF:-origin/feat/web-react}"
REPO="${REPO:-drewdrewthis/convoz}"

cd "$(git rev-parse --show-toplevel)"
if [ -n "$(git status --porcelain)" ]; then
  echo "dev-web-push: the checkout has changes that are not committed; commit them first" >&2
  exit 1
fi
git fetch --quiet origin feat/web-react

# The gate is the copy on the base branch, never this checkout's own copy.
gate="$(mktemp)"
trap 'rm -f "$gate"' EXIT
if ! git show "$BASE_REF:scripts/fast_lane.py" > "$gate"; then
  echo "dev-web-push: $BASE_REF has no scripts/fast_lane.py; nothing is pushed" >&2
  exit 1
fi
status=0
verdict="$(python3 -I "$gate" "$BASE_REF")" || status=$?
printf '%s\n' "$verdict"
if [ "$status" -ne 0 ] || ! printf '%s\n' "$verdict" | grep -qx 'ELIGIBLE'; then
  echo "dev-web-push: the gate did not say ELIGIBLE; this change needs the full gate, nothing is pushed" >&2
  exit 1
fi

sha="$(git rev-parse HEAD)"
git push --force origin HEAD:dev-web
echo "pushed $sha to dev-web"
echo "runs: https://github.com/$REPO/actions/workflows/dev-web.yml?query=branch%3Adev-web"
if command -v gh > /dev/null; then
  for _ in 1 2 3 4 5 6; do
    url="$(gh run list -R "$REPO" --workflow dev-web.yml --branch dev-web --commit "$sha" --limit 1 --json url --jq '.[0].url // empty' 2> /dev/null || true)"
    if [ -n "$url" ]; then
      echo "run: $url"
      exit 0
    fi
    sleep 5
  done
fi
