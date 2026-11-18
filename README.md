# open24 — OpenCode 24/7 継続プラグイン

OpenCode の「止まる理由」を減らし、長時間の作業を最後まで走らせるためのサーバープラグインです。

## 機能

1. **シェル実行タイムアウトの撤廃**
   `ctx.shell.hook("create.before")` で実行前の `timeout` を引き上げます（既定: 24 時間）。
2. **停止時の自動継続**
   ターンが終了したとき、一定時間後に「続きを実行してください」という指示を **synthetic メッセージ** として自動で送ります。
   synthetic はプラグインの通知扱いで、**ユーザーが書いたメッセージとしては表示されません**。
   やることがなくなった場合はモデルが `[[OPEN24-IDLE]]` と出力し、そのセッションの自動継続を一時停止します（次のメッセージで再開）。
3. **失敗時のモデル切替**
   レート制限・タイムアウト・5xx などで失敗した場合、設定したフォールバックモデルへ切り替えて再開します。
   短い失敗は OpenCode 本体のリトライにも乗せます（`ctx.session.hook("retry")`）。

## 設定

`~/.config/opencode/opencode.jsonc` の `plugins` に追加します（ファイルベース設定）。

```jsonc
{
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-open24",
      "options": {
        "delaySeconds": 20,
        "maxDelaySeconds": 600,
        "shellTimeoutMs": 86400000,
        "armByDefault": true,
        "armOnToolUse": true,
        "fallbackModels": [
          { "providerID": "opencode", "modelID": "deepseek-v4.1-flash" },
          { "providerID": "strata", "modelID": "qwen3.8-flash-next-unsloth-q8_0" }
        ]
      }
    }
  ]
}
```

### オプション

| キー | 既定値 | 説明 |
| --- | --- | --- |
| `enabled` | `true` | プラグイン全体の有効/無効 |
| `delaySeconds` | `20` | 停止から継続までの待機秒数 |
| `backoffFactor` | `2` | 連続失敗・ツール未使用時に待機時間を伸ばす倍率 |
| `maxDelaySeconds` | `600` | 待機時間の上限 |
| `shellTimeoutMs` | `86400000` | シェル実行の上限（24 時間）。`0` で無効（OpenCode 既定のまま） |
| `armByDefault` | `false` | すべてのセッションで自動継続を有効にする（24/7 運用では `true` を推奨） |
| `armOnToolUse` | `true` | ツールを使った作業セッションだけ自動継続する（雑談の無限ループ防止） |
| `fallbackModels` | 上記 2 件 | 失敗時に順番に切り替えるモデル |
| `continuePrompt` | 下記 | 自動送信するプロンプト |
| `idleToken` | `[[OPEN24-IDLE]]` | 完了を示すトークン（出力すると次のメッセージまで停止） |
| `noToolSoftLimit` | `8` | ツール未使用が続いたときに待機を最大へ延ばす回数 |
| `retryBaseDelayMs` | `15000` | リトライ間隔の基準 |

既定の `continuePrompt`:

> 前回までの未完了の作業が残っている場合は、まずそれを完了させてください。残っていない場合は、自分で新しい作業を自由に始めて構いません。止まらずに作業を続けてください。本当に何もすることがなく、新しい作業も思いつかない場合だけ、ツールを呼ばずに `[[OPEN24-IDLE]]` とだけ出力してください。

## コマンド

セッションの入力欄から:

- `/open24 on` — このセッションの自動継続を有効化
- `/open24 off` — 停止
- `/open24 status` — 状態表示（待機秒数・送信回数・失敗回数）
- `/open24 full` — フォールバック先の先頭モデル（フルモデル）へ即時切替

## 動作の詳細

- 自動継続の指示は `ctx.session.synthetic` で送ります（`ctx.session.prompt` ではない）。チャット上でユーザーの発言として扱われず、通知として表示されます。通知を完全に隠したい場合は、OpenCode の表示設定でトランスクリプトのスタイルを **quiet**（notices: hidden）にしてください。
- 自動継続の判定は `session.idle` と `session.execution.succeeded` の両方で行い、1.5 秒以内の重複は無視します。
- `session.execution.started` が来たら予約中の継続は取り消します（ユーザーが自分で話しかけた場合に二重送信しない）。
- `session.execution.interrupted`（明示的な停止）では再開しません。
- 完了トークンを検出すると、そのセッションは「停止」として保存され、`/open24 on` まで再開しません。
- モデル切替はセッションに残ります。元のモデルへ自動で戻すことはしません（必要なら UI か `/model` で切り替え）。
- 失敗のリトライは OpenCode 本体の試行上限の範囲内です。上限に達した場合は `session.execution.failed` から
  新しいターンとして再開するため、実質的に回数制限なく継続します。

## 注意

- フォールバック先に従量課金モデルを入れると、無料モデルの制限時に自動で課金モデルを使います。
  不要なら `fallbackModels` から外してください（ローカルの `strata` のみにする等）。
- `shellTimeoutMs` を大きくすると、入力待ちなどで固まったコマンドも長時間止まったままになります。
  必要に応じて `3600000`（1 時間）などへ下げてください。
- 完全な無制限を望む場合は `armByDefault: true` にします（全セッションで停止のたびに継続します）。このリポジトリの推奨設定も `true` です。
- `session.execution.interrupted`（ユーザーが明示的に停止）では再開しません。止めたいときは UI の停止ボタンを使ってください。

## 開発

```sh
npm install
npx tsc --noEmit
```

OpenCode は `package.json` の `"."` エクスポート（`src/index.ts`）を直接読み込みます。ビルドは不要です。

## ライセンス

MIT
