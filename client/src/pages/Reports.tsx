import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Download } from 'lucide-react';
import { toast } from 'sonner';
import { api, download, tz } from '../lib/api';
import { fmtDateTime, fmtDayShort, fmtMoney, fmtNumber, fmtQty, localDateToIso, todayLocal } from '../lib/format';
import { useT } from '../lib/i18n';
import { errMsg } from '../lib/queries';
import type { TxType } from '../lib/types';
import { ChartCard, LegendItem, TooltipBox, axisProps, useChartColors } from '../components/charts';
import { Button, Card, CardHeader, EmptyState, Input, LoadingBlock, PageHeader, QtyChange, Segmented, Table, Td, Th, TxTypeBadge } from '../components/ui';

interface MovementReport {
  byType: { type: TxType; count: number; units: number; value: number }[];
  byDay: { day: string; stockIn: number; stockOut: number; adjustments: number }[];
  topOut: { id: number; sku: string; name: string; unit: string; movements: number; units: number; value: number }[];
  topIn: { id: number; sku: string; name: string; unit: string; movements: number; units: number; value: number }[];
  byUser: { username: string; full_name: string | null; movements: number; unitsIn: number; unitsOut: number }[];
  adjustments: { id: number; created_at: string; type: TxType; quantity_before: number; quantity_change: number; quantity_after: number; notes: string | null; sku: string; name: string; username: string | null; value: number }[];
  noMovement: { id: number; sku: string; name: string; unit: string; quantity: number; value: number; last_out: string | null }[];
}

interface Valuation {
  name: string;
  products: number;
  units: number;
  costValue: number;
  retailValue: number;
  alerts: number;
}

function TopTable({ rows, valueLabel }: { rows: MovementReport['topOut']; valueLabel: string }) {
  const t = useT();
  if (!rows.length) return <EmptyState title={t('No data for this period')} />;
  const max = Math.max(...rows.map((r) => r.units));
  return (
    <Table>
      <thead>
        <tr>
          <Th>{t('Product')}</Th>
          <Th align="right">{t('Units')}</Th>
          <Th align="right" className="hidden sm:table-cell">{valueLabel}</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <Td>
              <Link to={`/products/${r.id}`} className="block max-w-[240px] truncate font-medium hover:underline">{r.name}</Link>
              <div className="mt-1 h-1 rounded-full bg-surface-3">
                <div className="h-full rounded-full bg-[var(--chart-1)]" style={{ width: `${(r.units / max) * 100}%` }} />
              </div>
            </Td>
            <Td align="right" className="tabular font-semibold">{fmtQty(r.units)}</Td>
            <Td align="right" className="tabular hidden sm:table-cell">{fmtMoney(r.value)}</Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

export default function Reports() {
  const t = useT();
  const colors = useChartColors();
  const [from, setFrom] = useState(todayLocal(-29));
  const [to, setTo] = useState(todayLocal());
  const [groupBy, setGroupBy] = useState<'category' | 'supplier' | 'zone'>('category');
  const range = useMemo(() => ({ from: localDateToIso(from), to: localDateToIso(to, true) }), [from, to]);

  const report = useQuery({
    queryKey: ['report-movements', range],
    queryFn: () => api.get<{ data: MovementReport }>('/reports/movements', { ...range, tz: tz() }).then((r) => r.data),
    enabled: Boolean(from && to),
  });
  const valuation = useQuery({
    queryKey: ['report-valuation', groupBy],
    queryFn: () => api.get<{ data: Valuation[] }>('/reports/valuation', { groupBy }).then((r) => r.data),
  });

  const presets: [string, number][] = [
    [t('7 days'), 6],
    [t('30 days'), 29],
    [t('90 days'), 89],
    [t('12 months'), 364],
  ];
  const r = report.data;
  const sumType = (types: TxType[]) => (r?.byType ?? []).filter((x) => types.includes(x.type)).reduce((s, x) => s + x.units, 0);
  const valTotals = (valuation.data ?? []).reduce((s, v) => ({ cost: s.cost + v.costValue, retail: s.retail + v.retailValue, units: s.units + v.units }), { cost: 0, retail: 0, units: 0 });

  return (
    <div>
      <PageHeader
        title={t('Reports')}
        subtitle={t('Warehouse movements and stock valuation')}
        actions={
          <Button icon={<Download className="size-4" />} onClick={() => download('/export/transactions', range).catch((e) => toast.error(errMsg(e)))}>
            {t('Export movements')}
          </Button>
        }
      />

      <Card className="mb-4 flex flex-wrap items-center gap-2 p-3">
        <Input type="date" className="w-auto" value={from} onChange={(e) => setFrom(e.target.value)} aria-label={t('From')} />
        <span className="text-muted">–</span>
        <Input type="date" className="w-auto" value={to} onChange={(e) => setTo(e.target.value)} aria-label={t('To')} />
        <div className="flex gap-1">
          {presets.map(([label, days]) => (
            <Button key={label} size="sm" variant="ghost" onClick={() => (setFrom(todayLocal(-days)), setTo(todayLocal()))}>
              {label}
            </Button>
          ))}
        </div>
      </Card>

      {report.isLoading || !r ? (
        <LoadingBlock />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[
              { label: t('Units received'), value: sumType(['STOCK_IN']), tone: 'text-ok' },
              { label: t('Units dispatched'), value: sumType(['STOCK_OUT']), tone: 'text-bad' },
              { label: t('Returns (in / out)'), value: `${fmtNumber(sumType(['RETURN_IN']))} / ${fmtNumber(sumType(['RETURN_OUT']))}`, tone: 'text-fg' },
              { label: t('Adjustments (+ / −)'), value: `${fmtNumber(sumType(['ADJUSTMENT_PLUS']))} / ${fmtNumber(sumType(['ADJUSTMENT_MINUS']))}`, tone: 'text-warn' },
            ].map((k) => (
              <Card key={k.label} className="p-4">
                <div className="text-[11px] font-semibold tracking-wide text-muted uppercase">{k.label}</div>
                <div className={`tabular mt-1 text-2xl font-semibold ${k.tone}`}>{typeof k.value === 'number' ? fmtNumber(k.value) : k.value}</div>
              </Card>
            ))}
          </div>

          <div className="mt-4">
            <ChartCard
              title={t('Stock IN vs Stock OUT per day')}
              subtitle={t('Units')}
              legend={
                <>
                  <LegendItem color={colors.c1} label={t('Stock in')} />
                  <LegendItem color={colors.c2} label={t('Stock out')} />
                </>
              }
            >
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={r.byDay} barGap={1} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke={colors.grid} />
                  <XAxis dataKey="day" tickFormatter={fmtDayShort} minTickGap={16} {...axisProps(colors.axis)} />
                  <YAxis width={44} tickFormatter={(v) => fmtNumber(v)} {...axisProps(colors.axis)} />
                  <Tooltip
                    cursor={{ fill: colors.grid, opacity: 0.5 }}
                    content={({ active, payload }) => {
                      const d = payload?.[0]?.payload as MovementReport['byDay'][number] | undefined;
                      return active && d ? (
                        <TooltipBox
                          title={fmtDayShort(d.day)}
                          rows={[
                            { color: colors.c1, label: t('Stock in'), value: fmtNumber(d.stockIn) },
                            { color: colors.c2, label: t('Stock out'), value: fmtNumber(d.stockOut) },
                            { label: t('Adjustments'), value: fmtNumber(d.adjustments) },
                          ]}
                        />
                      ) : null;
                    }}
                  />
                  <Bar dataKey="stockIn" fill={colors.c1} radius={[3, 3, 0, 0]} maxBarSize={12} />
                  <Bar dataKey="stockOut" fill={colors.c2} radius={[3, 3, 0, 0]} maxBarSize={12} />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>
          </div>

          <div className="mt-4 grid gap-4 xl:grid-cols-2">
            <Card>
              <CardHeader title={t('Top dispatched products')} subtitle={t('By units in the period')} />
              <TopTable rows={r.topOut} valueLabel={t('Sales value')} />
            </Card>
            <Card>
              <CardHeader title={t('Top received products')} subtitle={t('By units in the period')} />
              <TopTable rows={r.topIn} valueLabel={t('Cost value')} />
            </Card>
            <Card>
              <CardHeader title={t('Movements by type')} />
              <Table>
                <thead>
                  <tr>
                    <Th>{t('Type')}</Th>
                    <Th align="right">{t('Transactions')}</Th>
                    <Th align="right">{t('Units')}</Th>
                    <Th align="right">{t('Cost value')}</Th>
                  </tr>
                </thead>
                <tbody>
                  {r.byType.map((x) => (
                    <tr key={x.type}>
                      <Td><TxTypeBadge type={x.type} /></Td>
                      <Td align="right" className="tabular">{fmtNumber(x.count)}</Td>
                      <Td align="right" className="tabular">{fmtQty(x.units)}</Td>
                      <Td align="right" className="tabular">{fmtMoney(x.value)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Card>
            <Card>
              <CardHeader title={t('Activity by user')} />
              <Table>
                <thead>
                  <tr>
                    <Th>{t('User')}</Th>
                    <Th align="right">{t('Transactions')}</Th>
                    <Th align="right">{t('Units in')}</Th>
                    <Th align="right">{t('Units out')}</Th>
                  </tr>
                </thead>
                <tbody>
                  {r.byUser.map((u) => (
                    <tr key={u.username}>
                      <Td>{u.full_name ?? u.username}</Td>
                      <Td align="right" className="tabular">{fmtNumber(u.movements)}</Td>
                      <Td align="right" className="tabular">{fmtQty(u.unitsIn)}</Td>
                      <Td align="right" className="tabular">{fmtQty(u.unitsOut)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Card>
            <Card>
              <CardHeader title={t('Inventory adjustments')} subtitle={t('Differences found and corrected in the period')} />
              {!r.adjustments.length ? (
                <EmptyState title={t('No adjustments in this period')} />
              ) : (
                <div className="max-h-96 overflow-y-auto">
                  <Table>
                    <thead>
                      <tr>
                        <Th>{t('Date/Time')}</Th>
                        <Th>{t('Product')}</Th>
                        <Th align="right">{t('Change')}</Th>
                        <Th align="right">{t('Value')}</Th>
                        <Th>{t('Reason')}</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {r.adjustments.map((a) => (
                        <tr key={a.id}>
                          <Td className="tabular text-xs whitespace-nowrap">{fmtDateTime(a.created_at)}</Td>
                          <Td>
                            <div className="max-w-[180px] truncate">{a.name}</div>
                            <div className="font-mono text-xs text-muted">{a.sku}</div>
                          </Td>
                          <Td align="right"><QtyChange value={a.quantity_change} /></Td>
                          <Td align="right" className="tabular">{fmtMoney(a.value)}</Td>
                          <Td className="max-w-[180px] truncate text-xs">{a.notes}</Td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </div>
              )}
            </Card>
            <Card>
              <CardHeader title={t('Stock without sales')} subtitle={t('No stock out in the period, highest value first')} />
              {!r.noMovement.length ? (
                <EmptyState title={t('Every product with stock moved in this period')} />
              ) : (
                <Table>
                  <thead>
                    <tr>
                      <Th>{t('Product')}</Th>
                      <Th align="right">{t('Stock')}</Th>
                      <Th align="right">{t('Value')}</Th>
                      <Th className="hidden sm:table-cell">{t('Last stock out')}</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.noMovement.map((p) => (
                      <tr key={p.id}>
                        <Td><Link to={`/products/${p.id}`} className="block max-w-[200px] truncate hover:underline">{p.name}</Link></Td>
                        <Td align="right" className="tabular">{fmtQty(p.quantity, p.unit)}</Td>
                        <Td align="right" className="tabular">{fmtMoney(p.value)}</Td>
                        <Td className="hidden text-xs sm:table-cell">{fmtDateTime(p.last_out)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Card>
          </div>
        </>
      )}

      <Card className="mt-4">
        <CardHeader
          title={t('Stock valuation')}
          subtitle={t('Current stock of active products')}
          actions={
            <Segmented
              value={groupBy}
              onChange={setGroupBy}
              options={[
                { value: 'category', label: t('Category') },
                { value: 'supplier', label: t('Supplier') },
                { value: 'zone', label: t('Zone') },
              ]}
            />
          }
        />
        {valuation.isLoading ? (
          <LoadingBlock />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>{groupBy === 'category' ? t('Category') : groupBy === 'supplier' ? t('Supplier') : t('Zone')}</Th>
                <Th align="right">{t('Products')}</Th>
                <Th align="right">{t('Units')}</Th>
                <Th align="right">{t('Cost value')}</Th>
                <Th align="right" className="hidden sm:table-cell">{t('Retail value')}</Th>
                <Th align="right" className="hidden md:table-cell">{t('Stock alerts')}</Th>
              </tr>
            </thead>
            <tbody>
              {valuation.data?.map((v) => (
                <tr key={v.name}>
                  <Td className="font-medium">{v.name}</Td>
                  <Td align="right" className="tabular">{fmtNumber(v.products)}</Td>
                  <Td align="right" className="tabular">{fmtQty(v.units)}</Td>
                  <Td align="right" className="tabular">{fmtMoney(v.costValue)}</Td>
                  <Td align="right" className="tabular hidden sm:table-cell">{fmtMoney(v.retailValue)}</Td>
                  <Td align="right" className={`tabular hidden md:table-cell ${v.alerts ? 'text-warn' : ''}`}>{fmtNumber(v.alerts)}</Td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="font-semibold">
                <Td>{t('Total')}</Td>
                <Td />
                <Td align="right" className="tabular">{fmtQty(valTotals.units)}</Td>
                <Td align="right" className="tabular">{fmtMoney(valTotals.cost)}</Td>
                <Td align="right" className="tabular hidden sm:table-cell">{fmtMoney(valTotals.retail)}</Td>
                <Td className="hidden md:table-cell" />
              </tr>
            </tfoot>
          </Table>
        )}
      </Card>
    </div>
  );
}
