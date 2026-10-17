import { useEffect, useMemo, useRef } from 'react';
import * as echarts from 'echarts/core';
import { CustomChart } from 'echarts/charts';
import { GridComponent, TooltipComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import type { CustomSeriesRenderItem } from 'echarts';
import type { SleepSession } from '@healthcheck/core';
import { dateTime, timeOnly } from './time.js';
import { sleepColors, sleepLabels, sleepMinutes, sleepRows } from './sleepPresentation.js';

echarts.use([CustomChart, GridComponent, TooltipComponent, SVGRenderer]);
const ROW_HEIGHT = 64;
const TRACK_HEIGHT = 26;
const TRACK_CENTER = 36;

export default function SleepTimeline({ session }: { session: SleepSession }) {
  const element = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => sleepRows(session), [session]);
  useEffect(() => {
    if (!element.current) return;
    const chart = echarts.init(element.current, undefined, { renderer: 'svg' });
    const start = Date.parse(session.startTime), end = Date.parse(session.endTime);
    // カテゴリ数が1つでも、同じ行間・位置で段階未提供を表示する。
    const y = (index: number) => rows.length === 1 ? 0.5 : index;
    const track: CustomSeriesRenderItem = (params, api) => {
      const row = params.dataIndex;
      const [left, center] = api.coord([start, y(row)]) as [number, number];
      const [right] = api.coord([end, y(row)]) as [number];
      return { type: 'rect', silent: true, shape: { x: left, y: center - TRACK_HEIGHT / 2, width: right - left, height: TRACK_HEIGHT, r: TRACK_HEIGHT / 2 },
        style: { fill: '#edf0f7' } };
    };
    const interval: CustomSeriesRenderItem = (params, api) => {
      const stage = session.stages[params.dataIndex];
      if (!stage) return null;
      const row = rows.indexOf(stage.type);
      const [left, center] = api.coord([Date.parse(stage.startTime), y(row)]) as [number, number];
      const [right] = api.coord([Date.parse(stage.endTime), y(row)]) as [number];
      const width = Math.max(1, right - left), color = sleepColors[stage.type];
      const previous = session.stages[params.dataIndex - 1];
      const previousCenter = previous ? api.coord([Date.parse(stage.startTime), y(rows.indexOf(previous.type))])[1]! : center;
      return { type: 'group', children: [
        { type: 'line', silent: true, shape: { x1: left, y1: previousCenter, x2: left, y2: center },
          style: { stroke: color, opacity: 0.3, lineWidth: 1.4 } },
        { type: 'rect', shape: { x: Math.min(left, api.getWidth() - width - 2), y: center - TRACK_HEIGHT / 2, width, height: TRACK_HEIGHT, r: Math.min(11, width / 2) },
          style: { fill: stage.type === 'rem' ? '#b7eff8' : stage.type === 'unknown' ? '#d9dfe5' : color,
            stroke: stage.type === 'rem' || stage.type === 'unknown' ? color : undefined,
            lineWidth: stage.type === 'rem' ? 2 : 1,
            lineDash: stage.type === 'unknown' ? [3, 3] : undefined } },
      ] };
    };
    chart.setOption({
      animation: false,
      grid: { left: 3, right: 3, top: rows.length === 1 ? 28 : TRACK_CENTER,
        bottom: rows.length === 1 ? 28 : ROW_HEIGHT + 8 - TRACK_CENTER },
      xAxis: { type: 'time', min: start, max: end, show: false },
      yAxis: { type: 'value', min: 0, max: Math.max(1, rows.length - 1), inverse: true, show: false },
      tooltip: { trigger: 'item', confine: true, backgroundColor: '#243348', borderWidth: 0,
        textStyle: { color: '#fff', fontFamily: 'Noto Sans JP, sans-serif', fontSize: 12 },
        formatter: (params: unknown) => {
          const stage = session.stages[(params as { dataIndex: number }).dataIndex];
          if (!stage) return '';
          return `${sleepLabels[stage.type]}<br/>${dateTime(stage.startTime)} ～ ${dateTime(stage.endTime)}<br/>${sleepMinutes((Date.parse(stage.endTime) - Date.parse(stage.startTime)) / 60_000)}`;
        } },
      series: [
        { name: '段階の行', type: 'custom', renderItem: track, silent: true, tooltip: { show: false },
          data: rows.map((_, index) => [start, y(index), end]), encode: { x: [0, 2], y: 1 }, z: 0 },
        { name: '睡眠段階', type: 'custom', renderItem: interval,
          data: session.stages.map(stage => [Date.parse(stage.startTime), y(rows.indexOf(stage.type)), Date.parse(stage.endTime)]),
          encode: { x: [0, 2], y: 1 }, z: 2 },
      ],
    });
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(element.current);
    return () => { observer.disconnect(); chart.dispose(); };
  }, [session, rows]);

  const midpoint = (Date.parse(session.startTime) + Date.parse(session.endTime)) / 2;
  return <div className="sleep-stage-chart">
    <div className="sleep-timeline" style={{ height: rows.length * ROW_HEIGHT + 8 }}>
      <div className="sleep-chart-canvas" ref={element} role="img"
        aria-label={`${dateTime(session.startTime)}から${dateTime(session.endTime)}の睡眠段階。段階ごとの行で時間の推移を表示。下の詳細でも確認できます。`} />
      <dl className="sleep-stage-labels">{rows.map((type, index) => <div className="sleep-stage-label" key={type} style={{ top: index * ROW_HEIGHT }}>
        <dt>{sleepLabels[type]}</dt><dd>{sleepMinutes(session.stageMinutes[type])}</dd>
      </div>)}</dl>
    </div>
    <div className="sleep-time-axis" aria-label="睡眠の時刻（JST）">
      <span><strong>{timeOnly(session.startTime)}</strong><small>記録開始</small></span>
      <span><strong>{timeOnly(midpoint)}</strong><small>JST</small></span>
      <span><strong>{timeOnly(session.endTime)}</strong><small>記録終了</small></span>
    </div>
  </div>;
}
