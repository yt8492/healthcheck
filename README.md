# Healthcheck

Google Health APIから本人の心拍・睡眠・活動を取得し、Firestoreに90日保存する公開APIとダッシュボード。心拍は1分の平均・最小・最大と24時間表示、睡眠はセッション・段階・覚醒と最大90日の表示に対応しています。Cloud Runと15分ごとの定期同期を利用します。活動は歩数・距離・総消費カロリー・アクティブゾーン時間の1分値と最大90日の集計に対応します。日別生体指標、長期間の心拍集計は今後追加します。

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

以下の`YOUR_PROJECT_ID`は接続先のGoogle CloudプロジェクトIDに置き換えてください。Cloud IAM認証と、心拍・睡眠の読み取りに使う本人のOAuth認証は別々に設定します。実際の設定はGitに含めない`.env`と`.local/`に保存します。

1. [Google Cloud Console](https://console.cloud.google.com/apis/credentials)で対象プロジェクトを選び、Google Auth Platformのブランド情報・対象ユーザーを設定します。External / Testingの場合は本人をテストユーザーに追加します。
2. データアクセスに次の読み取りスコープを追加します。睡眠・活動を取得する前に、更新した紹介ページとプライバシーポリシーを公開し、本人が各データの保存・インターネット公開に同意してください。既存トークンに追加する権限がない場合は再接続が必要です。

   - `https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly`（心拍）
   - `https://www.googleapis.com/auth/googlehealth.sleep.readonly`（睡眠）
   - `https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly`（歩数・距離・総消費カロリー・アクティブゾーン時間）

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
npm run connect -- --sleep --activity
# 心拍だけを接続する場合は --sleep と --activity を省略
# JSONを別の場所に置いた場合
npm run connect -- --sleep --activity --client /absolute/path/oauth-client.json
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
| `/api/v1/timeseries?metric=steps&from=…&to=…&resolution=auto` | 活動の区間合計・日別合計・欠損内訳・単位・指標別同期状態。4指標に対応 |
| `/api/v1/summary?from=…&to=…` | 心拍の期間統計、`sleep`の睡眠内訳、`activity`の4指標の合計・JST日別集計・同期状態 |
| `/api/v1/sleep?from=…&to=…&cursor=…` | 期間と重なる睡眠を終了日時・ID順に最大50件ずつ取得。詳細の開始・終了は実際の値 |
| `/api/v1/status` | 最終同期成功と最新測定日時を分けて返す |
| `/api/v1/health` | プロセスの稼働確認。`/healthz`はローカル互換用 |

日時はタイムゾーン付きRFC 3339、分境界、開始を含む・終了を含まない指定。日時を省略すると直近24時間。心拍のtimeseriesは1回最大4,096分、測定から90日以内。心拍の`resolution=auto`は1mです。活動は最大90日で粒度を切り替えます（後述）。不正入力は400、DB障害は503。90日を超えた値は削除ジョブが停止していてもAPIから返しません。読み取りAPIのログインは不要です。

機械可読な契約は`docs/openapi.yaml`にあります。API成功応答は30秒間キャッシュでき、エラー応答はキャッシュしません。同じCloud Runインスタンスでは、同期状態と同じ期間のFirestore読み取りも30秒間共有します。並行要求をまとめ、失敗は保持せず、心拍・睡眠の期間キャッシュは各最大16件、活動は長期間の分値を扱うため指標ごと最大2件です。

## 睡眠の取得と表示

睡眠の読み取りには`googlehealth.sleep.readonly`への追加同意が必要です。`connect --sleep`は取得・保存・公開について説明したうえで、心拍と睡眠の両権限が許可された場合だけ認証情報を置換します。文書の公開と本人の同意を終える前に、睡眠の取得を開始しないでください。

```sh
# 睡眠のみ。既定は終了日時が直近48時間、最大7日
GOOGLE_CLOUD_PROJECT=YOUR_PROJECT_ID npm run sync:sleep
# 心拍と睡眠を指標別に実行。一方の失敗でも他方を進め、部分失敗時は終了コード1
GOOGLE_CLOUD_PROJECT=YOUR_PROJECT_ID npm run sync
```

睡眠は`dataPoints:reconcile`、`google-wearables`、最大25件で全ページを取得します。上流のフィルターは**終了日時が[from,to)**のセッションです。全ページが成功した範囲だけを置換し、その範囲の消失したセッションを削除します。日跨ぎの開始日時は変更しません。日時が訂正された同じIDのセッションは上書きし、再取得範囲外の訂正・削除は当該範囲を手動で再同期して反映します。90日を取り込む場合は最大7日ずつに分けて指定します。[上流の睡眠フィルター](https://developers.google.com/health/reference/rest/v4/users.dataTypes.dataPoints/list)

- `sleepSessions/<不透明なID>`：開始・終了、JSTの起床日、昼寝の区分、正規化した段階と内訳。本人識別子を含む元のリソース名は保存しません。`stages`はインデックスから除外します。
- `syncState/sleep`、`jobLease/sleep`：心拍とは独立した取得状態とロック。成功した取得範囲は`completedRanges`へ結合し、空でも取得済みとして記録します。権限・通信・保存の失敗は既存値と成功時刻を保持します。APIの`coverage`と画面で未取得・一部取得・取得済みを区別します。表示期間後に終了する睡眠も必要なので、取得済みの判定には表示開始から最終成功時点までの終了日時範囲を使います。
- 短い覚醒・離床は和集合を取り、主段階を分割して覚醒として1回だけ計上します。`ASLEEP`と`LIGHT/DEEP/REM`を睡眠、`RESTLESS`を別区分とし、未提供の段階は`unknown`です。段階が一切不明なら睡眠時間は`null`です。上流の丸め済みsummaryを加算せず、正規化した区間長から計算します。
- 公開APIは`startTime < to && endTime > from`の重なりで検索します。睡眠とsummaryは直近90日までの期間に対応します。睡眠は50件固定のページングで、`nextCursor`が`null`になるまで**同じfrom/to**で取得します。cursorは期間に紐付きます。心拍のtimeseriesは従来どおり最大4,096分です。
- summaryの睡眠内訳は表示期間との重なりだけを計算し、日別の対応付けは元セッションのJST起床日を使います。睡眠APIの詳細はセッション全体の実際の開始・終了・段階です。
- 睡眠の保存期限は**終了日時から90日**です。期限を過ぎたセッションはAPIで除外し、同期・削除処理で物理削除します。開始だけが期限より前のセッションは詳細を保ちます。

画面には睡眠専用の24時間・7日・30日・90日と任意期間があります。短期間は段階のタイムライン、長期間は起床日別の時間・段階内訳を表示します。表示期間はURLの`sleepFrom`/`sleepTo`に保存し、全ページ取得後に集計します。詳細の「この睡眠前後の心拍を見る」で、前後を含む最大24時間の心拍へ移動します。未取得、取得失敗、同期遅延、段階未提供を区別し、データのない理由を未装着と断定しません。

取得仕様と本人データとの照合手順は[睡眠の検証](./docs/sleep-validation.md)にあります。

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

Cloud Run向けに`Dockerfile`を用意しています。Serviceは`dist/api/server.js`、Jobは`dist/sync/cli.js sync`を実行します。同期プロセスは`GOOGLE_HEALTH_CREDENTIAL_SECRET=projects/…/secrets/…/versions/latest`で`{client_id,client_secret,refresh_token}`のJSONを読み取ります。閲覧用プロセスはFirestoreの読み取り専用で、この秘密への権限を持ちません。

実データによる値・時刻の照合は本人のOAuth接続とFirestore準備後に行います。Emulatorでの合格は、Google Health APIで本人のデータが取得できることの証明とは区別します。

## クラウド公開と定期同期

Google Cloud CLIで対象プロジェクトのオーナーとしてログインし、Firestore Native DB、Cloud Billing、本人の接続済みOAuth JSONを用意します。接続先は`.env`やCLIの既定プロジェクトに任せず、毎回`--project`で指定します。

```sh
npm run cloud:deploy -- --project YOUR_PROJECT_ID --region asia-northeast1
```

APIの有効化、専用サービスアカウントと権限、認証情報のSecret登録、コンテナビルド、Service/Jobのデプロイ、初回同期の完了確認、15分ごとのScheduler設定を行い、公開URLを出力します。既存DBと異なるリージョンは拒否します。公開範囲は心拍・睡眠APIとダッシュボードです。既存Secretが心拍だけの場合は、再接続後に`cloud:credentials`で睡眠権限付きの認証情報を登録してから更新します。

ビルドに送るソースは`.gcloudignore`で限定し、OAuthの実際の値が含まれないか送信前に検査します。Cloud Storageにはビルド用のソースを一時配置して1日経過後に削除します。心拍データやOAuth JSONをビルド用Storageへ送ることはありません。詳しい確認・停止・再接続・ロールバック手順は[クラウド運用](./docs/cloud-operations.md)にあります。

## ブランディング掲載用の文書

- [プライバシーポリシー](PRIVACY_POLICY.md)
- [利用規約](TERMS_OF_SERVICE.md)

独自ドメインはFirebase Hostingから公開します。ルートはダッシュボード、`/about/`は紹介ページ、`/privacy/`と`/terms/`は両文書です。`/api/**`だけを同じプロジェクトのCloud Run Service `healthcheck`（`asia-northeast1`）へ中継します。

| Google Auth Platformの設定 | 値 |
| --- | --- |
| ホームページ | `https://health.yt8492.com/` |
| プライバシーポリシー | `https://health.yt8492.com/privacy/` |
| 利用規約 | `https://health.yt8492.com/terms/` |
| 承認済みドメイン | `yt8492.com` |

`site/`には紹介ページ、共通レイアウト、CSS、ビルドスクリプトを配置しています。上記のルートMarkdownを原本とし、`npm run build:site`でHTMLに変換します。初回は`npm ci --prefix site`でサイト専用の依存関係を導入してください。ローカル確認は`python3 -m http.server 8788 --bind 127.0.0.1 --directory site/dist`で起動し、`http://127.0.0.1:8788/about/`を開きます。

`npm run build:hosting`でダッシュボードと紹介・規約ページを`dist/hosting`にまとめます。公開物はブラウザ用のビルド成果物と指定した静的ページだけです。サーバーのコード、健康データ、OAuth設定ファイルは含めません。GitHub Pages用の公開ワークフローは廃止しています。

初回は対象のGoogle CloudプロジェクトにFirebaseを追加してHostingサイトを用意します。更新時は以下でHostingだけを公開します。デプロイ前に画面と静的ページを自動ビルドします。APIと同期処理の更新は別途`cloud:deploy`で行います。

```sh
npx firebase deploy --only hosting --project YOUR_PROJECT_ID
```

Firebase Hostingに`health.yt8492.com`をカスタムドメインとして追加します。Cloudflareの`health`をHostingが指定するCNAMEへ向け、プロキシは「DNSのみ」、TTLは自動にします。所有権と証明書の有効化後、画面とAPIの動作を確認します。旧`healthcheck.yt8492.com`のHosting登録は削除済みです。既存の`yt8492.com`のサイトや他のDNSレコードは変更しません。[Hostingのカスタムドメイン設定](https://firebase.google.com/docs/hosting/custom-domain)

ブランディングの所有権確認は、Google Cloudプロジェクトの所有者アカウントでGoogle Search Consoleに`yt8492.com`のドメインプロパティを追加し、指定されたDNSのTXTレコードで行います。Hosting側のドメイン確認とSearch Consoleの所有権確認は別の手続です。

現行の心拍・睡眠機能、運営者本人のデータの公開、一般の閲覧者のアカウント連携を受け付けない運用を前提にしています。取得指標や共有方法を追加する場合は、文書と連携時の説明を更新します。

Google Auth Platformに登録する際は、Markdownを閲覧可能なウェブページとして公開し、ホームページと同じドメインの公開URLを指定します。ホームページからも両文書へのリンクを設けます。[Googleのブランディング掲載要件](https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification#application_privacy_policy_link_requirements)

公開準備では、連携前の健康データ取得・公開に関する説明と明示的な同意、ローカル環境を含む認証情報の保存時暗号化を確認します。現行のローカルOAuthファイル保存はJSONとファイル権限の制限であり、アプリによる暗号化は行っていません。文書の作成だけで公開要件への対応が完了するものではありません。[Google Health APIの同意・安全管理要件](https://developers.google.com/health/policies/health-api-developer-user-data-policy)

## 活動の取得と表示

取得開始前に活動を説明した紹介ページとプライバシーポリシーを公開し、本人が取得・90日保存・インターネット公開に同意してから、`npm run connect -- --sleep --activity`で既存の心拍・睡眠と活動を許可します。既存トークンの権限は自動拡張されません。Cloud Runでは`cloud:credentials`でSecretを更新します。位置情報の権限は要求しません。

```sh
GOOGLE_CLOUD_PROJECT=YOUR_PROJECT_ID npm run sync:activity
# 一つだけ再取得する場合。既定48時間、最大7日ずつ
GOOGLE_CLOUD_PROJECT=YOUR_PROJECT_ID npm run sync -- --metric steps --from RFC3339 --to RFC3339
# heart-rate / sleep / steps / distance / total-calories / active-zone-minutesをそれぞれ独立して同期
GOOGLE_CLOUD_PROJECT=YOUR_PROJECT_ID npm run sync
```

- 上流は`rollUp`、`google-wearables`、`windowSize=60s`。歩数は歩、距離はmmからmに換算、総消費カロリーはkcal（基礎代謝込み）、アクティブゾーン時間は上流のゾーン別ポイントの和を使い、再加重しません。
- `activityHourly/<metric>/hours/<UTC時間>`に60個の値と`presence`（`value` / `omitted` / `missing`）を保存し、`points`はインデックスから除外します。明示的な0は既知値、値の省略・レコード欠損はnullとして区別します。`syncState/<metric>`と`jobLease/<metric>`は指標別です。取得完了範囲は空でも記録し、未取得と欠損を別に扱います。
- `/api/v1/timeseries?metric=steps&from=…&to=…&resolution=auto`は活動に最大90日対応し、`1m` / `1h` / `1d`を指定できます。`auto`は2日以内が1m、14日以内が1h、それ以上が1d。明示1mは最大4096分。日境界はJSTです。
- `points[]`は`from/to/total/availableMinutes/omittedMinutes/missingMinutes/totalMinutes`。`total`は既知値の和で、既知値が一つもなければnullです。`summary.days`はJSTの日別合計で、端数日・今日の途中は`partialDay=true`。欠けた分がある合計は完全な1日の合計と同一視しません。
- `/api/v1/summary`の`activity`に4指標の合計・日別値・単位・状態・取得範囲を追加し、`/api/v1/status`の`metrics`に指標別状態を返します。訂正・削除は全ページの取得に成功した範囲だけ反映し、部分失敗では他指標を継続し、Jobは終了コード1にします。失敗した指標でも期限削除を試行します。
- 画面は心拍と同じ期間から開始し、活動だけの1日・7日・30日・90日・任意期間も選択できます。異なる単位を同じ軸に重ねず、指標選択で軸を切り替えます。期間・指標は`activityFrom/activityTo/activityMetric`に保存します。

仕様と実データを分けた検証記録は[活動の検証](./docs/activity-validation.md)を参照してください。
