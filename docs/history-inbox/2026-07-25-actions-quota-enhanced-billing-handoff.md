## 2026-07-25 Actions月枠の実測は enhanced billing 側で未完（unknown 固定）と判明

PAT 登録後の初回実測で `source: enhanced:users` が判明。**このアカウントは enhanced billing platform 側**で、
含有枠に対する使用分数を直接返す旧 API が使えない。enhanced API は金額ベースの明細しか返さないため、
実装の enhanced 経路は「課金発生＝exhausted / 未課金＝unknown」の二択しか出せず、**当初要件（9割超えで
止める）を満たしていない**。

放置の是非: `unknown` は安全側（逼迫扱い）に倒れるので危険はないが、private repo での自発 dispatch が
永久に止まる。安全だが何も動かせない状態なので残作業として明示した。

残作業と壊してはいけない不変条件は `docs/reference/ACTIONS_QUOTA_NEXT_STEPS.md` に切り出した
（別セッションへの引き継ぎ用に1ファイルへ集約。パスだけ渡せば cold start でも追えるようにした）。
併せて配布 doc `shared/docs/actions-quota.md` にも既知の制限として注記した——消費側が `unknown` を見て
「壊れているから無視してよい」と誤判断すると fail-closed の意味が消えるため、止まる挙動自体は意図どおりだと
明記している。

学び: 「どちらの API 経路が生きているか」は docs からは確定できず、**実際に叩くまで分からなかった**
（docs.github.com は enterprise-cloud 版へリダイレクトする）。両方試して source を記録する実装にしておいた
ことで、PAT 登録の初回実行だけで確定できた。外部 API の分岐は推測で片方に決め打ちせず、実測で確定する
作りにしておくと後が楽。
