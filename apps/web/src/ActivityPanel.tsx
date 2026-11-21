import { lazy, Suspense, useEffect, useState } from 'react';
import { ACTIVITY_METRICS, activitySpecs, isActivityMetric,
  type ActivityMetric, type ActivityResponse, type TimeRange } from '@healthcheck/core';
import { dateTime } from './time.js';

const ActivityChart = lazy(() => import('./ActivityChart.js'));
const syncErrors = { 'reauth-required': '本人のGoogle連携を更新してください。', 'access-denied': '活動の読み取り権限を確認してください。', 'upstream-unavailable': 'Google Health APIとの通信に失敗しました。', 'invalid-upstream-data': '取得値の整合性を確認できませんでした。', 'storage-error': '活動データの保存に失敗しました。' };
const value = (n: number | null) => n === null ? '—' : n.toLocaleString('ja-JP', { maximumFractionDigits: 3 });
export function ActivityPanel({ range, reload }: { range: TimeRange; reload: number }) {
  const [metricParam, setMetricParam] = useState(() => new URLSearchParams(location.search).get('activityMetric'));
  const metric = isActivityMetric(metricParam) ? metricParam : 'steps';
  const [error, setError] = useState(''), [loading, setLoading] = useState(true);
  const [data, setData] = useState<ActivityResponse | null>(null), [retry, setRetry] = useState(0);
  useEffect(() => {
    const restore = () => setMetricParam(new URLSearchParams(location.search).get('activityMetric'));
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, []);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError(''); setData(null);
    fetch(`/api/v1/timeseries?${new URLSearchParams({ ...range, metric, resolution: 'auto' })}`, { signal: controller.signal, cache: 'no-store' })
      .then(async response => {
        if (!response.ok) throw new Error(response.status === 400 ? '活動の表示期間を確認してください。直近90日以内を指定できます。' : '活動の記録を読み取れません。再試行してください。');
        return await response.json() as ActivityResponse;
      }).then(result => { if (!controller.signal.aborted) setData(result); })
      .catch(e => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : '活動の読み取りに失敗しました。'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [range, metric, reload, retry]);
  function chooseMetric(nextMetric: ActivityMetric) {
    setMetricParam(nextMetric);
    const url = new URL(location.href);
    url.searchParams.set('activityMetric', nextMetric);
    history.pushState({}, '', url);
  }
  const spec = activitySpecs[metric], status = data?.status;
  return <section className="chart-panel activity-panel" aria-labelledby="activity-title" aria-busy={loading}>
    <div className="chart-heading"><div><h2 id="activity-title">活動の記録</h2><p>歩数・距離・総消費カロリー・アクティブゾーン時間</p></div>
      <label>活動の指標<select value={metric} onChange={event => { if (isActivityMetric(event.target.value)) chooseMetric(event.target.value); }}>{ACTIVITY_METRICS.map(m => <option key={m} value={m}>{activitySpecs[m].label}</option>)}</select></label></div>
    {metricParam && !isActivityMetric(metricParam) && <p className="inline-error" role="alert">活動の指標が不正です。</p>}
    {loading && <div className="chart-placeholder" role="status">活動の記録を読み込んでいます</div>}
    {error && <div className="alert" role="alert"><p>{error}</p><button onClick={() => setRetry(v => v + 1)}>活動を再試行</button></div>}
    {data && <>
      <p className="activity-sync">{spec.label}の最終同期：{status?.lastSuccessAt ? dateTime(status.lastSuccessAt) : '未同期'} JST · 最新測定：{status?.dataThrough ? dateTime(status.dataThrough) : '値なし'}</p>
      {status?.state === 'error' && <p className="alert" role="status">{spec.label}の同期に失敗しています。{status.error && syncErrors[status.error.code]} 保存済みの値を表示しています。</p>}
      {status?.state === 'delayed' && <p className="alert" role="status">{spec.label}の同期が遅れています。保存済みの値を表示しています。</p>}
      {data.coverage !== 'fetched' && <p className="alert" role="status">この期間の活動は{data.coverage === 'not-fetched' ? '未取得' : '一部だけ取得済み'}です。合計は取得できた値だけの集計です。</p>}
      <div className="activity-total"><strong>{spec.label}：{value(data.summary.total)} <small>{spec.displayUnit}</small></strong><span>値あり {data.summary.availableMinutes.toLocaleString()} / {data.summary.totalMinutes.toLocaleString()}分 · 値の省略 {data.summary.omittedMinutes.toLocaleString()}分 · レコードなし {data.summary.missingMinutes.toLocaleString()}分</span></div>
      {data.summary.availableMinutes ? <Suspense fallback={<p>活動グラフを準備しています</p>}><ActivityChart data={data} /></Suspense>
        : <p className="chart-placeholder">{data.coverage === 'not-fetched' ? 'この期間の活動はまだ取得していません。' : 'この期間に数値のある活動データはありません。'}</p>}
      <p className="form-help">{data.resolution === '1m' ? '1分' : data.resolution === '1h' ? '1時間' : 'JSTの1日'}ごとの既知値の合計。0は数値として表示し、値の省略・レコードなしは補完しません。欠けた分がある合計は一部の値です。</p>
      {metric === 'total-calories' && <p className="form-help">基礎代謝を含む総消費カロリーです。運動分だけのカロリーではありません。</p>}
      {metric === 'active-zone-minutes' && <p className="form-help">強度を反映したポイント数です。実際に運動した時間とは異なり、上流で加重された値を再加重しません。</p>}
      <details className="data-table"><summary>活動の日別合計を確認する</summary><div className="table-wrap"><table><caption>{spec.label}の日別合計（JST・{spec.displayUnit}）。指定期間外と未取得の分は含めません。</caption>
        <thead><tr><th>日付</th><th>合計</th><th>値あり / 対象の分</th><th>集計範囲</th></tr></thead><tbody>{data.summary.days.map(day => <tr key={day.date}><td>{day.date}</td><td>{value(day.total)}</td><td>{day.availableMinutes} / {day.totalMinutes}</td><td>{day.partialDay ? '途中集計' : '1日'}{day.availableMinutes < day.totalMinutes ? '・欠損あり' : ''}</td></tr>)}</tbody>
      </table></div></details>
    </>}
  </section>;
}
