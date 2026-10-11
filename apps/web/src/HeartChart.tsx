import { useEffect, useRef } from 'react';
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import { GridComponent, TooltipComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import { type HeartPoint } from '@healthcheck/core';
import { dateTime, timeOnly } from './time.js';

echarts.use([LineChart, GridComponent, TooltipComponent, SVGRenderer]);

export function HeartChart({ points }: { points: HeartPoint[] }) {
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!element.current) return;
    const chart = echarts.init(element.current, undefined, { renderer: 'svg' });
    chart.setOption({
      animation: false,
      grid: { top: 28, right: 20, bottom: 42, left: 48 },
      tooltip: { trigger: 'axis', confine: true, backgroundColor: '#163d36', borderWidth: 0, textStyle: { color: '#fff' },
        formatter: (params: unknown) => {
          const items = params as { dataIndex: number }[];
          const point = points[items[0]?.dataIndex ?? -1];
          if (!point) return '';
          return `${dateTime(point.time)} JST<br/>${point.value
            ? `<strong>${point.value.avg.toFixed(1)} bpm</strong><br/>最小 ${point.value.min.toFixed(1)} / 最大 ${point.value.max.toFixed(1)}`
            : 'データなし'}`;
        },
      },
      xAxis: { type: 'time', min: points[0]?.time, max: points.at(-1)?.time, splitNumber: 6,
        axisLine: { lineStyle: { color: '#d9e0d9' } }, axisTick: { show: false },
        axisLabel: { color: '#68756c', hideOverlap: true, formatter: (value: number) => timeOnly(value) },
        splitLine: { show: false }, axisPointer: { lineStyle: { color: '#547a6c', type: 'dashed' } },
      },
      yAxis: { type: 'value', name: 'bpm', nameTextStyle: { color: '#68756c', align: 'right', padding: [0, 8, 0, 0] },
        min: (value: { min: number }) => Math.max(0, Math.floor(value.min / 10) * 10 - 10),
        axisLabel: { color: '#68756c' }, splitLine: { lineStyle: { color: '#e8ece6', type: 'dashed' } },
      },
      series: [
        { name: '最小', type: 'line', stack: 'range', stackStrategy: 'all', symbol: 'none', lineStyle: { opacity: 0 },
          emphasis: { disabled: true }, data: points.map(p => [p.time, p.value?.min ?? null]) },
        { name: '最小〜最大', type: 'line', stack: 'range', stackStrategy: 'all', symbol: 'none', lineStyle: { opacity: 0 },
          areaStyle: { color: '#91b7a5', opacity: 0.28 }, emphasis: { disabled: true },
          data: points.map(p => [p.time, p.value ? p.value.max - p.value.min : null]) },
        { name: '1分平均', type: 'line', symbol: 'none', connectNulls: false,
          lineStyle: { color: '#236653', width: 1.7 }, itemStyle: { color: '#236653' },
          data: points.map(p => [p.time, p.value?.avg ?? null]) },
      ],
    });
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(element.current);
    return () => { observer.disconnect(); chart.dispose(); };
  }, [points]);
  return <div className="heart-chart" ref={element} role="img" aria-label="心拍の1分平均と最小・最大のグラフ。下の表でも値を確認できます。" />;
}

export default HeartChart;
