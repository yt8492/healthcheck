# Healthcheck

Google Health APIから本人の心拍を取得し、Firestoreに1分の平均・最小・最大を90日保存する公開APIとダッシュボード。現在の到達点は心拍の同期・保存・24時間表示です。睡眠・活動・日別生体指標、長期間の表示用集計、定期実行、クラウド公開は次の到達点で追加します。

## ローカル起動

Node.js 24 LTS、npm、Java 21以上（Firestore Emulator用）が必要です。

```sh
npm ci
cp .env.example .env
```

**架空データで確認する場合**は、別々のターミナルで次を実行します。Emulatorには検証専用の`demo-healthcheck`を使用し、実際のプロジェクトには架空データを保存しません。

```sh
# ターミナル1。jenvを使っている場合は、必要に応じてJENV_VERSION=25.0.1を付ける
npm run emulator
```

```sh
# ターミナル2
GOOGLE_CLOUD_PROJECT=demo-healthcheck npm run seed:emulator
GOOGLE_CLOUD_PROJECT=demo-healthcheck FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 npm run dev
```

画面は http://localhost:5173 、APIは http://127.0.0.1:3001 。画面に「Emulatorの架空データ」と表示されます。終了するときは各ターミナルでCtrl+Cを押します。Emulatorのデータは終了時に消えます。

## 本人のデータを接続する

以下の`YOUR_PROJECT_ID`は接続先のGoogle CloudプロジェクトIDに置き換えてください。Cloud IAM認証と、心拍の読み取りに使う本人のOAuth認証は別々に設定します。実際の設定はGitに含めない`.env`と`.local/`に保存します。

1. [Google Cloud Console](https://console.cloud.google.com/apis/credentials)で対象プロジェクトを選び、Google Auth Platformのブランド情報・対象ユーザーを設定します。External / Testingの場合は本人をテストユーザーに追加します。
2. データアクセスに次のスコープを追加します。今回の到達点では心拍の読み取りだけを要求します。

   `https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly`

3. OAuthクライアントを**ウェブアプリケーション**として作成し、「承認済みのリダイレクトURI」に以下を完全一致で登録します。JavaScript生成元は不要です。

   `http://127.0.0.1:8787/oauth/callback`

4. クライアントのJSONをダウンロードし、`.local/oauth-client.json`に保存します。チャットやGitには秘密の値を貼り付けないでください。別の場所に保存した場合は`.env`の`GOOGLE_OAUTH_CLIENT_FILE`を変更します。
5. Cloud CLIとローカルのFirestore SDKを認証します。

```sh
gcloud auth login
gcloud auth application-default login
gcloud auth application-default set-quota-project YOUR_PROJECT_ID
```

6. 既定のFirestoreデータベースが存在するか確認します。既存DBがあれば、そのモード・リージョンを確認して利用します。新規の場合はStandard / Native mode / `(default)`を作成し、初期セキュリティルールは「制限付き」にします。日本からの利用を想定したリージョンは東京`asia-northeast1`です。APIと同期処理もDBと同じリージョンに配置します。

```sh
gcloud firestore databases describe --project=YOUR_PROJECT_ID --database='(default)'
```

7. 本人のFitbitと連携したGoogleアカウントで接続します。コマンドに表示されるURLをブラウザで開いて同意してください。

```sh
npm run connect
# JSONを別の場所に置いた場合
npm run connect -- --client /absolute/path/oauth-client.json
```

コールバックは127.0.0.1でのみ待ち受け、stateとPKCEを検証します。getIdentityによる連携確認に成功してから、選択したOAuthクライアント情報とrefresh tokenを`.local/google-health-tokens.json`へ権限0600で保存します。同期時にはこのファイルを使うため、`--client`で指定したクライアントとの組み合わせが保たれます。アクセス・refresh tokenや本人のIDはログに出しません。

8. `.env`に`GOOGLE_CLOUD_PROJECT=YOUR_PROJECT_ID`を設定し、`FIRESTORE_EMULATOR_HOST`を指定せずに同期・起動します。シェルの環境変数は`.env`より優先されるため、別プロジェクトの設定がある場合も接続先が一致するよう、コマンドで明示します。

```sh
GOOGLE_CLOUD_PROJECT=YOUR_PROJECT_ID npm run sync:heart
GOOGLE_CLOUD_PROJECT=YOUR_PROJECT_ID npm run dev
```

通常同期は直近48時間を重ねて再取得します。明示指定では最大7日まで取り込めます。保存対象は現在から90日以内、開始を含み終了を含まない1分境界の範囲です。

```sh
GOOGLE_CLOUD_PROJECT=YOUR_PROJECT_ID npm run sync:heart -- --from 2026-10-09T00:00:00+09:00 --to 2026-10-10T00:00:00+09:00
GOOGLE_CLOUD_PROJECT=YOUR_PROJECT_ID npm run prune
```

External / Testingのrefresh tokenは対象スコープで原則7日で期限が切れます。継続運用時には同意画面の公開状態を確認してください。[OAuthトークンの期限](https://developers.google.com/identity/protocols/oauth2#expiration)

Google Health APIの公式資料には、新規プロジェクトのオンボーディングが制限されている旨が記載されています。APIを有効にできても実データの利用可否が確定したとは限りません。接続で403が返る場合はプロジェクトの利用対象・本人のFitbit連携・スコープを確認します。[APIの公式リファレンス](https://developers.google.com/health/reference/rest/v4/users/getIdentity)

## 保存とAPI

- `seriesHourly/heart-rate_<UTC時間>`：60個の`{avg,min,max} | null`。内容が変わった時間だけ更新します。`points`はインデックス対象から外します（`infra/firestore.indexes.json`）。
- `syncState/heart-rate`：最終試行・成功、取得範囲、最新測定日時、安全なエラーコード。
- `jobLease/heart-rate`：10分の期限付き同期ロック。保存時にも所有権と期限を確認します。

Google Health APIの`rollUp`に`windowSize: "60s"`を指定し、全ページの取得完了後に範囲を更新します。JSONを直接処理するためファイルのアップロードやCloud Storageは不要です。欠損は0にせずnullにします。訂正・削除を反映し、取得失敗では保存済みの値を保持します。[rollUpの仕様](https://developers.google.com/health/reference/rest/v4/users.dataTypes.dataPoints/rollUp)

データ源は`google-wearables`。FitbitとPixel Watchなどを含み、Airだけを分離する指定ではありません。平均は有効な「1分平均」の算術平均です。元の秒単位サンプル数が上流から返らないため、秒単位測定すべての厳密な平均にはなりません。[心拍集計の仕様](https://developers.google.com/health/reference/rest/v4/HeartRateRollupValue)

| GET | 内容 |
| --- | --- |
| `/api/v1/timeseries?metric=heart-rate&from=…&to=…&resolution=1m` | 欠損を含む1分値、単位、集計方法、期間統計、同期状態 |
| `/api/v1/summary?from=…&to=…` | 期間平均・最小・最大、取得できた分数、期間内の最新測定 |
| `/api/v1/status` | 最終同期成功と最新測定日時を分けて返す |
| `/healthz` | プロセスの稼働確認 |

日時はタイムゾーン付きRFC 3339、分境界、開始を含む・終了を含まない指定。日時を省略すると直近24時間。1回は最大4,096分、測定から90日以内。`resolution=auto`もこの段階では1mです。不正入力は400、DB障害は503。90日を超えた値は削除ジョブが停止していてもAPIから返しません。読み取りAPIのログインは不要です。

機械可読な契約は`docs/openapi.yaml`にあります。API成功応答は30秒間キャッシュでき、エラー応答はキャッシュしません。

## 検証・ビルド

```sh
npm run check
npm test
npm run test:emulator
# 起動済みEmulatorを使う場合
GOOGLE_CLOUD_PROJECT=demo-healthcheck FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 npm run test:integration
# 先にEmulatorを起動。テスト用データを投入して画面を確認する
npx playwright install chromium
npm run test:e2e
npm run build
GOOGLE_CLOUD_PROJECT=demo-healthcheck FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 PORT=3001 npm start
```

Cloud Run向けに`Dockerfile`を用意しています。Serviceは`dist/api/server.js`、Jobは`dist/sync/cli.js sync`を実行します。実際のデプロイ、IAM権限の分離、Scheduler、Secret Managerへの登録は次の作業です。同期プロセスは`GOOGLE_HEALTH_CREDENTIAL_SECRET=projects/…/secrets/…/versions/latest`で`{client_id,client_secret,refresh_token}`のJSONを読み取れます。閲覧用プロセスにこの秘密への権限は必要ありません。

実データによる値・時刻の照合は本人のOAuth接続とFirestore準備後に行います。Emulatorでの合格は、Google Health APIで本人のデータが取得できることの証明とは区別します。

## ブランディング掲載用の文書

- [プライバシーポリシー](PRIVACY_POLICY.md)
- [利用規約](TERMS_OF_SERVICE.md)

紹介ページと両文書は、GitHub Pagesで静的サイトとして公開します。

| Google Auth Platformの設定 | 値 |
| --- | --- |
| ホームページ | `https://healthcheck.yt8492.com/` |
| プライバシーポリシー | `https://healthcheck.yt8492.com/privacy/` |
| 利用規約 | `https://healthcheck.yt8492.com/terms/` |
| 承認済みドメイン | `yt8492.com` |

`site/`には紹介ページ、共通レイアウト、CSS、ビルドスクリプトを配置しています。上記のルートMarkdownを原本とし、`npm run build:site`でHTMLに変換します。初回は`npm ci --prefix site`でサイト専用の依存関係を導入してください。ローカル確認は`python3 -m http.server 8788 --bind 127.0.0.1 --directory site/dist`で起動できます。

GitHub Pagesの公開元は「GitHub Actions」です。`.github/workflows/pages.yml`が`main`上のサイト・文書の変更を検出し、`site/dist`だけを公開します。ダッシュボード、API、健康データ、OAuth設定ファイルは公開物に含めません。公開先のドメインはビルドスクリプトとGitHub PagesのCustom domainで指定します。

Cloudflareでは`healthcheck`のCNAMEを`yt8492.github.io`へ向け、プロキシを「DNSのみ」、TTLを自動にします。既存の`yt8492.com`のサイトや他のDNSレコードは変更しません。GitHub Pages側で証明書が発行された後に「Enforce HTTPS」を有効にします。

ブランディングの所有権確認は、Google Cloudプロジェクトの所有者アカウントでGoogle Search Consoleに`yt8492.com`のドメインプロパティを追加し、指定されたDNSのTXTレコードで行います。GitHub Pages側のDNS確認とGoogleの所有権確認は別の手続です。

現行の心拍機能、運営者本人のデータの公開、一般の閲覧者のアカウント連携を受け付けない運用を前提にしています。取得指標や共有方法を追加する場合は、文書と連携時の説明を更新します。

Google Auth Platformに登録する際は、Markdownを閲覧可能なウェブページとして公開し、ホームページと同じドメインの公開URLを指定します。ホームページからも両文書へのリンクを設けます。[Googleのブランディング掲載要件](https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification#application_privacy_policy_link_requirements)

公開準備では、連携前の健康データ取得・公開に関する説明と明示的な同意、ローカル環境を含む認証情報の保存時暗号化を確認します。現行のローカルOAuthファイル保存はJSONとファイル権限の制限であり、アプリによる暗号化は行っていません。文書の作成だけで公開要件への対応が完了するものではありません。[Google Health APIの同意・安全管理要件](https://developers.google.com/health/policies/health-api-developer-user-data-policy)
