# Verify-web

Discord OAuth2認証Webアプリケーションです。Verify-botはこのWebアプリのHTTPSジョブAPIをBot側からポーリングして利用します。Verify-botの受信APIを公開する必要はありません。

## セットアップ
1. Node.js 18以上を用意します。
2. config.example.jsをconfig.jsにコピーします。
3. Discord OAuth2 Client ID / Client Secret、Webhook URL、秘密鍵などを設定します。
4. config.jsはGitへコミットしないでください（.gitignore対象）。
5. Discord Developer PortalのRedirect URIに https://YOUR-WEB-DOMAIN/auth/callback を登録します。
6. npm install後、npm startで起動します。

## 必須設定
- BOT_API_SECRET: Verify-bot側のWEB_API_SECRETと同じ値。32文字以上のランダム値。
- JOB_ENCRYPTION_KEY: 32バイトの暗号鍵を64文字の16進数で指定。生成例: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"。Gitへコミットしないでください。
- SESSION_SECRET: 32文字以上のランダム値。
- DATABASE_PATH: 永続ディスク上のSQLiteファイルパス。例 ./data/verification.sqlite。

## ポート設定
起動ポートは process.env.PORT || 3000 で取得します。PORT以外の環境変数は参照せず、その他の設定はconfig.jsで管理します。

## 通信方式
- OAuth2 callback後、アクセストークンをAES-256-GCMで暗号化してSQLiteに一時保存します。
- Verify-botはGET /internal/jobs/nextをHTTPSで定期取得します。
- 成功時はPOST /internal/jobs/:jobId/complete、失敗時はPOST /internal/jobs/:jobId/failを呼び出します。
- 内部APIはAuthorization: Bearer BOT_API_SECRETで保護します。
- ジョブはリース期限切れ後に再取得でき、最大5回まで試行します。完了または最終失敗時に暗号化アクセストークンを削除します。

## OAuth2とIP
使用scopeはidentify guilds.join。stateをセッションに保存して照合します。OAuthアクセストークンはWebhookやログに出力しません。認証時に観測したIPを成功Webhookに通知します。IPの利用目的、保存期間、閲覧権限を適切に管理してください。リバースプロキシ環境ではTRUST_PROXY_HOPSを実際の構成に合わせてください。

## 永続ストレージ
DATABASE_PATHの親ディレクトリにSQLite DBとセッションDBを保存します。MWSで再起動・再デプロイ後も保持されるか実機確認してください。保持されない場合は永続ボリュームを使用してください。
