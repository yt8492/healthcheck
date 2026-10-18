# 活動の取得仕様と検証

仕様確認日：2026年10月18日。

## 上流の契約

- [rollUp](https://developers.google.com/health/reference/rest/v4/users.dataTypes.dataPoints/rollUp)をPOSTし、`range.startTime/endTime`、`windowSize=60s`、`dataSourceFamily=users/me/dataSourceFamilies/google-wearables`を使用する。全ページの取得完了後にだけ保存する。同期の指定範囲は最大7日。
- [StepsRollupValue](https://developers.google.com/health/reference/rest/v4/StepsRollupValue)の`steps.countSum`はint64文字列の歩数。[DistanceRollupValue](https://developers.google.com/health/reference/rest/v4/DistanceRollupValue)の`distance.millimetersSum`はint64文字列のmmをmへ換算する。安全な整数範囲を超える値は保存しない。
- [TotalCaloriesRollupValue](https://developers.google.com/health/reference/rest/v4/TotalCaloriesRollupValue)の`totalCalories.kcalSum`はkcal。基礎代謝を含む総消費で、アクティブカロリーとは異なる。
- [ActiveZoneMinutesRollupValue](https://developers.google.com/health/reference/rest/v4/ActiveZoneMinutesRollupValue)の`sumInFatBurnHeartZone`、`sumInCardioHeartZone`、`sumInPeakHeartZone`は強度を反映済みのポイント数。提供されたフィールドの値を加算し、再度2倍しない。ゾーンフィールドがすべて省略された場合は値の省略とし、一つもない値を0にしない。
- [集計と最小記録間隔](https://developers.google.com/health/aggregate-data)に従い、分より細かく分割・補間しない。上流の区間合計を分値として保持し、時間・日表示では既知の値を加算する。日境界は旅行先のcivil timeではなく、心拍・睡眠表示に合わせて固定のJSTを使用する。
- [true zeroとデータの存在](https://developers.google.com/health/data-presence-and-true-zeros)：rollUpで明示された0を数値として保存する。レコードはあるが対象値・値フィールドがない場合は`omitted`、レコードがない分は`missing`として別に保存する。listの空値に対する規則をrollUpの欠損へ適用しない。
- `googlehealth.activity_and_fitness.readonly`の本人同意が必要。取得前に公開文書を更新する。位置情報・移動経路は取得しない。

## 架空データでの検証

fixtureは架空の日時・値のみで、本人の測定値・生活時刻・上流レスポンスを転記していない。

```sh
npm run check
npm test
# ローカルFirestore EmulatorとJava 21以上
npm run test:emulator
npm run test:e2e
npm run build:hosting
```

- 単体：0・値省略・欠損、int64と単位換算、AZMの加重、全ページ・循環・途中失敗、JSTの日跨ぎ、途中日、集計粒度で合計が変わらないこと。
- Emulator：冪等再実行、訂正と削除、隣接する分と他指標の保持、最新測定の後退、指標別ロック、途中失敗で成功範囲・既存値の保持、90日境界の分削除、取得失敗時にも期限削除、最大90日APIと不正クエリ。
- ブラウザ：デスクトップとモバイルで単位別表示、90日の日別表、URL復元、心拍と期間を揃える操作、部分失敗と再試行、0と未取得の区別。

## 本人データの検証

実データの測定値・具体的な生活時刻・トークン・識別子は、この文書・fixture・GitHubに記録しない。

1. 紹介ページ・プライバシーポリシー・利用規約で取得対象、90日保存、インターネット公開を説明し、公開を確認する。
2. `npm run connect -- --sleep --activity`で本人が心拍・睡眠・活動を読み取り許可する。
3. 上流の各指標について値の提供可否・フィールド名・単位を確認する。取得済みの空データと権限不足を区別し、実際に提供されていない指標の値を作らない。
4. 同じ[from,to)の上流1分値、保存値、APIの分・時間・JST日別合計をメモリ内で照合し、値や日時をログへ出さず一致したかだけを記録する。今日の途中は現在の完了した分までを対象とする。上流の同じ範囲の合計と比較し、端点・単位を確認する。
5. 同意済み認証情報をSecretへ登録し、同一イメージをService/Jobへ反映する。Job完了と`status.metrics`全指標の成功を確認し、独自ドメインから画面・APIを検証する。

### 2026年10月18日の実データ確認結果

本人が心拍・睡眠・活動の読み取りを許可し、ローカルOAuthの本人確認と権限の付与を確認した。取得前に活動を説明した公開文書を独自ドメインから確認した。

- 歩数・距離・総消費カロリー・アクティブゾーン時間のすべてで数値の提供を確認した。上流フィールドはそれぞれ`countSum`、`millimetersSum`、`kcalSum`、3種の`sumIn…HeartZone`だった。
- 同じ48時間について、上流の各1分値と保存値の値・時刻・値の有無が一致した。上流の1時間rollUp合計とも許容する浮動小数点の丸め誤差内で一致した。
- APIの1m・1h・1dで合計・単位を照合し、JSTの日別内訳と今日の途中集計が同じ分値の和に一致した。日跨ぎ・欠損の分類は架空データの境界テストでも別途確認した。
- Fitbitアプリの画面上の値との目視比較は行っていない。Google Health APIの本人データと保存・配信値を直接照合した結果である。
- 実測値、具体的な生活時刻、元のレスポンス、認証情報をこの文書やfixtureへ転記していない。

### 本番反映と定期実行

- Cloud Build成功後、Cloud Run Serviceと同期Jobが同一のイメージdigestを利用することを確認した。初回Executionと、その後の15分SchedulerによるExecutionはいずれも`Completed=True`、成功タスク1で正常終了した。
- 独自ドメインへのFirebase Hosting反映も完了した。公開APIの全6指標は`state=ok`。活動4指標の1m・1h・1dの値・区間・単位・JST日別合計が、同じ期間のFirestore読取値と一致し、90日表示で未取得部分を0にしないことを確認した。
- 単体74件、Emulator結合22件、デスクトップ・モバイルのE2E20件、型チェック、公開用ビルドが成功した。
- 数値がない選択期間についても、同期成功・取得済みでレコードがない状態として表示し、0や架空のグラフを作らないことを確認した。
- 本番画面でもデスクトップ・モバイルの指標切り替え、値なしの表示、90日の日別表、横方向のはみ出しがないこと、ブラウザ実行エラーがないことを確認した。検証用のスクリーンショットと一時スクリプトはGit対象外の管理用領域だけで扱った。
