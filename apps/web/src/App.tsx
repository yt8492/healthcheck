import { lazy, Suspense, useEffect, useState } from 'react';
import { floorMinute, heartResolution, heartResolutionLabels, retentionStart, type HeartResolution, type TimeRange, type TimeseriesResponse } from '@healthcheck/core';
import { dateOnly, dateTime, inputRange, moveRange, presetRange, rangeFromUrl, toInput } from './time.js';
import { ActivityPanel } from './ActivityPanel.js';
import { SleepPanel } from './SleepPanel.js';

const HeartChart = lazy(() => import('./HeartChart.js'));

const errorMessages: Record<string, string> = {
  'reauth-required': '本人のGoogle連携を更新する必要があります。',
  'access-denied': 'Google Health APIの利用権限を確認する必要があります。',
  'upstream-unavailable': 'Google Health APIとの通信に失敗しました。',
  'invalid-upstream-data': '取得データの整合性を確認できませんでした。',
  'storage-error': 'データの保存に失敗しました。',
};
const bpm = (value: number | null | undefined) => value == null ? '—' : value.toFixed(1);
function setUrl(range: TimeRange, resolution: HeartResolution | 'auto', replace = false, clearSleep = false) {
  const url = new URL(location.href);
  url.searchParams.set('from', range.from); url.searchParams.set('to', range.to);
  url.searchParams.set('resolution', resolution);
  if (clearSleep) { url.searchParams.delete('sleepFrom'); url.searchParams.delete('sleepTo'); url.searchParams.delete('activityFrom'); url.searchParams.delete('activityTo'); }
  history[replace ? 'replaceState' : 'pushState']({}, '', url);
}

export function App() {
  const [initial] = useState(rangeFromUrl);
  const [range, setRange] = useState(initial.range);
  const [resolution, setResolution] = useState(initial.resolution);
  const [from, setFrom] = useState(toInput(initial.range.from));
  const [to, setTo] = useState(toInput(initial.range.to));
  const [inputError, setInputError] = useState(initial.error ?? '');
  const [data, setData] = useState<TimeseriesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState('');
  const [reload, setReload] = useState(0);

  useEffect(() => {
    setUrl(initial.range, initial.resolution, true);
    const pop = () => { const restored = rangeFromUrl(); setInputError(restored.error ?? ''); setRange(restored.range); setResolution(restored.resolution); };
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, [initial]);
  useEffect(() => { setFrom(toInput(range.from)); setTo(toInput(range.to)); }, [range]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setFetchError(''); setData(null);
    const q = new URLSearchParams({ ...range, metric: 'heart-rate', resolution });
    fetch(`/api/v1/timeseries?${q}`, { signal: controller.signal, cache: 'no-store' })
      .then(async response => {
        if (!response.ok) throw new Error(response.status === 400 ? '表示期間を確認してください。保存対象は直近90日です。' : '記録を読み取れません。時間を置いて再試行してください。');
        return await response.json() as TimeseriesResponse;
      }).then(value => { if (!controller.signal.aborted) setData(value); })
      .catch(error => { if (!controller.signal.aborted) setFetchError(error instanceof Error ? error.message : '読み取りに失敗しました。'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [range, resolution, reload]);

  function choose(next: TimeRange, selected = resolution) {
    try {
      heartResolution(selected, next);
      setInputError(''); setRange(next); setResolution(selected); setUrl(next, selected, false, true);
    } catch (error) { setInputError(error instanceof Error ? error.message : '表示期間と粒度を確認してください。'); }
  }
  function move(direction: number) {
    choose(moveRange(range, direction));
  }
  const hasData = Boolean(data?.summary.availableMinutes);
  const status = data?.status;
  const coverage = data ? Math.round(data.summary.availableMinutes / data.summary.totalMinutes * 100) : 0;
  const resolutionLabel = heartResolutionLabels[data?.resolution ?? heartResolution(resolution, range)];
  const statusLabel = !status ? '読み込み中' : status.state === 'ok' ? '同期済み' : status.state === 'not-synced' ? '接続待ち' : status.state === 'delayed' ? '同期が遅れています' : '同期に失敗';

  return <div className="shell">
    <header className="masthead">
      <a className="brand" href="/" aria-label="Healthcheck 直近24時間"><span className="brand-mark" aria-hidden="true">h<span>·</span></span><span>healthcheck</span></a>
      <span className="header-caption">日々のからだの記録</span>
      <span className="timezone">Asia/Tokyo <span>JST</span></span>
    </header>
    <main>
      {status?.environment === 'emulator' && <div className="demo-note" role="note">Emulatorの架空データ <span>画面と保存処理を確認するための記録です。</span></div>}
      <section className="intro">
        <div><p className="eyebrow">YOUR DAILY RECORD</p><h1>心拍の記録</h1><p className="lead">1分ごとの記録から、からだの変化を振り返る。</p></div>
        <div className="sync-info"><span className={`status-pill ${status?.state === 'error' ? 'warning' : ''}`}><span aria-hidden="true" />{fetchError ? '読み取りエラー' : statusLabel}</span><p>最終同期 <strong>{status?.lastSuccessAt ? dateTime(status.lastSuccessAt) : '未同期'}</strong></p></div>
      </section>

      <section className="period-panel" aria-label="表示期間">
        <div className="period-top"><div><span className="eyebrow">表示期間</span><p className="period-title">{dateTime(range.from)} <span>—</span> {dateTime(range.to)}</p></div>
          <div className="period-actions"><div className="heart-presets" aria-label="心拍の期間プリセット">{[1, 7, 30, 90].map(days => <button key={days} className="preset" onClick={() => choose(presetRange(days), 'auto')}>{days === 1 ? '直近24時間' : `${days}日`}</button>)}</div><div className="arrows"><button aria-label="前の期間" disabled={Date.parse(range.from) <= retentionStart(Date.now())} onClick={() => move(-1)}>←</button><button aria-label="次の期間" disabled={Date.parse(range.to) >= floorMinute(Date.now())} onClick={() => move(1)}>→</button></div></div>
        </div>
        <label className="heart-resolution">心拍の表示粒度<select value={resolution} onChange={event => choose(range, event.target.value as HeartResolution | 'auto')}><option value="auto">自動</option>{Object.entries(heartResolutionLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <details className="date-controls"><summary>日時を指定する</summary><form onSubmit={event => { event.preventDefault(); try { choose(inputRange(from, to)); } catch (error) { setInputError(error instanceof Error ? error.message : '日時を確認してください。'); } }}>
          <label>開始日時（JST）<input type="datetime-local" value={from} onChange={e => setFrom(e.target.value)} required /></label>
          <label>終了日時（JST）<input type="datetime-local" value={to} onChange={e => setTo(e.target.value)} required /></label>
          <button className="primary" type="submit">表示する</button><p className="form-help">直近90日以内を指定できます。表示区間は最大4,096件です。</p>
        </form></details>
        {inputError && <p className="inline-error" role="alert">{inputError}</p>}
      </section>

      {fetchError && <div className="alert" role="alert"><p>{fetchError}</p><button onClick={() => setReload(v => v + 1)}>再試行</button></div>}
      {status?.error && <div className="alert" role="status"><p>{errorMessages[status.error.code]}<br/><span>保存済みの記録を表示しています。最終試行：{dateTime(status.error.at)}</span></p></div>}
      {status?.state === 'delayed' && <div className="alert" role="status"><p>最終同期から1時間以上経過しています。表示されている値は保存済みの記録です。</p></div>}

      <section className="stats" aria-label="選択期間の心拍統計" aria-busy={loading}>
        <div className="stat featured"><span className="stat-label">期間の平均</span><div className="stat-value">{bpm(data?.summary.avg)}<small>bpm</small></div><p>有効な1分平均から計算</p></div>
        <div className="stat"><span className="stat-label">最小心拍</span><div className="stat-value">{bpm(data?.summary.min)}<small>bpm</small></div><p>選択期間内の最小値</p></div>
        <div className="stat"><span className="stat-label">最大心拍</span><div className="stat-value">{bpm(data?.summary.max)}<small>bpm</small></div><p>選択期間内の最大値</p></div>
        <div className="stat latest"><span className="stat-label">期間内の最新測定</span><div className="stat-value">{bpm(data?.summary.latest?.avg)}<small>bpm</small></div><p>{data?.summary.latest ? `${dateTime(data.summary.latest.time)} JST` : '測定値なし'}</p></div>
      </section>

      <section className="chart-panel" aria-labelledby="chart-title" aria-busy={loading}>
        <div className="chart-heading"><div><p className="eyebrow">HEART RATE</p><h2 id="chart-title">時間ごとの変化</h2><p>{dateOnly(range.from)} · {resolutionLabel}単位</p></div><button className="text-button" disabled={loading} onClick={() => setReload(v => v + 1)}><span aria-hidden="true">↻</span> 記録を更新</button></div>
        <div className="chart-meta"><div className="legend"><span><i className="line" />{resolutionLabel}平均</span><span><i className="band" />最小〜最大</span></div><span className="coverage">取得できた分 <strong>{data?.summary.availableMinutes ?? '—'}</strong> / {data?.summary.totalMinutes ?? '—'}<span>（{coverage}%）</span></span></div>
        {loading ? <div className="chart-placeholder" role="status"><span className="loader" /><p>記録を読み込んでいます</p></div>
          : hasData && data ? <Suspense fallback={<div className="chart-placeholder" role="status">グラフを準備しています</div>}><HeartChart points={data.points} resolution={data.resolution} /></Suspense>
          : <div className="chart-placeholder"><span className="empty-mark" aria-hidden="true">—</span><h3>{fetchError ? '記録を表示できません' : status?.state === 'not-synced' ? 'まだ記録がありません' : 'この期間のデータはありません'}</h3><p>{fetchError ? '読み取りエラーの解消後に再試行してください。' : status?.state === 'not-synced' ? '本人のGoogle連携と初回の心拍同期後に表示されます。' : '別の期間を選ぶと、保存された記録を確認できます。'}</p></div>}
        <div className="chart-foot"><p><span className="gap-key" aria-hidden="true" />全欠損の区間は線をつなぎません。一部欠損は取得できた分だけの平均です。</p><span>時刻はすべて日本時間</span></div>
        <p className="form-help">平均は有効な1分平均の合計 ÷ 有効な分数。元の秒単位サンプル数による平均ではありません。帯は各区間の最小〜最大です。期間端の端数は指定範囲だけを集計します。</p>
        {data && hasData && <details className="data-table"><summary>最後の60区間を表で確認する</summary><div className="table-wrap"><table><caption>選択期間の最後の60区間。単位：bpm</caption><thead><tr><th>期間（JST）</th><th>平均</th><th>最小</th><th>最大</th><th>取得できた分 / 対象分</th></tr></thead><tbody>{data.points.slice(-60).map(point => <tr key={point.time}><td>{dateTime(point.time)} ～ {dateTime(point.to)}</td><td>{bpm(point.value?.avg)}</td><td>{bpm(point.value?.min)}</td><td>{bpm(point.value?.max)}</td><td>{point.availableMinutes} / {point.totalMinutes}</td></tr>)}</tbody></table></div></details>}
      </section>

      <SleepPanel range={range} reload={reload} showHeart={choose} />

      <ActivityPanel range={range} reload={reload} />

      <section className="record-note"><div className="note-icon" aria-hidden="true">i</div><div><h2>記録について</h2><p>Googleのウェアラブルデバイスから取得した、1分ごとの平均・最小・最大です。未装着や未取得の時間は欠損として表示します。</p><p>測定から90日間保存します。デバイスからの反映には時間差があります。</p></div></section>
    </main>
    <footer><a href="/about/">healthcheckについて</a><a href="/privacy/">プライバシーポリシー</a><a href="/terms/">利用規約</a><a href={`/api/v1/timeseries?${new URLSearchParams({ ...range, metric: 'heart-rate', resolution })}`}>この期間のJSON ↗</a></footer>
  </div>;
}
