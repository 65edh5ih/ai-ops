#!/usr/bin/env sh
# Stop フック: 追跡対象（共通基盤・スクリプト・workflow 等）を変更したセッションで、
# 履歴記録に触れず完了しようとしたら、完了境界で1度だけ block して記録を促す。
#
# 役割は *忘却の防止* であって記録の保証ではない。ai-ops の作業はほとんどが共通基盤の変更で、
# 本体は Notion「AI Cross-Repo Task Log」に書く（外部なのでフックでは検証できない）。
# `docs/history.md` は consumer に届かない ai-ops 内部変更だけの例外。
#
# 終端保証: Notion 書き込みは検証できないので、`stop_hook_active`（前回の block からの継続）なら
# もう一度は止めず通す＝1セッションの完了シーケンスで最大1回しか block しない。
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
infra=$(printf '%s\n' "$changed" | grep -E '^(AGENTS_COMMON\.md|AGENTS\.md|README\.md|shared/|scripts/|consumer-template/|\.github/|\.claude/)' || true)
[ -z "$infra" ] && exit 0

# 例外ケース（ai-ops 内部変更）として history.md を更新済みなら即通す。
if printf '%s\n' "$changed" | grep -qE '^docs/history\.md$'; then
  exit 0
fi

# それ以外は完了境界で1度だけ block して記録を促す。
cat <<'JSON'
{"decision":"block","reason":"作業履歴の記録がまだのようです（完了境界での確認）。ai-ops は共通基盤そのものなので、今回の変更は通常 Notion『AI Cross-Repo Task Log』に「なぜ」を記録します。consumer に届かない ai-ops 内部だけの変更（collect/sync スクリプト・ai-ops 自身の workflow・.claude/ 等）なら例外的に docs/history.md の先頭へ追記。記録、または『記録不要』の判断がついたら、そのまま完了して構いません（この確認は1回だけです）。"}
JSON
exit 0
