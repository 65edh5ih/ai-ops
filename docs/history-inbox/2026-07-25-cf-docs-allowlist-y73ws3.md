## 2026-07-25 net-fetch 共通 allowlist に developers.cloudflare.com を追加

「枠が `tight` のとき GitHub Actions 側の deploy を自動で止められるか」を設計するのに、
**Cloudflare 側の切替設定（Pages の Build watch paths / Workers Builds の設定）が API で
変更できるか**の裏取りが要る。ここが可能なら両側を自動で反転でき、不可能なら
「GitHub 側だけ止める＝両方 off（どこにもデプロイされない）」を受け入れるかの判断になる——
設計の分岐点そのものなので、推測で決めない。

`developers.cloudflare.com` は公開ドキュメントで認証不要・機微でないため共通ベース
（集約モード＝ public な ai-ops 上での取得）に置ける。機微なら private リポジトリの
ローカル allowlist に置く判断になるが、これは該当しない。
