# Verify-web

Discord OAuth2を利用する認証Webアプリケーションです。Verify-botとはHTTPS APIで連携します。

## セットアップ
1. Node.js 18以上を用意します。
2. `config.example.js` を `config.js` にコピーし、Discord OAuth2 Client ID / Client Secret、Webhook URL、Bot API URL、API_SECRET、SESSION_SECRETを設定します。
3. `config.js` はGitへコミットしないでください（.gitignore対象）。
4. Discord Developer PortalのRedirect URIに `https://YOUR-WEB-DOMAIN/auth/callback` を登録します。
5. `npm install` 後、`npm start` で起動します。

## ポート設定
起動ポートは `process.env.PORT || 3000` で取得します。ホスティング環境が `PORT` を指定した場合はその値を使用し、指定がないローカル環境では `3000` を使用します。`PORT` 以外の環境変数は参照せず、その他の設定は `config.js` で管理します。

## OAuth2
使用scopeは `identify guilds.join`。stateをセッションに保存してコールバックで照合します。OAuthアクセストークンはBot APIにサーバー側から渡し、WebhookやDBには保存しません。

## IPアドレス
Webサーバーが観測した接続元IPをWebhook通知します。リバースプロキシ環境では `TRUST_PROXY_HOPS` をホスティング事業者の構成に合わせてください。無条件に全プロキシを信頼しないでください。IPを含むアクセスログ・Webhookログの利用目的、保存期間、閲覧権限を適切に管理してください。

## Bot API
Verify-botのAPI URLと共有API_SECRETを設定します。Bot側のAPI_SECRETと完全一致させてください。Web・Botの双方をHTTPSで公開してください。
