#!/usr/bin/env sh
# Stop フック: 追跡対象（共通基盤・スクリプト・workflow 等）を変更したセッションで、
# 履歴記録（docs/AI_TASK_HISTORY.md）に触れず完了しようとしたら、完了境界で1度だけ
# block して記録を促す。役割は *忘却の防止* であって記録の保証ではない。
#
# 終端保証: `stop_hook_active`（前回の block からの継続）ならもう一度は止めず通す
# ＝1セッションの完了シーケンスで最大1回しか block しない。
# 安全側: git が無い/差分が取れない等の不確実なケースでは exit 0（block しない）。

input=$(cat 2>/dev/null)

# 前回この Stop フックの block で継続したターンなら、もう促したので通す（無限ループ回避）。
case "$input" in
  *'"stop_hook_active":true'*|*'"stop_hook_active": true'*) exit 0 ;;
esac

dir="${CLAUDE_PROJECT_DIR:-.}"
cd "$dir" 2>/dev/null || exit 0

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

# ブランチの分岐点。origin/main が取れなければ直前コミットで代用。
base=$(git merge-base origin/main HEAD 2>/dev/null || true)
[ -z "$base" ] && base=$(git rev-parse HEAD~1 2>/dev/null || true)
[ -z "$base" ] && exit 0

# 分岐点以降のコミット差分 ＋ 作業ツリー（未コミット・ステージ済み・未追跡）を合算。
changed=$(
  {
    git diff --name-only "$base" HEAD 2>/dev/null
    git diff --name-only 2>/dev/null
    git diff --name-only --cached 2>/dev/null
    git ls-files --others --exclude-standard 2>/dev/null
  } | sort -u
)
[ -z "$changed" ] && exit 0

# 履歴記録を要する追跡対象に触れているか。
infra=$(printf '%s\n' "$changed" | grep -E '^(AGENTS_COMMON\.md|AGENTS\.md|README\.md|shared/|tasks/|scripts/|sync-deletions\.txt|consumers\.txt|\.github/|\.claude/)' || true)
[ -z "$infra" ] && exit 0

# AI_TASK_HISTORY.md を更新済みなら即通す。
if printf '%s\n' "$changed" | grep -qE '^docs/AI_TASK_HISTORY\.md$'; then
  exit 0
fi

# それ以外は完了境界で1度だけ block して記録を促す。
cat <<'JSON'
{"decision":"block","reason":"作業履歴の記録がまだのようです（完了境界での確認）。今回の変更の「なぜ」（コードに無い制約・判断根拠）を docs/AI_TASK_HISTORY.md の先頭へ追記してください。記録、または『記録不要』の判断がついたら、そのまま完了して構いません（この確認は1回だけです）。"}
JSON
exit 0
