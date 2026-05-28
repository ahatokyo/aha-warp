# AHA WARP

AIがあなたの顔で動画を生成するサービス。

## 構成ファイル

| ファイル | 役割 |
|---|---|
| `index.html` | 動画生成メイン画面（要ログイン） |
| `login.html` | ログイン / 新規登録 |
| `pricing.html` | 料金プラン選択 |
| `mypage.html` | マイページ（クレジット確認・Asset ID登録） |

## 使用サービス

- **Supabase** — 認証・DB（`profiles`, `jobs`, `reviews` テーブル）
- **Make.com** — バックエンド自動化（動画生成・Webhook処理）
- **Stripe** — 課金・サブスクリプション管理
- **BytePlus Seedance** — AI動画生成エンジン

---

## Make.com Scenario 3 — Stripe Webhook → Supabase PATCH

Stripeの `customer.subscription.updated` イベントを受け取り、Supabase の `profiles` テーブルをプランに応じて更新するシナリオ。

### Supabase PATCH URL パラメータ

```
?email=eq.{{3.data.email}}
```

> `3` はシナリオ内のモジュール番号（Stripe Webhook モジュール）。

### Body — plan フィールドのパス

```
1.data.object.items.data[1].price.product
```

Stripe の `product` ID を Supabase の `plan` カラムに書き込む。

### credits_remaining / videos_limit の条件分岐

Stripe の `unit_amount`（税抜き月額）に応じて下記のとおり設定する。

| unit_amount | plan | credits_remaining / videos_limit |
|---|---|---|
| `4980` | STARTER | `6` |
| `14800` | CREATOR | `18` |
| それ以外 | BUSINESS | `60` |

パス: `1.data.object.items.data[1].price.unit_amount`

### 補足

- `1.data.object.items.data[1]` は Stripe Subscription Items の 2番目（インデックス1）を指す。インデックス0はプロモーション等の場合がある。
- PATCH が成功すると `profiles.plan`, `profiles.credits_remaining`, `profiles.videos_limit` が更新される。
