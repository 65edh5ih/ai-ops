## 2026-07-26 public repo の Codex review inbox を全体一覧だけにする

ops-sync の `main` は PR 必須の ruleset で保護されており、毎時更新する review inbox の直接 push が必ず
拒否されていた。ops-runner も同じ保護を導入するため、両 public repo に bypass 権限を与えたり定期 PR を
量産したりせず、走査対象には残したまま private の全体一覧だけへ載せる。リポジトリ別スライスは直接 push を
許容する private consumer に限定する。
