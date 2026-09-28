import { useEffect, useState, type ReactNode } from 'react';
import { Card, CardHeader } from './ui';

function read() {
  const s = getComputedStyle(document.documentElement);
  const v = (n: string) => s.getPropertyValue(n).trim();
  return {
    c1: v('--chart-1'),
    c2: v('--chart-2'),
    c3: v('--chart-3'),
    grid: v('--chart-grid'),
    axis: v('--chart-axis'),
    surface: v('--surface'),
    fg: v('--fg'),
    fg2: v('--fg-2'),
    line: v('--line'),
  };
}

/** Chart colours from CSS tokens; updates when the theme toggles. */
export function useChartColors() {
  const [colors, setColors] = useState(read);
  useEffect(() => {
    const obs = new MutationObserver(() => setColors(read()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);
  return colors;
}

export function ChartCard({ title, subtitle, children, actions, legend }: { title: ReactNode; subtitle?: ReactNode; children: ReactNode; actions?: ReactNode; legend?: ReactNode }) {
  return (
    <Card className="flex flex-col">
      <CardHeader title={title} subtitle={subtitle} actions={actions} />
      {legend && <div className="flex flex-wrap gap-4 px-4 pt-3 text-xs text-fg-2">{legend}</div>}
      <div className="h-64 px-2 pt-3 pb-2">{children}</div>
    </Card>
  );
}

export function LegendItem({ color, label }: { color: string; label: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="size-2.5 rounded-sm" style={{ background: color }} />
      {label}
    </span>
  );
}

/** Shared tooltip body. */
export function TooltipBox({ title, rows }: { title: ReactNode; rows: { color?: string; label: ReactNode; value: ReactNode }[] }) {
  return (
    <div className="min-w-36 rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-lg">
      <div className="mb-1 font-semibold text-fg">{title}</div>
      {rows.map((r, i) => (
        <div key={i} className="flex items-center justify-between gap-4 py-0.5">
          <span className="flex items-center gap-1.5 text-fg-2">
            {r.color && <span className="size-2 rounded-sm" style={{ background: r.color }} />}
            {r.label}
          </span>
          <span className="tabular font-semibold text-fg">{r.value}</span>
        </div>
      ))}
    </div>
  );
}

export const axisProps = (axis: string) => ({
  tick: { fill: axis, fontSize: 11 },
  tickLine: false,
  axisLine: false,
});
