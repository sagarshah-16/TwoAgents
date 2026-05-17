#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

GH_BIN="${GH_BIN:-$(command -v gh 2>/dev/null || true)}"
if [[ -z "$GH_BIN" && -x "$ROOT/.tools/gh_2.63.2_macOS_arm64/bin/gh" ]]; then
  GH_BIN="$ROOT/.tools/gh_2.63.2_macOS_arm64/bin/gh"
fi

echo "==> Security scan"
python3 "$ROOT/scripts/pre-commit-security-scan.py"

if [[ -z "$GH_BIN" ]]; then
  echo "Install GitHub CLI: brew install gh"
  exit 1
fi

if ! "$GH_BIN" auth status >/dev/null 2>&1; then
  echo "==> GitHub CLI login required"
  "$GH_BIN" auth login --hostname github.com --git-protocol ssh --skip-ssh-key --web
fi

if ! git remote get-url origin >/dev/null 2>&1; then
  git remote add origin "git@github.com-personal:sagarshah-16/TwoAgents.git"
fi

if ! "$GH_BIN" repo view sagarshah-16/TwoAgents >/dev/null 2>&1; then
  echo "==> Creating GitHub repo"
  "$GH_BIN" repo create TwoAgents --public --source=. --remote=origin --description "Desktop app orchestrating Codex CLI and Claude Code as worker/reviewer agents."
else
  echo "==> Repo already exists"
fi

echo "==> Pushing main"
git push -u origin main

echo "Done: https://github.com/sagarshah-16/TwoAgents"
