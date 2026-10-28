import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { DAY, HOUR, SLEEP_STAGES, floorMinute, retentionStart, summarizeSleep, validateRange,
  type PublicStatus, type SleepCoverage, type SleepResponse, type SleepSession, type TimeRange } from '@healthcheck/core';
import { dateTime, toInput } from './time.js';
import { sleepDurationParts, sleepLabels as labels, sleepMinutes as minutes } from './sleepPresentation.js';

const SleepTimeline = lazy(() => import('./SleepTimeline.js'));
function savedRange(fallback: TimeRange): TimeRange {
  const q = new URLSearchParams(location.search);
  if (!q.has('sleepFrom') && !q.has('sleepTo')) return fallback;
  // URLの不正値は呼び出し元で明示する。
  return validateRange(q.get('sleepFrom'), q.get('sleepTo'), Date.now(), 90 * 24 * 60);
}

export async function loadSleep(range: TimeRange, signal: AbortSignal): Promise<{ sessions: SleepSession[]; status: PublicStatus; coverage: SleepCoverage }> {
  const sessions = new Map<string, SleepSession>();
  const seen = new Set<string>();
  let cursor: string | null = null, status: PublicStatus | undefined;
  let coverage: SleepCoverage = 'not-fetched';
  do {
    const q = new URLSearchParams({ ...range, ...(cursor ? { cursor } : {}) });
    const response = await fetch(`/api/v1/sleep?${q}`, { signal, cache: 'no-store' });
    if (!response.ok) throw new Error(response.status === 400 ? '睡眠の表示期間を確認してください。保存対象は直近90日です。' : '睡眠の記録を読み取れません。再試行してください。');
    const page = await response.json() as SleepResponse;
    for (const session of page.sessions) sessions.set(session.id, session);
    status = page.status;
    coverage = page.coverage;
    cursor = page.nextCursor;
    if (cursor) {
      if (seen.has(cursor) || seen.size >= 1000) throw new Error('睡眠の全ページを取得できませんでした。再試行してください。');
      seen.add(cursor);
    }
  } while (cursor);
  if (!status) throw new Error('睡眠の同期状態を確認できません。');
  return { sessions: [...sessions.values()].sort((a, b) => a.startTime.localeCompare(b.startTime)), status, coverage };
}

export function SleepPanel({ range, reload, showHeart }: { range: TimeRange; reload: number; showHeart: (range: TimeRange) => void }) {
  const [selected, setSelected] = useState(range);
  const [from, setFrom] = useState(toInput(range.from)), [to, setTo] = useState(toInput(range.to));
  const [inputError, setInputError] = useState('');
  const [data, setData] = useState<Awaited<ReturnType<typeof loadSleep>> | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [retry, setRetry] = useState(0);
  useEffect(() => {
    try { setSelected(savedRange(range)); setInputError(''); }
    catch (error) { setSelected(range); setInputError(error instanceof Error ? error.message : '睡眠のURLが不正です。'); }
  }, [range]);
  useEffect(() => { setFrom(toInput(selected.from)); setTo(toInput(selected.to)); }, [selected]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(''); setData(null);
    loadSleep(selected, controller.signal).then(result => { if (!controller.signal.aborted) setData(result); })
      .catch(error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : '睡眠の読み取りに失敗しました。'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [selected, reload, retry]);
  function choose(next: TimeRange) {
    setSelected(next); setInputError('');
    const url = new URL(location.href);
    url.searchParams.set('sleepFrom', next.from); url.searchParams.set('sleepTo', next.to);
    history.pushState({}, '', url);
  }
  const summary = data ? summarizeSleep(data.sessions, selected) : null;
  const long = Date.parse(selected.to) - Date.parse(selected.from) > 2 * DAY;
  const selectedDuration = Date.parse(selected.to) - Date.parse(selected.from);
  const status = data?.status;
  function context(session: SleepSession) {
    const to = Math.min(floorMinute(Date.now()), floorMinute(Date.parse(session.endTime)) + HOUR);
    const from = Math.max(retentionStart(Date.now()), Math.max(to - DAY, floorMinute(Date.parse(session.startTime)) - HOUR));
    showHeart({ from: new Date(from).toISOString(), to: new Date(to).toISOString() });
  }
  function details(session: SleepSession) {
    return <details className="sleep-session" key={session.id}>
      <summary><strong>詳細を見る</strong><span>{dateTime(session.startTime)} ～ {dateTime(session.endTime)}{session.nap === true ? ' · 昼寝' : ''} · 睡眠 {minutes(session.asleepMinutes)}</span></summary>
      <p>実際の開始：<time dateTime={session.startTime}>{new Date(Date.parse(session.startTime) + 9 * HOUR).toISOString().replace('T', ' ').replace('Z', '')} JST</time></p>
      <p>実際の終了：<time dateTime={session.endTime}>{new Date(Date.parse(session.endTime) + 9 * HOUR).toISOString().replace('T', ' ').replace('Z', '')} JST</time></p>
      <p>JSTの起床日：{session.wakeDate} · セッション全体 {minutes(session.durationMinutes)} · 覚醒・離床 {minutes(session.stageMinutes.awake)}</p>
      <button onClick={() => context(session)}>この睡眠前後の心拍を見る</button>
      <div className="table-wrap"><table><caption>セッション全体の段階・覚醒（JST）。短い覚醒と離床は重なりを除いて計上。</caption>
        <thead><tr><th>開始</th><th>終了</th><th>段階</th><th>分</th></tr></thead><tbody>{session.stages.map(stage => <tr key={stage.startTime}>
          <td>{dateTime(stage.startTime)}</td><td>{dateTime(stage.endTime)}</td><td>{labels[stage.type]}</td><td>{((Date.parse(stage.endTime) - Date.parse(stage.startTime)) / 60_000).toFixed(1)}</td>
        </tr>)}</tbody></table></div>
    </details>;
  }
  return <section className="chart-panel sleep-panel" aria-labelledby="sleep-title" aria-busy={loading}>
    <div className="chart-heading"><div><h2 id="sleep-title">睡眠の記録</h2><p>起床日で集計（JST）</p></div></div>
    <div className="sleep-period" aria-label="睡眠の表示期間">
      <p>{dateTime(selected.from)} ～ {dateTime(selected.to)}</p>
      <div className="sleep-presets" aria-label="睡眠の期間を選択">{[1, 7, 30, 90].map(days => <button key={days}
        aria-label={days === 1 ? '睡眠24時間' : `睡眠${days}日`} aria-pressed={Math.abs(selectedDuration - days * DAY) < 120_000} onClick={() => {
        const to = floorMinute(Date.now());
        choose({ from: new Date(Math.max(retentionStart(Date.now()), to - days * DAY)).toISOString(), to: new Date(to).toISOString() });
      }}>{days === 1 ? '1日' : days === 7 ? '1週間' : `${days}日`}</button>)}</div>
      <details className="date-controls"><summary>睡眠の日時を指定する</summary><form onSubmit={event => {
        event.preventDefault();
        try { choose(validateRange(`${from}:00+09:00`, `${to}:00+09:00`, Date.now(), 90 * 24 * 60)); }
        catch (error) { setInputError(error instanceof Error ? error.message : '日時を確認してください。'); }
      }}><label>睡眠の開始（JST）<input type="datetime-local" required value={from} onChange={e => setFrom(e.target.value)} /></label>
        <label>睡眠の終了（JST）<input type="datetime-local" required value={to} onChange={e => setTo(e.target.value)} /></label><button type="submit">睡眠を表示する</button></form></details>
      {inputError && <p className="inline-error" role="alert">{inputError}</p>}
    </div>
    {loading ? <p className="sleep-message" role="status">睡眠の全ページを読み込んでいます</p>
      : error ? <div className="alert" role="alert"><p>{error}</p><button onClick={() => setRetry(v => v + 1)}>睡眠を再試行</button></div>
      : <>
        <details className="sleep-sync-details"><summary>同期状況を確認</summary><p className="sleep-status" role="status">睡眠の最終同期：{status?.lastSuccessAt ? dateTime(status.lastSuccessAt) : '未取得'} · 最新終了日時：{status?.dataThrough ? dateTime(status.dataThrough) : 'なし'}</p></details>
        {status?.error && <p className="alert" role="status">睡眠の取得に失敗しています（{status.error.code}）。保存済みの記録を表示しています。</p>}
        {status?.state === 'delayed' && <p className="alert" role="status">睡眠の最終同期から1時間以上経過しています。保存済みの記録です。</p>}
        {status?.lastSuccessAt && data?.coverage !== 'fetched' && <p className="alert" role="status">この期間の取得は完了していません。取得済みの記録だけを表示しています。</p>}
        {!data?.sessions.length ? <p className="sleep-message">{status?.state === 'not-synced' ? '睡眠は未取得です。本人の睡眠読み取りへの同意と同期後に表示されます。'
          : status?.state === 'error' ? '睡眠の取得に失敗しています。データがないとは判断できません。'
            : data?.coverage !== 'fetched' ? 'この期間の睡眠は未取得、または一部だけ取得済みです。'
              : 'この期間に取得できた睡眠はありません。未装着・未提供・記録なしの区別はできません。'}</p>
          : <>
            {(long || data.sessions.length > 1 || data.sessions.some(s => s.startTime < selected.from || s.endTime > selected.to)) &&
              <p className="sleep-overview">表示期間内の合計：睡眠 {minutes(summary?.asleepMinutes ?? null)} · {summary?.sessionCount}セッション</p>}
            {long && <div className="sleep-legend">{SLEEP_STAGES.map(type => <span key={type}><i className={`sleep-color ${type}`} />{labels[type]}</span>)}</div>}
            {long ? <div className="sleep-days" aria-label="起床日別の睡眠内訳">{summary?.days.map(day => <details key={day.date}>
              <summary>{day.date} · 睡眠 {minutes(day.asleepMinutes)} · {day.sessionCount}セッション
                <div className="sleep-stack" aria-label={`${day.date}の段階内訳`}>{SLEEP_STAGES.map(type => day.stageMinutes[type] > 0 && <span key={type} className={`sleep-color ${type}`} style={{ width: `${day.stageMinutes[type] / Math.max(...summary.days.map(d => d.durationMinutes)) * 100}%` }} title={`${labels[type]} ${minutes(day.stageMinutes[type])}`} />)}</div>
              </summary>
              <p>{SLEEP_STAGES.map(type => `${labels[type]} ${minutes(day.stageMinutes[type])}`).join(' / ')}</p>
              {data.sessions.filter(s => s.wakeDate === day.date).map(details)}
            </details>)}</div>
              : <SleepSessionView sessions={data.sessions} range={selected} details={details} />}
          </>}
      </>}
    <p className="chart-foot">内訳は表示期間と重なる部分だけを集計。詳細にはセッション全体を表示します。段階未提供を睡眠0とは扱いません。</p>
  </section>;
}

function SleepSessionView({ sessions, range, details }: { sessions: SleepSession[]; range: TimeRange; details: (session: SleepSession) => ReactNode }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const session = sessions.find(s => s.id === selectedId) ?? [...sessions].reverse().find(s => s.nap !== true) ?? sessions.at(-1);
  if (!session) return null;
  const duration = session.asleepMinutes === null ? null : sleepDurationParts(Math.round(session.asleepMinutes));
  const approximate = session.asleepMinutes !== null && !Number.isInteger(session.asleepMinutes);
  const partial = session.startTime < range.from || session.endTime > range.to;
  return <div className="sleep-session-view" aria-label="睡眠段階のタイムライン">
    {sessions.length > 1 && <div className="sleep-session-picker" aria-label="表示する睡眠を選択">{sessions.map((s, index) => <button key={s.id}
      aria-pressed={s.id === session.id} onClick={() => setSelectedId(s.id)}>{s.nap === true ? '昼寝' : `睡眠${index + 1}`}<span>{dateTime(s.startTime)}</span></button>)}</div>}
    <div className="sleep-duration-heading"><h3>睡眠時間</h3><span>{session.nap === true ? '昼寝' : 'セッション全体'}</span></div>
    <div className="sleep-duration-line"><div className="sleep-duration-value" title={`睡眠時間 ${minutes(session.asleepMinutes)}`}>{duration ? <>
      {approximate && <small className="sleep-duration-approx">約</small>}
      {duration.hours > 0 && <>{duration.hours}<small>時間</small></>}{duration.minutes}<small>分</small>
    </> : '不明'}</div><p>{dateTime(session.startTime)} ～ {dateTime(session.endTime)}</p></div>
    <p className="sleep-duration-note">記録の長さ {minutes(session.durationMinutes)} · {session.type === 'unknown' ? '睡眠段階は未提供' : `覚醒・離床 ${minutes(session.stageMinutes.awake)}`}</p>
    {partial && <p className="sleep-partial-note">表示期間には睡眠の一部が含まれます。下のグラフと詳細はセッション全体です。</p>}
    <Suspense fallback={<p className="sleep-message" role="status">睡眠のグラフを準備しています</p>}><SleepTimeline session={session} /></Suspense>
    {details(session)}
  </div>;
}
