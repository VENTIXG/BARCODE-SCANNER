import { useMemo } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Download, FileSpreadsheet, Filter, Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { api, download, type Page } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtMoney, fmtNumber, fmtQty } from '../lib/format';
import { useT } from '../lib/i18n';
import { errMsg, useCategories, useLocations, useSuppliers } from '../lib/queries';
import type { Product } from '../lib/types';
import { Button, Card, EmptyState, Input, LoadingBlock, PageHeader, Pagination, ProductThumb, Select, StatusBadge, StockBadge, Table, Td, Th } from '../components/ui';

export default function Products() {
  const t = useT();
  const { can } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const categories = useCategories();
  const suppliers = useSuppliers();
  const locations = useLocations();

  const filters = useMemo(
    () => ({
      q: params.get('q') ?? '',
      categoryId: params.get('categoryId') ?? '',
      supplierId: params.get('supplierId') ?? '',
      zone: params.get('zone') ?? '',
      locationId: params.get('locationId') ?? '',
      status: params.get('status') ?? '',
      stock: params.get('stock') ?? '',
      sort: params.get('sort') ?? '',
      dir: (params.get('dir') as 'asc' | 'desc') ?? 'asc',
      page: Number(params.get('page') ?? 1),
      pageSize: Number(params.get('pageSize') ?? 50),
    }),
    [params],
  );

  const set = (patch: Record<string, string | number>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === '' || v == null) next.delete(k);
      else next.set(k, String(v));
    }
    if (!('page' in patch)) next.delete('page');
    setParams(next, { replace: true });
  };
  const onSort = (s: string) => set({ sort: s, dir: filters.sort === s && filters.dir === 'asc' ? 'desc' : 'asc' });

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['products', filters],
    queryFn: () => api.get<Page<Product>>('/products', filters),
    placeholderData: keepPreviousData,
  });

  const zones = useMemo(() => [...new Set((locations.data ?? []).map((l) => l.zone).filter(Boolean))].sort() as string[], [locations.data]);
  const activeFilters = ['categoryId', 'supplierId', 'zone', 'locationId', 'status', 'stock'].filter((k) => params.get(k));

  const exportXlsx = () =>
    download('/export/products', { ...filters, page: undefined, pageSize: undefined }).catch((e) => toast.error(errMsg(e)));

  return (
    <div>
      <PageHeader
        title={t('Products')}
        subtitle={data ? t('{n} products', { n: fmtNumber(data.total) }) : undefined}
        actions={
          <>
            {can('export.run') && (
              <Button icon={<Download className="size-4" />} onClick={exportXlsx}>
                {t('Export')}
              </Button>
            )}
            {can('import.run') && (
              <Button icon={<FileSpreadsheet className="size-4" />} onClick={() => navigate('/import-export')}>
                {t('Import')}
              </Button>
            )}
            {can('products.manage') && (
              <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => navigate('/products/new')}>
                {t('New product')}
              </Button>
            )}
          </>
        }
      />

      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
          <Input
            className="w-full sm:w-72"
            placeholder={t('Search barcode, SKU, name…')}
            defaultValue={filters.q}
            key={filters.q}
            onKeyDown={(e) => e.key === 'Enter' && set({ q: (e.target as HTMLInputElement).value.trim() })}
            onBlur={(e) => e.target.value.trim() !== filters.q && set({ q: e.target.value.trim() })}
          />
          <Filter className="hidden size-4 text-muted sm:block" />
          <Select className="w-auto" value={filters.categoryId} onChange={(e) => set({ categoryId: e.target.value })}>
            <option value="">{t('All categories')}</option>
            {categories.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          <Select className="w-auto" value={filters.supplierId} onChange={(e) => set({ supplierId: e.target.value })}>
            <option value="">{t('All suppliers')}</option>
            {suppliers.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
          <Select className="w-auto" value={filters.zone} onChange={(e) => set({ zone: e.target.value, locationId: '' })}>
            <option value="">{t('All zones')}</option>
            {zones.map((z) => <option key={z} value={z}>{t('Zone')} {z}</option>)}
          </Select>
          <Select className="w-auto" value={filters.locationId} onChange={(e) => set({ locationId: e.target.value })}>
            <option value="">{t('All locations')}</option>
            {locations.data?.filter((l) => !filters.zone || l.zone === filters.zone).map((l) => <option key={l.id} value={l.id}>{l.code}</option>)}
          </Select>
          <Select className="w-auto" value={filters.stock} onChange={(e) => set({ stock: e.target.value })}>
            <option value="">{t('Any stock level')}</option>
            <option value="in">{t('In stock')}</option>
            <option value="low">{t('Low stock')}</option>
            <option value="out">{t('Out of stock')}</option>
          </Select>
          <Select className="w-auto" value={filters.status} onChange={(e) => set({ status: e.target.value })}>
            <option value="">{t('Any status')}</option>
            <option value="ACTIVE">{t('Active')}</option>
            <option value="INACTIVE">{t('Inactive')}</option>
          </Select>
          {(activeFilters.length > 0 || filters.q) && (
            <Button variant="ghost" size="sm" icon={<X className="size-3.5" />} onClick={() => setParams({}, { replace: true })}>
              {t('Clear')}
            </Button>
          )}
        </div>

        {isLoading ? (
          <LoadingBlock />
        ) : !data?.data.length ? (
          <EmptyState
            title={t('No products found')}
            description={filters.q || activeFilters.length ? t('Try changing the search or filters.') : t('Add your first product or import them from Excel.')}
            action={can('products.manage') && <Button variant="primary" onClick={() => navigate('/products/new')}>{t('New product')}</Button>}
          />
        ) : (
          <div className={isFetching ? 'opacity-70 transition-opacity' : ''}>
            <Table>
              <thead>
                <tr>
                  <Th sort="name" current={filters.sort} dir={filters.dir} onSort={onSort}>{t('Product')}</Th>
                  <Th sort="sku" current={filters.sort} dir={filters.dir} onSort={onSort}>SKU</Th>
                  <Th sort="barcode" current={filters.sort} dir={filters.dir} onSort={onSort} className="hidden md:table-cell">{t('Barcode')}</Th>
                  <Th sort="category" current={filters.sort} dir={filters.dir} onSort={onSort} className="hidden lg:table-cell">{t('Category')}</Th>
                  <Th sort="supplier" current={filters.sort} dir={filters.dir} onSort={onSort} className="hidden 2xl:table-cell">{t('Supplier')}</Th>
                  <Th sort="location" current={filters.sort} dir={filters.dir} onSort={onSort}>{t('Location')}</Th>
                  <Th sort="quantity" current={filters.sort} dir={filters.dir} onSort={onSort} align="right">{t('Stock')}</Th>
                  <Th sort="minStock" current={filters.sort} dir={filters.dir} onSort={onSort} align="right" className="hidden md:table-cell">{t('Min')}</Th>
                  <Th sort="sellingPrice" current={filters.sort} dir={filters.dir} onSort={onSort} align="right" className="hidden lg:table-cell">{t('Price')}</Th>
                  <Th className="hidden md:table-cell">{t('Status')}</Th>
                </tr>
              </thead>
              <tbody>
                {data.data.map((p) => (
                  <tr key={p.id} className="cursor-pointer hover:bg-surface-2" onClick={() => navigate(`/products/${p.id}`)}>
                    <Td>
                      <div className="flex items-center gap-2.5">
                        <ProductThumb url={p.imageUrl} name={p.name} size="sm" />
                        <Link to={`/products/${p.id}`} onClick={(e) => e.stopPropagation()} className="max-w-[260px] truncate font-medium text-fg hover:underline">
                          {p.name}
                        </Link>
                      </div>
                    </Td>
                    <Td className="font-mono text-xs whitespace-nowrap">{p.sku}</Td>
                    <Td className="hidden font-mono text-xs whitespace-nowrap text-fg-2 md:table-cell">{p.barcode ?? '—'}</Td>
                    <Td className="hidden whitespace-nowrap text-fg-2 lg:table-cell">{p.categoryName ?? '—'}</Td>
                    <Td className="hidden max-w-[180px] truncate text-fg-2 2xl:table-cell">{p.supplierName ?? '—'}</Td>
                    <Td className="font-mono text-xs whitespace-nowrap">{p.locationCode ?? '—'}</Td>
                    <Td align="right">
                      <div className="flex flex-col items-end gap-0.5">
                        <span className="tabular font-semibold whitespace-nowrap">{fmtQty(p.quantity, p.unit === 'pcs' ? undefined : p.unit)}</span>
                        {p.stockStatus !== 'IN_STOCK' && <StockBadge status={p.stockStatus} />}
                      </div>
                    </Td>
                    <Td align="right" className="tabular hidden text-fg-2 md:table-cell">{fmtQty(p.minStock)}</Td>
                    <Td align="right" className="tabular hidden whitespace-nowrap lg:table-cell">{fmtMoney(p.sellingPrice)}</Td>
                    <Td className="hidden md:table-cell"><StatusBadge status={p.status} /></Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <div className="flex flex-wrap items-center justify-between border-t border-line">
              <Pagination page={filters.page} pageSize={filters.pageSize} total={data.total} onPage={(page) => set({ page })} />
              <div className="flex items-center gap-2 px-4 text-xs whitespace-nowrap text-muted">
                {t('Rows per page')}
                <Select className="h-8 w-20" value={filters.pageSize} onChange={(e) => set({ pageSize: e.target.value })}>
                  {[25, 50, 100, 200].map((n) => <option key={n} value={n}>{n}</option>)}
                </Select>
              </div>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
