#!/bin/bash
# 配布フック（正本: ai-ops shared/.claude/hooks/session-start.sh。手編集しない・直したいときは outbox 提案）。
# セッション開始時に:
#   1. マージ済みブランチ再push を弾く pre-push フックを有効化（core.hooksPath）。
#   2. docs/AI_CONTEXT.md があれば全文注入（安定したプロジェクト前提。無い repo は skip）。
#   3. タスク履歴は「見出し(TOC)」だけ注入し、本文はエージェントがオンデマンドで読む
#      （tiered memory: 小さな索引を常時・本文は必要時に page-in。規約: docs/task-history.md）。
# 各 repo の .claude/settings.json の SessionStart から起動される。
set -euo pipefail

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"

# core.hooksPath はローカル設定でエフェメラルなコンテナでは毎回消えるため張り直す。
# 仕組みの詳細: docs/merged-branch-guard.md / .githooks/pre-push。
if [ -d "$PROJECT_DIR/.githooks" ]; then
  git -C "$PROJECT_DIR" config core.hooksPath .githooks 2>/dev/null || true
fi

# 存在すれば見出し付きで全文出力。
emit_doc() {
  if [ -f "$PROJECT_DIR/$1" ]; then
    printf '=== %s ===\n' "$1"
    cat "$PROJECT_DIR/$1"
    printf '\n'
  fi
}

# タスク履歴の見出し(TOC)だけを出力する（本文は載せない）。本文はエージェントが
# 関係する見出しを見て該当ファイルをオンデマンドで読む。フラグメントのファイル名は
# ブランチ由来で説明的でないため、TOC は各エントリの `## ` 見出し行から作り、読むべき
# ファイルパスを添える。
history_toc() {
  main_file="$PROJECT_DIR/docs/AI_TASK_HISTORY.md"
  inbox_dir="$PROJECT_DIR/docs/history-inbox"
  if [ ! -f "$main_file" ] && [ ! -d "$inbox_dir" ]; then
    return 0
  fi
  printf '=== タスク履歴の見出し（TOC・本文は未読込） ===\n'
  printf '関係する見出しがあれば該当ファイルの本文を読む。古い履歴は docs/history-archive/<YYYY>.md を grep。\n\n'
  if [ -f "$main_file" ]; then
    printf '# 統合済み（本文は docs/AI_TASK_HISTORY.md 内）\n'
    if ! grep -E '^## ' "$main_file"; then
      printf '（エントリなし）\n'
    fi
    printf '\n'
  fi
  if [ -d "$inbox_dir" ]; then
    header_done=''
    for f in "$inbox_dir"/*.md; do
      [ -e "$f" ] || continue
      name=$(basename "$f")
      case "$name" in
        README.md|readme.md) continue ;;
      esac
      if [ -z "$header_done" ]; then
        printf '# 未統合フラグメント（本文は各行のファイルを読む）\n'
        header_done=1
      fi
      { grep -E '^## ' "$f" || true; } | while IFS= read -r line; do
        printf '%s  ←  docs/history-inbox/%s\n' "$line" "$name"
      done
    done
    if [ -n "$header_done" ]; then
      printf '\n'
    fi
  fi
}

output=$(
  echo "【セッション開始時の自動読み込み】"
  echo "docs/AI_CONTEXT.md は全文、タスク履歴は見出しのみ（本文は必要時に各ファイルを読むこと）。"
  echo ""
  emit_doc "docs/AI_CONTEXT.md"
  history_toc
)

# SessionStart フックは hookSpecificOutput.additionalContext でコンテキストを注入する
# （トップレベル message は認識されない。docs: code.claude.com/docs/en/hooks#sessionstart）。
echo "$output" | jq -Rs '{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: .}}'
