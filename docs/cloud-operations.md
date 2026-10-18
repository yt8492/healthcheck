# クラウド運用

既存Firestore Native DBと同じリージョンに、心拍・睡眠・活動のダッシュボード・読み取りAPIと定期同期を配置する。心拍は1分の平均・最小・最大と日時、睡眠は開始・終了・時間・段階・覚醒を公開する。同期状態は指標別に返す。日別生体指標は今後の追加対象。活動は歩数・距離・総消費カロリー・アクティブゾーン時間と日時・日別合計を公開する。

## 構成と権限

| リソース | 設定・用途 |
| --- | --- |
| Cloud Run Service `healthcheck` | 公開HTTPS、1 vCPU / 512 MiB、リクエスト単位課金、Service全体とRevisionの最小0 / 最大1、同時リクエスト40、リクエスト上限30秒 |
| Firebase Hosting | `health.yt8492.com`のダッシュボード・紹介・規約ページを静的配信し、`/api/**`をCloud Runへ中継 |
| Cloud Run Job `healthcheck-sync` | 非公開、1タスク・並列1、1 vCPU / 512 MiB、上限540秒、タスク再試行0、48時間再取得後に90日超を削除 |
| Cloud Scheduler `healthcheck-sync-every-15m` | `*/15 * * * *`、Asia/Tokyo、Google Cloud APIへのOAuth認証付きPOST、受付の再試行0 |
| Secret `healthcheck-google-health-oauth` | DBと同じリージョンで管理する、本人の接続済みOAuth JSON。同期Jobだけが読み取る |
| Artifact Registry `healthcheck` | 同じdigestのイメージをServiceとJobに使用。最新2世代を保持、他は1日以上経過後に削除 |
| Cloud Storage `PROJECT_ID-healthcheck-build-source` | 非公開のビルドソース一時置場。1日経過後に削除対象。健康データを置かない |

| サービスアカウント | 付与する権限 |
| --- | --- |
| `healthcheck-api` | 対象プロジェクトの`roles/datastore.viewer` |
| `healthcheck-sync` | 対象プロジェクトの`roles/datastore.user`、対象Secretの`roles/secretmanager.secretAccessor` |
| `healthcheck-scheduler` | 同期Jobだけの`roles/run.invoker` |
| `healthcheck-build` | ビルドソースBucketの`roles/storage.objectViewer`、対象Repositoryの`roles/artifactregistry.writer`、プロジェクトの`roles/logging.logWriter` |

サービスアカウントの鍵ファイルは作らない。Firestoreのクライアント用ルールは`infra/firestore.rules`と同じ、全読み書き拒否であることを公開前に確認する。サーバーはIAMでアクセスする。`seriesHourly.points`、`sleepSessions.stages`、`activityHourly/<metric>/hours`の`points`のインデックスを無効化して書き込み・容量を抑える。SchedulerにJobの設定変更・Secret参照・Firestore操作の権限は与えない。

## 初回公開・再デプロイ

Node.js 24、npm、ログイン済みGoogle Cloud CLI、対象プロジェクトのオーナー権限、Cloud Billingが必要。既存DBの配置に合わせて指定する。

```sh
npm ci
npm run check
npm test
npm run build
npm run cloud:deploy -- --project YOUR_PROJECT_ID --region asia-northeast1
```

初回は`.local/google-health-tokens.json`を必要とする。別の場所にある場合は`--token-file /absolute/path/token.json`を指定する。認証情報は`gcloud secrets versions add --data-file`から直接登録し、引数・ログ・ビルドソースに展開しない。既存の有効なSecretバージョンがある更新では、Secretを再登録しない。

デプロイは既存リソースを名前で再利用する。実行途中で失敗した場合は、原因を修正して同じコマンドで再開できる。ビルド成功後の設定だけをやり直す場合は`--image asia-northeast1-docker.pkg.dev/YOUR_PROJECT_ID/healthcheck/healthcheck@sha256:DIGEST`を追加すると、そのイメージから再開する。初回同期が失敗した場合は定期起動を新規作成せず停止する。作成済みの定期起動がある再デプロイでは、その状態を保持する。

ServiceとJobは同じイメージdigestを使用する。`cloud:deploy`の出力にCloud RunのHTTPS URLが表示される。このコマンドはHostingやDNSを変更しない。

独自ドメイン側の画面や紹介・規約ページを更新する場合は、サイト用の依存関係を導入してHostingだけを公開する。`firebase.json`のpredeployで`npm run build:hosting`を実行し、ブラウザ用ビルドと公開文書を`dist/hosting`にまとめる。APIの中継先は`asia-northeast1`のService `healthcheck`で、通常のCloud Runトラフィック設定に従う。

```sh
npm ci --prefix site
npx firebase deploy --only hosting --project YOUR_PROJECT_ID
```

ルートはダッシュボード、紹介は`/about/`、文書は`/privacy/`と`/terms/`。DNSと証明書を切り替える前に、Hostingの`web.app` URLで画面、文書、`/api/v1/health`と`/api/v1/status`の動作を確認する。

## 独自ドメインの移行

`health.yt8492.com`は既存のHostingサイトに追加し、Cloudflareの`health`のCNAMEをHostingが指定する`healthcheck-511223.web.app`へ向ける。プロキシは「DNSのみ」、TTLは自動にする。CNAMEによって所有権も確認できるため、同名の所有権TXTは併設しない。証明書用のTXTが指定された場合は`_acme-challenge.health`に最新の値を登録する。

`ownershipState=OWNERSHIP_ACTIVE`と`cert.state=CERT_ACTIVE`を確認し、新ドメインの正規HTTPS接続でダッシュボード・文書・APIを検証する。正規URLは`health.yt8492.com`。旧`healthcheck.yt8492.com`のCustomDomain登録は削除済みで、Hostingの有効なドメイン一覧には含まれない。旧ドメイン用のDNSレコードは変更していない。プロジェクト・Hostingサイト・Cloud Runのリソース名は変更しない。

### 他サービスから配信先も移す場合

既存の紹介サイトを維持したまま証明書を準備する場合、Hostingのカスタムドメインを追加し、表示されたACME DNSチャレンジを`_acme-challenge.healthcheck`のTXTに登録する。Consoleでチャレンジが表示されない場合は[CustomDomain API](https://firebase.google.com/docs/reference/hosting/rest/v1beta1/projects.sites.customDomains)の`cert.verification.dns`を確認する。チャレンジ値は変更される場合があるため、過去の値を再利用しない。

所有権は`healthcheck`のTXT `hosting-site=YOUR_SITE_ID`で確認する。同じ名前にCNAMEとTXTは併設できないため、旧配信先がCNAMEの場合は旧サービスの正規のAレコードに置き換えて配信を維持してからTXTを追加する。`ownershipState=OWNERSHIP_ACTIVE`と`cert.state=CERT_ACTIVE`を確認した後、AレコードをHostingが指定するIPへ切り替える。Cloudflareのプロキシは「DNSのみ」にする。Search Console用のドメイン所有権確認とは別であり、他のサブドメインのレコードは変更しない。

切り替え後は独自ドメインのHTTPS応答、画面とグラフ、紹介・規約へのリンク、APIのJSON応答を確認する。確認完了後、GitHub Pagesの旧カスタムドメイン設定を解除する。Hostingの所有権TXTは継続して保持する。

## 同期の確認

`YOUR_PROJECT_ID`と`PUBLIC_URL`は実際の値に置き換える。公開APIの正常応答は30秒キャッシュされる場合がある。

```sh
gcloud scheduler jobs describe healthcheck-sync-every-15m --project=YOUR_PROJECT_ID --location=asia-northeast1
gcloud scheduler jobs run healthcheck-sync-every-15m --project=YOUR_PROJECT_ID --location=asia-northeast1
gcloud run jobs executions list --job=healthcheck-sync --project=YOUR_PROJECT_ID --region=asia-northeast1
curl --fail PUBLIC_URL/api/v1/status
curl --fail PUBLIC_URL/api/v1/health
```

Schedulerの成功はCloud Run APIが起動要求を受け付けたことを示す。全指標の同期成功は、その後のExecutionの`Completed=True`と、公開`status.metrics`の各指標で`lastSuccessAt`更新・`error=null`を確認する。ルートの状態は心拍の従来互換であり、睡眠の成功は示さない。部分失敗では片方が成功してもJobは終了コード1になる。`dataThrough`は心拍の最新測定日時、睡眠の最新終了日時で、同期時刻とは違う。

稼働確認は`/api/v1/health`を使う。`/healthz`はこのCloud Runの公開経路ではアプリに届かず404となったため、ローカル用として残している。稼働確認の200はプロセスの起動を示すもので、DBの読み取りや同期成功を示すものではない。

手動で完了まで待つ場合:

```sh
gcloud run jobs execute healthcheck-sync --project=YOUR_PROJECT_ID --region=asia-northeast1 --wait
```

上流APIの429・5xxはジョブ内部で有限回再試行する。ジョブ自体とSchedulerは追加の再試行を行わず、次回の15分実行に委ねる。期限付きロックで保存処理の重複を防ぐ。Jobの540秒上限はロックの10分より短い。

## 停止・再開・OAuth再接続

```sh
gcloud scheduler jobs pause healthcheck-sync-every-15m --project=YOUR_PROJECT_ID --location=asia-northeast1
gcloud scheduler jobs resume healthcheck-sync-every-15m --project=YOUR_PROJECT_ID --location=asia-northeast1
```

OAuthの`reauth-required`では保存済みデータの配信が続く。ローカルで本人が再接続し、Secretを更新してから実行確認する。

```sh
npm run connect -- --sleep --activity
npm run cloud:credentials -- --project YOUR_PROJECT_ID --region asia-northeast1
gcloud run jobs execute healthcheck-sync --project=YOUR_PROJECT_ID --region=asia-northeast1 --wait
```

Jobは毎回`versions/latest`を読み取るため、Secret更新だけで新しい認証情報が次の実行に使われる。Secretの古いバージョンは自動削除しない。再接続後の同期成功を確認してから不要なバージョンを無効化する。Secret Managerの無料枠は有効バージョン数も対象となる。

External / Testingで発行したrefresh tokenは、このスコープでは原則7日で期限切れとなる。継続運用には公開ステータスとトークンの発行条件を確認し、必要なら公開設定後に再接続する。[Google OAuthの期限](https://developers.google.com/identity/protocols/oauth2#expiration)

## ロールバック

以前の正常なService RevisionとJobのイメージdigestを記録しておく。Artifact Registryは最新2世代を保持するため、必要な世代はクリーンアップ対象を確認する。

```sh
gcloud run services update-traffic healthcheck --to-revisions=PREVIOUS_REVISION=100 --project=YOUR_PROJECT_ID --region=asia-northeast1
gcloud run jobs update healthcheck-sync --image=PREVIOUS_IMAGE_DIGEST --project=YOUR_PROJECT_ID --region=asia-northeast1
```

戻す前にSchedulerを一時停止し、Jobの確認後に再開する。コンテナのロールバックはFirestoreのデータを巻き戻さない。

## 使用量と費用

15分ごとは1日96回。30日・1 vCPUで各実行が1分以内なら、Jobの最低課金時間からCPUは172,800 vCPU秒、メモリは86,400 GiB秒になる。無料枠は請求先アカウント内で他プロジェクトとも共有される。実行が1分を超える、リトライが増える、アクセスが増える場合には費用が増える。[Cloud Runの料金](https://cloud.google.com/run/pricing)

最小インスタンス0、リクエスト単位課金で待機費用を抑える。最大1は急な拡張を抑える設定で、総費用の上限を保証するものではない。インスタンス内の30秒キャッシュは同じ期間のDB読み取りを共有するが、任意期間の要求やコールドスタートでは新しい読み取りが生じる。

Cloud Build、イメージ保存、ビルドソース保存、Secret、Scheduler、Firestore、インターネット配信の使用量も別途確認する。Cloud Storageのリージョン別無料枠とCloud Runの無料枠は同一ではない。常時稼働のVM、ロードバランサー、CDNはこの構成には含めない。
