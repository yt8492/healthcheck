# 睡眠の取得仕様と検証

仕様確認日：2026年10月17日。

## 確認した上流の契約

- [SleepのRESTスキーマ](https://developers.google.com/health/reference/rest/v4/users.dataTypes.dataPoints#Sleep)の`interval`、`stages`、`shortAwakenings`、`outOfBedSegments`を使用する。ガイド冒頭の簡略例の`sleepStages`やトップレベル`startTime`ではなく、RESTリファレンスの構造を処理する。
- [reconcile](https://developers.google.com/health/reference/rest/v4/users.dataTypes.dataPoints/reconcile)はGET、`dataPoints[].dataPointName`と`sleep`を返し、睡眠は最大25件。`google-wearables`を明示する。本人識別子を含むリソース名はハッシュ化した不透明なIDへ変換し、元の名前は保存しない。
- [睡眠のフィルター](https://developers.google.com/health/reference/rest/v4/users.dataTypes.dataPoints/list)は`sleep.interval.end_time >= from AND sleep.interval.end_time < to`。開始時刻の条件や表示期間との重なりの条件を上流へ送らない。
- [睡眠ガイド](https://developers.google.com/health/data-types/sleep)に記載された`googlehealth.sleep.readonly`が必要。短い覚醒は主段階と重なるので、主段階へ単純加算しない。

## 架空データでの検証

すべてのfixtureは架空の識別子・日時・段階。本人のデバイスの値や生活時刻を複製していない。

```sh
npm run check
npm test
# Java 21以上。環境によってはJAVA_HOMEを設定
npm run test:emulator
# 別ターミナルで npm run emulator を起動
npm run test:e2e
npm run build:hosting
```

単体テストでは日跨ぎ、JSTの起床日、昼寝、覚醒・離床の和集合、不明な段階、部分期間の集計、全ページ取得、ページ循環、不正な区間、cursorの期間拘束、取得成功範囲の結合と未取得・一部取得・取得済みの区別を確認する。Emulatorでは再実行、訂正・削除、途中ページ失敗時の既存値保持、期限切れロック、両方向の指標部分失敗、終了日時による90日削除を確認する。ブラウザでは90日分の全ページ取得とURL復元、実際の開始・終了の表示、心拍への移動、途中ページの503、狭い画面の操作を確認する。

## 本人の実データによる本番確認

確認日：2026年10月18日。本人が心拍・睡眠の読み取りを許可し、本番Secretを更新した。Cloud Run Serviceと同期Jobは同一イメージで稼働し、両指標の同期Jobが正常終了した。15分ごとのSchedulerも有効。

- 公開APIで心拍・睡眠ともに`state=ok`を確認。検証時の24時間範囲には実データの睡眠セッションが1件あり、全ページの取得、開始・終了、JSTの起床日、段階内訳の合計とセッション時間、summaryの件数が整合することを確認した。
- 公開画面で睡眠タイムラインと詳細が表示され、睡眠のエラー表示がないことを確認した。実測値、生活時刻、元の識別子、認証情報はこの文書やfixtureへ転記していない。
- 初回の通常同期範囲は直近48時間。過去の未取得期間は、必要な終了日時範囲を最大7日ずつ指定して追加取得する。
- Fitbitアプリ上の開始・終了・段階との目視照合は未実施。以下の手順で別途確認する。架空データの検証、本番の取得・配信確認、本人のアプリとの照合は区別する。

1. 更新した紹介文とプライバシーポリシーを公開し、本人が睡眠の取得・90日保存・インターネット公開について確認する。
2. Google Auth Platformに`https://www.googleapis.com/auth/googlehealth.sleep.readonly`を追加し、`npm run connect -- --sleep`で本人の同意を得る。心拍と睡眠の両方を許可する。既存の認証情報とSecretは自動的には権限拡張されない。
3. Fitbitアプリで同期済みの夜間睡眠と昼寝を含む最大7日の終了日時範囲を指定し、睡眠を取得する。未提供なら「成功した空データ」、権限不足なら取得失敗として記録されることを区別する。
4. 対象プロジェクトを明示して`npm run sync:sleep -- --from ... --to ...`を実行し、睡眠APIの全ページと画面の実際の開始・終了、JST起床日、段階・覚醒を本人の記録と照合する。集計は区間長から求めるため、上流の丸めた分数との差は確認して記録する。
5. 訂正を行った範囲を再同期し、開始・終了の変更と削除が反映されることを確認する。通常同期は直近48時間のみなので、それより古い訂正は当該範囲を明示して再取得する。
6. 共有する検証記録には取得可否、レスポンスのフィールド名、差の原因だけを残し、実測値・本人の識別子・認証情報をソース、テスト、公開ログに転記しない。

Cloud Runへ反映する場合は再接続した認証情報を`cloud:credentials`でSecretへ登録してから更新する。`sync`は両指標を試行し、片方が失敗しても他方と期限削除を進めるが、ジョブの終了コードは1になる。公開APIの`status.metrics`で指標ごとの結果を確認する。
