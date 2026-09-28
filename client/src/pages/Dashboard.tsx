import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { AlertTriangle, ArrowDownToLine, ArrowLeftRight, ArrowUpFromLine, Boxes, Euro, Package, PackageX } from 'lucide-react';
import clsx from 'clsx';
import { api, tz } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDateTime, fmtDayShort, fmtMoney, fmtMonth, fmtNumber, fmtQty, fmtRelative } from '../lib/format';
import { useT } from '../lib/i18n';
import type { Product, Transaction } from '../lib/types';
import { ChartCard, LegendItem, TooltipBox, axisProps, useChartColors } from '../components/charts';
import { Card, CardHeader, EmptyState, LoadingBlock, PageHeader, ProductThumb, QtyChange, StockBadge, TxTypeBadge } from '../components/ui';

interface DashboardData {
  totals: { totalProducts: number; activeProducts: number; totalUnits: number; inventoryValue: number; retailValue: number; lowStock: number; outOfStock: number };
  today: { stockInUnits: number; stockInCount: number; stockOutUnits: number; stockOutCount: number; transactions: number };
  monthly: { month: string; stockIn: number; stockOut: number }[];
  daily: { day: string; movements: number; unitsIn: number; unitsOut: number }[];
  valueTrend: { month: string; value: number }[];
  byCategory: { category: string; products: number; units: number; value: number }[];
  recent: Transaction[];
  lowStock: Product[];
}

function Kpi({ label, value, sub, icon, tone = 'neutral', to }: { label: string; value: string; sub?: string; icon: React.ReactNode; tone?: 'neutral' | 'warn' | 'bad' | 'ok' | 'brand'; to?: string }) {
  const toneCls = { neutral: 'bg-surface-3 text-fg-2', warn: 'bg-warn-soft text-warn', bad: 'bg-bad-soft text-bad', ok: 'bg-ok-soft text-ok', brand: 'bg-brand-soft text-brand-fg' }[tone];
  const body = (
    <Card className={clsx('flex h-full items-start gap-3 p-4', to && 'transition-colors hover:border-line-strong')}>
      <div className={clsx('flex size-9 shrink-0 items-center justify-center rounded-lg', toneCls)}>{icon}</div>
      <div className="min-w-0">
        <div className="text-[11px] font-semibold tracking-wide text-muted uppercase">{label}</div>
        <div className="mt-0.5 truncate text-2xl font-semibold tracking-tight text-fg">{value}</div>
        {sub && <div className="mt-0.5 truncate text-xs text-muted">{sub}</div>}
      </div>
    </Card>
  );
  return to ? <Link to={to}>{body}</Link> : body;
}

export default function Dashboard() {
  const t = useT();
  const { user, can } = useAuth();
  const colors = useChartColors();
  const { data, isLoading } = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api.get<{ data: DashboardData }>('/dashboard', { tz: tz() }).then((r) => r.data),
    refetchInterval: 60_000,
  });
  if (isLoading || !data) return <LoadingBlock />;
  const { totals, today } = data;
  const hour = new Date().getHours();
  const greeting = hour < 12 ? t('Good morning') : hour < 18 ? t('Good afternoon') : t('Good evening');

  return (
    <div>
      <PageHeader title={t('Dashboard')} subtitle={`${greeting}, ${user?.fullName.split(' ')[0]}`} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label={t('Total products')} value={fmtNumber(totals.totalProducts)} sub={t('{n} active', { n: fmtNumber(totals.activeProducts) })} icon={<Package className="size-4.5" />} tone="brand" to="/products" />
        <Kpi label={t('Total stock units')} value={fmtNumber(totals.totalUnits)} icon={<Boxes className="size-4.5" />} to="/inventory" />
        <Kpi label={t('Total inventory value')} value={fmtMoney(totals.inventoryValue)} sub={t('Retail value {v}', { v: fmtMoney(totals.retailValue, { compact: true }) })} icon={<Euro className="size-4.5" />} />
        <Kpi label={t('Low stock items')} value={fmtNumber(totals.lowStock)} icon={<AlertTriangle className="size-4.5" />} tone={totals.lowStock ? 'warn' : 'neutral'} to="/low-stock" />
        <Kpi label={t('Out of stock items')} value={fmtNumber(totals.outOfStock)} icon={<PackageX className="size-4.5" />} tone={totals.outOfStock ? 'bad' : 'neutral'} to="/low-stock?tab=out" />
        <Kpi label={t('Today stock in')} value={fmtNumber(today.stockInUnits)} sub={t('{n} movements', { n: today.stockInCount })} icon={<ArrowDownToLine className="size-4.5" />} tone="ok" />
        <Kpi label={t('Today stock out')} value={fmtNumber(today.stockOutUnits)} sub={t('{n} movements', { n: today.stockOutCount })} icon={<ArrowUpFromLine className="size-4.5" />} tone="bad" />
        <Kpi label={t('Transactions today')} value={fmtNumber(today.transactions)} icon={<ArrowLeftRight className="size-4.5" />} to={can('transactions.view') ? '/transactions' : undefined} />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <ChartCard
          title={t('Stock IN vs Stock OUT')}
          subtitle={t('Units per month, last 12 months')}
          legend={
            <>
              <LegendItem color={colors.c1} label={t('Stock in')} />
              <LegendItem color={colors.c2} label={t('Stock out')} />
            </>
          }
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data.monthly} barGap={2} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke={colors.grid} />
              <XAxis dataKey="month" tickFormatter={fmtMonth} {...axisProps(colors.axis)} />
              <YAxis width={44} tickFormatter={(v) => fmtNumber(v)} {...axisProps(colors.axis)} />
              <Tooltip
                cursor={{ fill: colors.grid, opacity: 0.5 }}
                content={({ active, payload, label }) =>
                  active && payload?.length ? (
                    <TooltipBox
                      title={fmtMonth(String(label))}
                      rows={[
                        { color: colors.c1, label: t('Stock in'), value: fmtNumber(Number(payload[0]?.value)) },
                        { color: colors.c2, label: t('Stock out'), value: fmtNumber(Number(payload[1]?.value)) },
                      ]}
                    />
                  ) : null
                }
              />
              <Bar dataKey="stockIn" fill={colors.c1} radius={[4, 4, 0, 0]} maxBarSize={18} />
              <Bar dataKey="stockOut" fill={colors.c2} radius={[4, 4, 0, 0]} maxBarSize={18} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title={t('Movements, last 30 days')} subtitle={t('Number of stock transactions per day')}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data.daily} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke={colors.grid} />
              <XAxis dataKey="day" tickFormatter={fmtDayShort} interval="preserveStartEnd" minTickGap={16} {...axisProps(colors.axis)} />
              <YAxis width={36} allowDecimals={false} {...axisProps(colors.axis)} />
              <Tooltip
                cursor={{ fill: colors.grid, opacity: 0.5 }}
                content={({ active, payload }) => {
                  const d = payload?.[0]?.payload as DashboardData['daily'][number] | undefined;
                  return active && d ? (
                    <TooltipBox
                      title={fmtDayShort(d.day)}
                      rows={[
                        { color: colors.c1, label: t('Movements'), value: fmtNumber(d.movements) },
                        { label: t('Units in'), value: fmtNumber(d.unitsIn) },
                        { label: t('Units out'), value: fmtNumber(d.unitsOut) },
                      ]}
                    />
                  ) : null;
                }}
              />
              <Bar dataKey="movements" fill={colors.c1} radius={[3, 3, 0, 0]} maxBarSize={14} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title={t('Inventory value')} subtitle={t('End of month, at current purchase prices')}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data.valueTrend} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="valueFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={colors.c1} stopOpacity={0.25} />
                  <stop offset="100%" stopColor={colors.c1} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} stroke={colors.grid} />
              <XAxis dataKey="month" tickFormatter={fmtMonth} {...axisProps(colors.axis)} />
              <YAxis width={72} tickFormatter={(v) => fmtMoney(v, { compact: true })} {...axisProps(colors.axis)} />
              <Tooltip
                cursor={{ stroke: colors.axis, strokeDasharray: '3 3' }}
                content={({ active, payload, label }) =>
                  active && payload?.length ? <TooltipBox title={fmtMonth(String(label))} rows={[{ color: colors.c1, label: t('Value'), value: fmtMoney(Number(payload[0].value)) }]} /> : null
                }
              />
              <Area type="monotone" dataKey="value" stroke={colors.c1} strokeWidth={2} fill="url(#valueFill)" activeDot={{ r: 4, strokeWidth: 2, stroke: colors.surface }} />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title={t('Products by category')} subtitle={t('Active products')}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data.byCategory} layout="vertical" margin={{ top: 0, right: 16, left: 0, bottom: 0 }}>
              <CartesianGrid horizontal={false} stroke={colors.grid} />
              <XAxis type="number" allowDecimals={false} {...axisProps(colors.axis)} />
              <YAxis type="category" dataKey="category" width={110} {...axisProps(colors.axis)} tick={{ fill: colors.fg2, fontSize: 11 }} />
              <Tooltip
                cursor={{ fill: colors.grid, opacity: 0.5 }}
                content={({ active, payload }) => {
                  const d = payload?.[0]?.payload as DashboardData['byCategory'][number] | undefined;
                  return active && d ? (
                    <TooltipBox
                      title={d.category}
                      rows={[
                        { color: colors.c1, label: t('Products'), value: fmtNumber(d.products) },
                        { label: t('Units'), value: fmtNumber(d.units) },
                        { label: t('Value'), value: fmtMoney(d.value) },
                      ]}
                    />
                  ) : null;
                }}
              />
              <Bar dataKey="products" fill={colors.c1} radius={[0, 4, 4, 0]} maxBarSize={16} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-5">
        <Card className="xl:col-span-3">
          <CardHeader title={t('Recent transactions')} actions={can('transactions.view') && <Link to="/transactions" className="text-xs font-medium text-brand-fg hover:underline">{t('View all')} →</Link>} />
          {data.recent.length === 0 ? (
            <EmptyState title={t('No transactions yet')} />
          ) : (
            <ul className="divide-y divide-line">
              {data.recent.map((tx) => (
                <li key={tx.id} className="flex items-center gap-3 px-4 py-2.5">
                  <TxTypeBadge type={tx.type} />
                  <Link to={`/products/${tx.product_id}`} className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-fg hover:underline">{tx.product_name}</div>
                    <div className="truncate text-xs text-muted">
                      <span className="font-mono">{tx.sku}</span> · {tx.username ?? 'system'} · <span title={fmtDateTime(tx.created_at)}>{fmtRelative(tx.created_at)}</span>
                    </div>
                  </Link>
                  <div className="text-right">
                    <QtyChange value={tx.quantity_change} />
                    <div className="tabular text-xs text-muted">
                      {fmtQty(tx.quantity_before)} → {fmtQty(tx.quantity_after)}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="xl:col-span-2">
          <CardHeader title={t('Low stock alerts')} actions={<Link to="/low-stock" className="text-xs font-medium text-brand-fg hover:underline">{t('View all')} →</Link>} />
          {data.lowStock.length === 0 ? (
            <EmptyState title={t('All products are above minimum stock')} />
          ) : (
            <ul className="divide-y divide-line">
              {data.lowStock.map((p) => (
                <li key={p.id}>
                  <Link to={`/products/${p.id}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-surface-2">
                    <ProductThumb url={p.imageUrl} name={p.name} size="sm" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-fg">{p.name}</div>
                      <div className="truncate text-xs text-muted">
                        <span className="font-mono">{p.sku}</span> · {t('min')} {fmtQty(p.minStock)}
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <span className="tabular text-sm font-semibold">{fmtQty(p.quantity, p.unit)}</span>
                      <StockBadge status={p.stockStatus} />
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
