import { useEffect, useRef } from 'react';
import * as echarts from 'echarts/core';
import { BarChart } from 'echarts/charts';
import { GridComponent, TooltipComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import { MINUTE, activitySpecs, type ActivityResponse } from '@healthcheck/core';
import { dateTime, timeOnly } from './time.js';

echarts.use([BarChart, GridComponent, TooltipComponent, SVGRenderer]);
export default function ActivityChart({ data }: { data: ActivityResponse }) {
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!element.current) return;
    const chart = echarts.init(element.current, undefined, { renderer: 'svg' });
    const unit = activitySpecs[data.metric].displayUnit;
    chart.setOption({ animation: false, grid: { top: 38, right: 25, bottom: 45, left: 65 },
      tooltip: { trigger: 'axis', confine: true, formatter: (params: unknown) => {
        const p = data.points[(params as { dataIndex: number }[])[0]?.dataIndex ?? -1];
        if (!p) return '';
        return `${dateTime(p.from)} ～ ${dateTime(p.to)} JST<br/>${p.total === null ? '値なし' : `${p.total.toLocaleString('ja-JP', { maximumFractionDigits: 3 })} ${unit}`}<br/>値あり ${p.availableMinutes} / ${p.totalMinutes}分`;
      } },
      xAxis: { type: 'time', min: data.from, max: Date.parse(data.to) - MINUTE, splitNumber: 6,
        axisLabel: { hideOverlap: true, formatter: (ms: number) => data.resolution === '1m' ? timeOnly(ms) : data.resolution === '1d' ? dateTime(new Date(ms).toISOString()).split(' ')[0] : dateTime(new Date(ms).toISOString()) } },
      yAxis: { type: 'value', name: unit, min: 0, splitLine: { lineStyle: { type: 'dashed', color: '#e8ece6' } } },
      series: [{ type: 'bar', name: activitySpecs[data.metric].label, itemStyle: { color: '#497f6d' },
        data: data.points.map(p => [p.from, p.total]) }],
    });
    const observer = new ResizeObserver(() => chart.resize()); observer.observe(element.current);
    return () => { observer.disconnect(); chart.dispose(); };
  }, [data]);
  return <div className="heart-chart" ref={element} role="img" aria-label={`${activitySpecs[data.metric].label}の合計グラフ。単位：${activitySpecs[data.metric].displayUnit}。日別の表でも確認できます。`} />;
}
