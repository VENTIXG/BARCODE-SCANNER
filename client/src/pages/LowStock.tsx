import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowDownToLine, CheckCircle2, Download, PackageX } from 'lucide-react';
import { toast } from 'sonner';
import { api, download, type Page } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtNumber, fmtQty } from '../lib/format';
import { useT } from '../lib/i18n';
import { errMsg, useSuppliers } from '../lib/queries';
import type { Product } from '../lib/types';
import { Button, Card, EmptyState, LoadingBlock, PageHeader, Pagination, ProductThumb, Select, StockBadge, Table, Tabs, Td, Th } from '../components/ui';

type Tab = 'alert' | 'out' | 'low';

const suggested = (p: Product) => Math.max(Math.ceil(p.minStock * 2 - p.quantity), 1);

export default function LowStock() {
  const t = useT();
  const { can } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) ?? 'alert';
  const [supplierId, setSupplierId] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Map<number, Product>>(new Map());
  const suppliers = useSuppliers();

  const counts = useQuery({
    queryKey: ['low-stock-counts'],
    queryFn: async () => {
      const [out, low] = await Promise.all([
        api.get<Page<Product>>('/products', { stock: 'out', status: 'ACTIVE', pageSize: 1 }),
        api.get<Page<Product>>('/products', { stock: 'low', status: 'ACTIVE', pageSize: 1 }),
      ]);
      return { out: out.total, low: low.total };
    },
  });
  const { data, isLoading } = useQuery({
    queryKey: ['products', 'low-stock', tab, supplierId, page],
    queryFn: () => api.get<Page<Product>>('/products', { stock: tab, status: 'ACTIVE', supplierId, sort: 'quantity', page, pageSize: 50 }),
    placeholderData: keepPreviousData,
  });

  const toggle = (p: Product) =>
    setSelected((s) => {
      const n = new Map(s);
      if (n.has(p.id)) n.delete(p.id);
      else n.set(p.id, p);
      return n;
    });
  const allOnPage = data?.data ?? [];
  const allSelected = allOnPage.length > 0 && allOnPage.every((p) => selected.has(p.id));

  const receive = () =>
    navigate('/stock-in', { state: { prefill: [...selected.values()].map((p) => ({ product: p, quantity: suggested(p) })) } });

  return (
    <div>
      <PageHeader
        title={t('Low Stock')}
        subtitle={t('Products at or below their minimum stock level')}
        actions={
          <>
            {can('export.run') && (
              <Button icon={<Download className="size-4" />} onClick={() => download('/export/low-stock').catch((e) => toast.error(errMsg(e)))}>
                {t('Export')}
              </Button>
            )}
            {can('stock.in') && (
              <Button variant="primary" icon={<ArrowDownToLine className="size-4" />} disabled={selected.size === 0} onClick={receive}>
                {t('Receive selected ({n})', { n: selected.size })}
              </Button>
            )}
          </>
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-2">
        <Card className="flex items-center gap-3 p-4">
          <div className="flex size-10 items-center justify-center rounded-lg bg-bad-soft text-bad"><PackageX className="size-5" /></div>
          <div>
            <div className="text-[11px] font-semibold tracking-wide text-muted uppercase">{t('Out of stock')}</div>
            <div className="tabular text-2xl font-semibold">{fmtNumber(counts.data?.out ?? 0)}</div>
          </div>
        </Card>
        <Card className="flex items-center gap-3 p-4">
          <div className="flex size-10 items-center justify-center rounded-lg bg-warn-soft text-warn"><AlertTriangle className="size-5" /></div>
          <div>
            <div className="text-[11px] font-semibold tracking-wide text-muted uppercase">{t('Low stock')}</div>
            <div className="tabular text-2xl font-semibold">{fmtNumber(counts.data?.low ?? 0)}</div>
          </div>
        </Card>
      </div>

      <Tabs<Tab>
        value={tab}
        onChange={(v) => (setParams({ tab: v }, { replace: true }), setPage(1))}
        tabs={[
          { value: 'alert', label: t('All alerts'), count: (counts.data?.out ?? 0) + (counts.data?.low ?? 0) },
          { value: 'out', label: t('Out of stock'), count: counts.data?.out },
          { value: 'low', label: t('Low stock'), count: counts.data?.low },
        ]}
      />

      <Card>
        <div className="flex flex-wrap gap-2 border-b border-line p-3">
          <Select className="w-auto" value={supplierId} onChange={(e) => (setSupplierId(e.target.value), setPage(1))}>
            <option value="">{t('All suppliers')}</option>
            {suppliers.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </div>
        {isLoading ? (
          <LoadingBlock />
        ) : !data?.data.length ? (
          <EmptyState icon={<CheckCircle2 className="size-5" />} title={t('Nothing to reorder')} description={t('All products are above minimum stock')} />
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  <Th className="w-8">
                    <input
                      type="checkbox"
                      aria-label={t('Select all')}
                      checked={allSelected}
                      onChange={() =>
                        setSelected((s) => {
                          const n = new Map(s);
                          for (const p of allOnPage) allSelected ? n.delete(p.id) : n.set(p.id, p);
                          return n;
                        })
                      }
                      className="size-4 accent-[var(--brand)]"
                    />
                  </Th>
                  <Th>{t('Product')}</Th>
                  <Th className="hidden md:table-cell">{t('Supplier')}</Th>
                  <Th className="hidden sm:table-cell">{t('Location')}</Th>
                  <Th align="right">{t('Stock')}</Th>
                  <Th align="right">{t('Min')}</Th>
                  <Th align="right">{t('Shortage')}</Th>
                  <Th align="right" className="hidden lg:table-cell">{t('Suggested order')}</Th>
                  <Th>{t('Status')}</Th>
                </tr>
              </thead>
              <tbody>
                {data.data.map((p) => (
                  <tr key={p.id} className="hover:bg-surface-2">
                    <Td>
                      <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggle(p)} className="size-4 accent-[var(--brand)]" aria-label={p.sku} />
                    </Td>
                    <Td>
                      <Link to={`/products/${p.id}`} className="flex items-center gap-2.5">
                        <ProductThumb url={p.imageUrl} name={p.name} size="sm" />
                        <span>
                          <span className="block max-w-[260px] truncate font-medium hover:underline">{p.name}</span>
                          <span className="font-mono text-xs text-muted">{p.sku}</span>
                        </span>
                      </Link>
                    </Td>
                    <Td className="hidden max-w-[180px] truncate text-fg-2 md:table-cell">{p.supplierName ?? '—'}</Td>
                    <Td className="hidden font-mono text-xs sm:table-cell">{p.locationCode ?? '—'}</Td>
                    <Td align="right" className={`tabular font-semibold ${p.quantity <= 0 ? 'text-bad' : 'text-warn'}`}>{fmtQty(p.quantity)}</Td>
                    <Td align="right" className="tabular text-fg-2">{fmtQty(p.minStock)}</Td>
                    <Td align="right" className="tabular">{fmtQty(Math.max(p.minStock - p.quantity, 0))}</Td>
                    <Td align="right" className="tabular hidden lg:table-cell">{fmtQty(suggested(p), p.unit)}</Td>
                    <Td><StockBadge status={p.stockStatus} /></Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Pagination page={page} pageSize={50} total={data.total} onPage={setPage} />
          </>
        )}
      </Card>
    </div>
  );
}
