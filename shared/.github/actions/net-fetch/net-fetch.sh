#!/usr/bin/env bash
# net-fetch クリーンルーム取得スクリプト。
#
# AI エージェントの代理で「許可ドメインだけ」を公開取得する。実行環境には secret を一切渡さない
# （＝取得内容に secret を混ぜられない構造的な縛り）。allowlist・SSRF ガード・secret スキャンを
# ここで enforce する。呼び出しは composite action（action.yml）から。単体でもテスト可能:
#
#   NF_URL=https://example.com/ NF_REQUEST_ID=t1 NF_OUTPUT_DIR=/tmp/out \
#   NF_ALLOWLIST_FILES=path/to/allow.txt ./net-fetch.sh
#
# 入力（環境変数）:
#   NF_URL             取得先 URL（https のみ）
#   NF_METHOD          GET|HEAD（既定 GET。それ以外は拒否）
#   NF_REQUEST_ID      相関 ID。[A-Za-z0-9._-]+ のみ
#   NF_ALLOWLIST_FILES 空白区切りの allowlist ファイル群（存在するものだけ読む・union）
#   NF_OUTPUT_DIR      結果の書き出し先ディレクトリ（既定 net-fetch-out）
#   NF_MAX_BYTES       応答本文の上限バイト（既定 5242880 = 5MiB）
#   NF_TIMEOUT_SECONDS 取得タイムアウト秒（既定 30）
#
# 出力: NF_OUTPUT_DIR/ に status.txt / meta.txt / response.txt（ok 時のみ）/ headers.txt（ok 時のみ）。
#   status.txt の1行目は ok|rejected|error。job は基本失敗させない（結果は必ず publish して読ませる）。
#   GITHUB_OUTPUT があれば status / http_status / result_dir を出力する。
set -uo pipefail

URL="${NF_URL:-}"
METHOD="${NF_METHOD:-GET}"
REQUEST_ID="${NF_REQUEST_ID:-}"
ALLOWLIST_FILES="${NF_ALLOWLIST_FILES:-.github/net-allowlist.txt .github/net-allowlist.local.txt}"
OUTPUT_DIR="${NF_OUTPUT_DIR:-net-fetch-out}"
MAX_BYTES="${NF_MAX_BYTES:-5242880}"
TIMEOUT_SECONDS="${NF_TIMEOUT_SECONDS:-30}"

# secret とみなすパターン（request 拒否 / response 伏字の両方で使う）
SECRET_PATTERNS=(
  'gh[pousr]_[A-Za-z0-9]{20,}'
  'github_pat_[A-Za-z0-9_]{20,}'
  'AKIA[0-9A-Z]{16}'
  'ASIA[0-9A-Z]{16}'
  'xox[baprse]-[A-Za-z0-9-]{10,}'
  'AIza[0-9A-Za-z_-]{35}'
  'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}'
  '-----BEGIN[A-Z ]*PRIVATE KEY-----'
)
# request の URL/クエリに現れたら拒否する secret 臭いキー
SECRET_QUERY_KEYS='(access_token|api_key|apikey|client_secret|password|token|authorization)='

mkdir -p "$OUTPUT_DIR"
status="error"; http_status=""; reason=""

# 出力（meta.txt・要約）に載せる URL は secret を伏字にする。secret 混入で拒否したときに、生 URL を
# meta.txt 経由で公開 ci-logs（集約モード）へ記録してしまうのを防ぐ。
redact_secrets() {
  local s="$1" p
  for p in "${SECRET_PATTERNS[@]}"; do
    s="$(printf '%s' "$s" | sed -E "s/$p/[REDACTED-SECRET]/g")"
  done
  # 伏字の境界は拒否パターン（SECRET_QUERY_KEYS）と揃える。拒否は key= を位置を問わず一致させるので、
  # 伏字も ?/& 直後に限定しない（例: path;access_token=secret も伏字する）。値終端は真の区切り（& # 空白）だけに
  # し、; は値内に含めて丸ごと伏字する（?access_token=abc;def のように ; を含む値の残り ;def を残さない）。
  # 拒否された URL の記録なので過剰伏字は安全（漏らすより伏字しすぎる方に倒す）。
  printf '%s' "$s" \
    | sed -E 's|(://)[^/?#@]*@|\1[REDACTED-USERINFO]@|' \
    | sed -E 's/((access_token|api_key|apikey|client_secret|password|token|authorization)=)[^[:space:]&#]*/\1[REDACTED]/gI'
}
# ファイルを in-place で伏字にする。PEM 秘密鍵は BEGIN 行だけでなく本文・END まで丸ごと（行単位の
# sed だと BEGIN 行しか消えず base64 本文が残るため）。そのあと単一行に載る token 類を sed で伏字。
redact_file() {
  local f="$1" p
  [ -f "$f" ] || return 0
  awk '
    /-----BEGIN[A-Za-z ]*PRIVATE KEY-----/ { print "[REDACTED-PRIVATE-KEY]"; inpem=1; next }
    inpem && /-----END[A-Za-z ]*PRIVATE KEY-----/ { inpem=0; next }
    inpem { next }
    { print }
  ' "$f" > "$f.__nf" 2>/dev/null && mv "$f.__nf" "$f"
  for p in "${SECRET_PATTERNS[@]}"; do
    sed -E -i "s/$p/[REDACTED-SECRET]/g" "$f" 2>/dev/null || true
  done
}

SAFE_URL="$(redact_secrets "$URL")"

# request_id は結果スライスのパス素材にもなる（publish の dest = net-fetch/<id>）。.. や / を含むと
# 意図した net-fetch/<id> スライスの外へ publish される（path traversal）。検証を通らない id は
# ユーザー制御でない安全な固定先へ退避し、publish はこの DEST を使う（生入力を dest にしない）。
if printf '%s' "$REQUEST_ID" | grep -Eq '^[A-Za-z0-9._-]+$' && ! printf '%s' "$REQUEST_ID" | grep -q '\.\.'; then
  id_safe="$REQUEST_ID"
else
  id_safe="_invalid-$(date -u +%Y%m%d-%H%M%S)-$$"
fi
DEST="net-fetch/$id_safe"

emit() {
  # status.txt と（あれば）GITHUB_OUTPUT に確定結果を書いて終了する
  printf '%s\n' "$status" > "$OUTPUT_DIR/status.txt"
  [ -n "$reason" ] && printf '%s\n' "$reason" >> "$OUTPUT_DIR/status.txt"
  {
    echo "request_id=$REQUEST_ID"
    echo "url=$SAFE_URL"
    echo "method=$METHOD"
    echo "status=$status"
    echo "http_status=$http_status"
    echo "reason=$reason"
    echo "generated_at_utc=$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  } > "$OUTPUT_DIR/meta.txt"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    {
      echo "status=$status"
      echo "http_status=$http_status"
      echo "result_dir=$OUTPUT_DIR"
      echo "dest=$DEST"
    } >> "$GITHUB_OUTPUT"
  fi
  echo "net-fetch: status=$status http=$http_status reason=${reason:-none} id=$REQUEST_ID"
  # rejected は「正常に弾いた」= job を失敗させない（結果を publish して読ませる）。error は非0で返す。
  case "$status" in
    ok|rejected) exit 0 ;;
    *) exit 1 ;;
  esac
}

reject() { status="rejected"; reason="$1"; emit; }
fail()   { status="error";    reason="$1"; emit; }

matches_secret() {
  # $1 の文字列がいずれかの secret パターンに一致すれば 0
  local s="$1" p
  for p in "${SECRET_PATTERNS[@]}"; do
    printf '%s' "$s" | grep -Eq "$p" && return 0
  done
  return 1
}

# ── 入力検証 ───────────────────────────────────────────────
[ -n "$URL" ] || fail "empty url"
{ printf '%s' "$REQUEST_ID" | grep -Eq '^[A-Za-z0-9._-]+$' && ! printf '%s' "$REQUEST_ID" | grep -q '\.\.'; } \
  || fail "invalid request_id (allowed: A-Za-z0-9._- and must not contain '..')"
case "$METHOD" in GET|HEAD) : ;; *) reject "method not allowed (GET/HEAD only): $METHOD" ;; esac

# scheme は https のみ
printf '%s' "$URL" | grep -Eq '^https://' || reject "scheme must be https"

# host を取り出す: scheme を除去 → 最初の / まで → クエリ/フラグメントを除去 → userinfo(@) を除去 → port を除去
# パスの無い URL（https://example.com?x=1 や https://example.com#frag）でも host に ?/# を残さない。
hostport="${URL#https://}"; hostport="${hostport%%/*}"
hostport="${hostport%%\?*}"   # クエリを除去
hostport="${hostport%%#*}"    # フラグメントを除去
userinfo_stripped="${hostport##*@}"
[ "$userinfo_stripped" != "$hostport" ] && reject "userinfo (credentials) in URL is not allowed"
host="${userinfo_stripped%%:*}"
host="$(printf '%s' "$host" | tr '[:upper:]' '[:lower:]')"
[ -n "$host" ] || reject "could not parse host"

# request 側 secret スキャン（URL 全体・クエリキー）
matches_secret "$URL" && reject "url appears to contain a secret; refusing to send it outbound"
printf '%s' "$URL" | grep -Eiq "$SECRET_QUERY_KEYS" && reject "url contains a secret-like query parameter; refusing"

# ── SSRF ガード（allowlist と無関係に常に禁止）───────────────
# IP リテラル（IPv4）・IPv6（: を含む）・localhost・クラウドメタデータ等を拒否。allowlist は
# ドメイン名前提なので通常一致しないが、明示的に弾いて意図を固定する。
case "$host" in
  localhost|*.localhost|*.local|metadata.google.internal|metadata|instance-data|instance-data.*)
    reject "host is a blocked internal name: $host" ;;
esac
printf '%s' "$host" | grep -Eq '^[0-9]+(\.[0-9]+){3}$' && reject "IP-literal host is not allowed: $host"
printf '%s' "$host" | grep -q ':' && reject "IPv6-literal host is not allowed: $host"

# ── allowlist 判定（共通 ∪ ローカルの union）─────────────────
allow_entries=()
for f in $ALLOWLIST_FILES; do
  [ -f "$f" ] || continue
  while IFS= read -r line; do
    line="${line%%#*}"; line="$(printf '%s' "$line" | tr -d '[:space:]')"
    line="$(printf '%s' "$line" | tr '[:upper:]' '[:lower:]')"
    [ -n "$line" ] && allow_entries+=("$line")
  done < "$f"
done
[ "${#allow_entries[@]}" -gt 0 ] || reject "allowlist is empty (no domains permitted); nothing can be fetched"

allowed=0
for entry in "${allow_entries[@]}"; do
  if [ "$entry" = "$host" ]; then
    allowed=1; break
  fi
  # *.example.com → foo.example.com にのみ一致（example.com 自身には一致しない）
  if [ "${entry#\*.}" != "$entry" ]; then
    suffix="${entry#\*.}"
    case "$host" in *".$suffix") allowed=1; break ;; esac
  fi
done
[ "$allowed" = 1 ] || reject "host not in allowlist: $host"

# ── クリーンルーム取得（secret を渡さない）───────────────────
# --proto '=https' で https 以外を禁止、--max-redirs 0 でリダイレクト追従を禁止（非許可先への
# 302 リダイレクトによる exfil/迂回を防ぐ）、サイズ・時間を制限。認証情報は一切付けない。
raw_body="$OUTPUT_DIR/.body.raw"
headers="$OUTPUT_DIR/headers.txt"
curl_method=(-X "$METHOD"); [ "$METHOD" = HEAD ] && curl_method=(-I)
http_status="$(
  curl --proto '=https' --tlsv1.2 -sS \
       --max-redirs 0 --max-filesize "$MAX_BYTES" --max-time "$TIMEOUT_SECONDS" \
       "${curl_method[@]}" \
       -D "$headers" -o "$raw_body" -w '%{http_code}' \
       "$URL" 2> "$OUTPUT_DIR/.curl.err"
)"
curl_rc=$?
if [ "$curl_rc" -ne 0 ]; then
  fail "curl failed (rc=$curl_rc): $(tr '\n' ' ' < "$OUTPUT_DIR/.curl.err" | cut -c1-300)"
fi

# サイズ上限のハードカット（Content-Length の無い chunked 応答対策）
[ -f "$raw_body" ] || : > "$raw_body"
head -c "$MAX_BYTES" "$raw_body" > "$OUTPUT_DIR/.body.cut" && mv "$OUTPUT_DIR/.body.cut" "$raw_body"

# ── response 側 secret 伏字（万一混ざっても外に残さない）──────
redacted="$OUTPUT_DIR/response.txt"
cp "$raw_body" "$redacted"
redact_file "$redacted"      # 本文（PEM ブロック＋token 類）
redact_file "$headers"       # ヘッダ（Set-Cookie 等）
rm -f "$raw_body" "$OUTPUT_DIR/.curl.err"

status="ok"; reason=""
emit
