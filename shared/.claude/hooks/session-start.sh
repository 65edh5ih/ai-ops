#!/bin/bash
# 配布フック（正本: ai-ops shared/.claude/hooks/session-start.sh。手編集しない・直したいときは outbox 提案）。
# セッション開始時に:
#   1. マージ済みブランチ再push を弾く pre-push フックを有効化（core.hooksPath）。
#   2. docs/AI_CONTEXT.md があれば全文注入（真の必読＝実質どのタスクでも要るプロジェクト前提。
#      無い repo は skip＝この repo に「毎回の総覧」が無いので注入しない）。
# タスク履歴は注入しない: 毎回は要らず（過去スレッドを参照するタスクのときだけ要る）、注入は
# 無関係な本文で文脈を薄めるだけ。AGENTS の「タスク履歴（短期記憶）」指示に従い on-demand で
# 読む（どこに何があるかは常時ロードの AGENTS.md 側にある。規約: docs/task-history.md）。
# 各 repo の .claude/settings.json の SessionStart から起動される。
set -euo pipefail

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"

# core.hooksPath はローカル設定でエフェメラルなコンテナでは毎回消えるため張り直す。
# 仕組みの詳細: docs/merged-branch-guard.md / .githooks/pre-push。
if [ -d "$PROJECT_DIR/.githooks" ]; then
  git -C "$PROJECT_DIR" config core.hooksPath .githooks 2>/dev/null || true
fi

# 存在すれば見出し付きで全文を stdout に出す。
emit_doc() {
  if [ -f "$PROJECT_DIR/$1" ]; then
    printf '=== %s ===\n' "$1"
    cat "$PROJECT_DIR/$1"
  fi
}

context=$(emit_doc "docs/AI_CONTEXT.md")
if [ -n "$context" ]; then
  # SessionStart のコンテキスト注入は hookSpecificOutput.additionalContext で行う
  # （トップレベル message は認識されない。docs: code.claude.com/docs/en/hooks#sessionstart）。
  printf '%s' "$context" | jq -Rs '{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: .}}'
fi
