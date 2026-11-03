# Verify-web

Discord OAuth2認証Webアプリケーションです。Verify-botはこのWebアプリのHTTPSジョブAPIをBot側からポーリングして利用します。Verify-botの受信APIを公開する必要はありません。

## セットアップ

1. Node.js 18以上を用意します。
2. `config.example.js` を `config.js` にコピーします。
3. Discord OAuth2 Client ID / Client Secret、Webhook URL、秘密鍵などを設定します。
4. `config.js` はGitへコミットしないでください（`.gitignore` 対象）。
5. Discord Developer PortalのRedirect URIに `https://YOUR-WEB-DOMAIN/auth/callback` を登録します。
6. `npm install` 後、`npm start` で起動します。

## 必須設定

- `BOT_API_SECRET`: Verify-bot側の `WEB_API_SECRET` と同じ値。32文字以上のランダム値。
- `JOB_ENCRYPTION_KEY`: 32バイトの暗号鍵を64文字の16進数で指定。生成例: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`。Gitへコミットしないでください。
- `SESSION_SECRET`: 32文字以上のランダム値。
- `DATABASE_PATH`: 永続ディスク上のSQLiteファイルパス。例 `./data/verification.sqlite`。

## ポート設定

起動ポートは `process.env.PORT || 3000` で取得します。PORT以外の環境変数は参照せず、その他の設定は `config.js` で管理します。

## 通信方式

- OAuth2 callback後、アクセストークンをAES-256-GCMで暗号化してSQLiteに一時保存します。
- Verify-botは `GET /internal/jobs/next` をHTTPSで定期取得します。
- 成功時は `POST /internal/jobs/:jobId/complete`、失敗時は `POST /internal/jobs/:jobId/fail` を呼び出します。
- 内部APIは `Authorization: Bearer BOT_API_SECRET` で保護します。
- ジョブはリース期限切れ後に再取得でき、最大5回まで試行します。完了または最終失敗時に暗号化アクセストークンを削除します。

## OAuth2とIP

使用scopeは `identify guilds.join`。stateをセッションに保存して照合します。OAuthアクセストークンはWebhookやログに出力しません。認証時に観測したIPを成功Webhookに通知します。IPの利用目的、保存期間、閲覧権限を適切に管理してください。リバースプロキシ環境では `TRUST_PROXY_HOPS` を実際の構成に合わせてください。

## 永続ストレージ

`DATABASE_PATH` の親ディレクトリにSQLite DBとセッションDBを保存します。MWSで再起動・再デプロイ後も保持されるか実機確認してください。保持されない場合は永続ボリュームを使用してください。

## ライセンス

このプロジェクトは [Apache License 2.0](LICENSE) の下で公開されています。

著作権表示およびライセンス文を保持することを条件に、商用利用・改変・再配布が許可されています。改変したファイルには変更した旨を明記してください。詳細はLICENSEファイルを確認してください。

Copyright 2026 walnut1210
