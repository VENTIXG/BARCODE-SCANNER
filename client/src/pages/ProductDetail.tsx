import { useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ArrowLeft, Camera, Pencil, SlidersHorizontal, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api, type Page } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDate, fmtDateTime, fmtMoney, fmtQty } from '../lib/format';
import { useT } from '../lib/i18n';
import { errMsg } from '../lib/queries';
import type { Product, Transaction } from '../lib/types';
import { AdjustStockModal } from '../components/AdjustStockModal';
import { TooltipBox, axisProps, useChartColors } from '../components/charts';
import { TxTable } from '../components/TxTable';
import { Badge, Button, Card, CardHeader, ConfirmDialog, EmptyState, LoadingBlock, PageHeader, Pagination, ProductThumb, StatusBadge, StockBadge } from '../components/ui';

interface Stats {
  totalIn: number;
  totalOut: number;
  transactions: number;
  lastStockIn: string | null;
  lastStockOut: string | null;
}

function Info({ label, children, mono }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div>
      <dt className="text-[11px] font-semibold tracking-wide text-muted uppercase">{label}</dt>
      <dd className={`mt-0.5 text-sm text-fg ${mono ? 'font-mono' : ''}`}>{children ?? '—'}</dd>
    </div>
  );
}

export default function ProductDetail() {
  const t = useT();
  const { id } = useParams();
  const { can } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const colors = useChartColors();
  const [page, setPage] = useState(1);
  const [adjust, setAdjust] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const product = useQuery({
    queryKey: ['product', id],
    queryFn: () => api.get<{ data: Product; stats: Stats; barcodeDuplicates: { id: number; sku: string; name: string }[] }>(`/products/${id}`),
  });
  const history = useQuery({
    queryKey: ['product-tx', id, page],
    queryFn: () => api.get<Page<Transaction>>(`/products/${id}/transactions`, { page, pageSize: 25 }),
    placeholderData: keepPreviousData,
  });
  const chart = useQuery({
    queryKey: ['product-tx-chart', id],
    queryFn: () => api.get<Page<Transaction>>(`/products/${id}/transactions`, { page: 1, pageSize: 300 }),
  });

  const del = useMutation({
    mutationFn: () => api.del(`/products/${id}`),
    onSuccess: () => {
      toast.success(t('Product deleted'));
      void qc.invalidateQueries({ queryKey: ['products'] });
      navigate('/products');
    },
    onError: (e) => (toast.error(errMsg(e)), setConfirmDelete(false)),
  });

  const upload = useMutation({
    mutationFn: (file: File) => {
      const fd = new FormData();
      fd.append('image', file);
      return api.post(`/products/${id}/image`, fd);
    },
    onSuccess: () => (toast.success(t('Photo updated')), void qc.invalidateQueries({ queryKey: ['product', id] })),
    onError: (e) => toast.error(errMsg(e)),
  });

  if (product.isLoading) return <LoadingBlock />;
  if (!product.data) return <EmptyState title={t('Product not found')} action={<Button onClick={() => navigate('/products')}>{t('Back to products')}</Button>} />;
  const p = product.data.data;
  const stats = product.data.stats;
  const series = [...(chart.data?.data ?? [])].reverse().map((tx) => ({ at: Date.parse(tx.created_at), qty: tx.quantity_after }));

  return (
    <div>
      <PageHeader
        back={
          <Link to="/products" className="mb-2 inline-flex items-center gap-1 text-xs text-muted hover:text-fg">
            <ArrowLeft className="size-3.5" /> {t('Products')}
          </Link>
        }
        title={p.name}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono">{p.sku}</span>
            <StatusBadge status={p.status} />
            <StockBadge status={p.stockStatus} />
          </span>
        }
        actions={
          <>
            {can('stock.adjust') && (
              <Button icon={<SlidersHorizontal className="size-4" />} onClick={() => setAdjust(true)}>
                {t('Adjust stock')}
              </Button>
            )}
            {can('products.manage') && (
              <Button variant="primary" icon={<Pencil className="size-4" />} onClick={() => navigate(`/products/${p.id}/edit`)}>
                {t('Edit')}
              </Button>
            )}
            {can('products.delete') && (
              <Button variant="ghost" icon={<Trash2 className="size-4" />} onClick={() => setConfirmDelete(true)} aria-label={t('Delete')} />
            )}
          </>
        }
      />

      {product.data.barcodeDuplicates.length > 0 && (
        <div className="mb-4 rounded-lg border border-warn/30 bg-warn-soft px-3 py-2 text-sm text-warn">
          {t('This barcode is also used by:')}{' '}
          {product.data.barcodeDuplicates.map((d, i) => (
            <span key={d.id}>
              {i > 0 && ', '}
              <Link to={`/products/${d.id}`} className="font-medium underline">{d.sku}</Link>
            </span>
          ))}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="p-5 lg:col-span-2">
          <div className="flex flex-col gap-5 sm:flex-row">
            <div className="relative self-start">
              <ProductThumb url={p.imageUrl} name={p.name} size="xl" />
              {can('products.manage') && (
                <>
                  <button
                    onClick={() => fileInput.current?.click()}
                    className="absolute -right-2 -bottom-2 flex size-8 items-center justify-center rounded-full border border-line bg-surface text-fg-2 shadow hover:text-fg"
                    title={t('Upload photo')}
                  >
                    <Camera className="size-4" />
                  </button>
                  <input ref={fileInput} type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && upload.mutate(e.target.files[0])} />
                </>
              )}
            </div>
            <dl className="grid flex-1 grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-3">
              <Info label={t('Barcode')} mono>{p.barcode}</Info>
              <Info label="SKU" mono>{p.sku}</Info>
              <Info label={t('Category')}>{p.categoryName}</Info>
              <Info label={t('Supplier')}>{p.supplierName}</Info>
              <Info label={t('Location')} mono>{p.locationCode}</Info>
              <Info label={t('Unit')}>{p.unit}</Info>
              <Info label={t('Purchase price')}>{fmtMoney(p.purchasePrice)}</Info>
              <Info label={t('Selling price')}>{fmtMoney(p.sellingPrice)}</Info>
              <Info label={t('Margin')}>
                {p.purchasePrice > 0 ? `${Math.round(((p.sellingPrice - p.purchasePrice) / p.purchasePrice) * 100)}%` : '—'}
              </Info>
              <Info label={t('Created')}>{fmtDate(p.createdAt)}</Info>
              <Info label={t('Last updated')}>{fmtDateTime(p.updatedAt)}</Info>
              <Info label={t('Status')}><StatusBadge status={p.status} /></Info>
              {p.description && (
                <div className="col-span-full">
                  <Info label={t('Description')}><span className="whitespace-pre-line">{p.description}</span></Info>
                </div>
              )}
            </dl>
          </div>
        </Card>

        <Card className="p-5">
          <div className="text-[11px] font-semibold tracking-wide text-muted uppercase">{t('Current stock')}</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className={`tabular text-4xl font-semibold tracking-tight ${p.stockStatus === 'OUT_OF_STOCK' ? 'text-bad' : p.stockStatus === 'LOW_STOCK' ? 'text-warn' : 'text-fg'}`}>
              {fmtQty(p.quantity)}
            </span>
            <span className="text-sm text-muted">{p.unit}</span>
          </div>
          <div className="mt-1 text-sm text-muted">
            {t('Minimum stock')}: <span className="tabular font-medium text-fg">{fmtQty(p.minStock)}</span>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3 border-t border-line pt-4 text-sm">
            <div>
              <div className="text-xs text-muted">{t('Stock value')}</div>
              <div className="tabular font-semibold">{fmtMoney(Math.max(p.quantity, 0) * p.purchasePrice)}</div>
            </div>
            <div>
              <div className="text-xs text-muted">{t('Transactions')}</div>
              <div className="tabular font-semibold">{stats.transactions}</div>
            </div>
            <div>
              <div className="text-xs text-muted">{t('Total in')}</div>
              <div className="tabular font-semibold text-ok">+{fmtQty(stats.totalIn)}</div>
            </div>
            <div>
              <div className="text-xs text-muted">{t('Total out')}</div>
              <div className="tabular font-semibold text-bad">−{fmtQty(stats.totalOut)}</div>
            </div>
            <div>
              <div className="text-xs text-muted">{t('Last stock in')}</div>
              <div className="text-xs">{fmtDateTime(stats.lastStockIn)}</div>
            </div>
            <div>
              <div className="text-xs text-muted">{t('Last stock out')}</div>
              <div className="text-xs">{fmtDateTime(stats.lastStockOut)}</div>
            </div>
          </div>
        </Card>
      </div>

      {series.length > 1 && (
        <Card className="mt-4">
          <CardHeader title={t('Stock level over time')} subtitle={t('Quantity after each transaction')} />
          <div className="h-52 px-2 py-3">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={series} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke={colors.grid} />
                <XAxis dataKey="at" type="number" scale="time" domain={['dataMin', 'dataMax']} tickFormatter={(v) => fmtDate(new Date(v).toISOString()).slice(0, 5)} minTickGap={40} {...axisProps(colors.axis)} />
                <YAxis width={40} {...axisProps(colors.axis)} />
                <Tooltip
                  cursor={{ stroke: colors.axis, strokeDasharray: '3 3' }}
                  content={({ active, payload }) =>
                    active && payload?.length ? (
                      <TooltipBox title={fmtDateTime(new Date(payload[0].payload.at).toISOString())} rows={[{ color: colors.c1, label: t('Stock'), value: fmtQty(Number(payload[0].value)) }]} />
                    ) : null
                  }
                />
                <Area type="stepAfter" dataKey="qty" stroke={colors.c1} strokeWidth={2} fill={colors.c1} fillOpacity={0.08} dot={false} activeDot={{ r: 4 }} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Card>
      )}

      <Card className="mt-4">
        <CardHeader title={t('Stock history')} subtitle={t('Full audit trail of every stock movement')} actions={<Badge>{history.data?.total ?? 0}</Badge>} />
        {!history.data?.data.length ? (
          <EmptyState title={t('No stock movements yet')} />
        ) : (
          <>
            <TxTable rows={history.data.data} showProduct={false} />
            <Pagination page={page} pageSize={25} total={history.data.total} onPage={setPage} />
          </>
        )}
      </Card>

      <AdjustStockModal product={p} open={adjust} onClose={() => setAdjust(false)} />
      <ConfirmDialog
        open={confirmDelete}
        title={t('Delete product?')}
        message={t('Products with stock movements cannot be deleted — set them to Inactive instead.')}
        confirmLabel={t('Delete')}
        tone="danger"
        loading={del.isPending}
        onConfirm={() => del.mutate()}
        onClose={() => setConfirmDelete(false)}
      />
    </div>
  );
}
