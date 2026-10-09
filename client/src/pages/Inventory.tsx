import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ClipboardCheck, Download, MapPin, Pencil, Plus, SlidersHorizontal, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api, download, newIdempotencyKey, type Page } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtMoney, fmtNumber, fmtQty, fmtSigned } from '../lib/format';
import { useT } from '../lib/i18n';
import { beep } from '../lib/scanner';
import { errMsg, useLocations } from '../lib/queries';
import type { Location, Product } from '../lib/types';
import { AdjustStockModal } from '../components/AdjustStockModal';
import { ProductChooser } from '../components/ProductChooser';
import { ProductPicker, type ProductPickerHandle } from '../components/ProductPicker';
import { useScanHandler } from '../components/ScanContext';
import {
  Button,
  Card,
  CardHeader,
  Checkbox,
  ConfirmDialog,
  EmptyState,
  ErrorBox,
  Field,
  IconButton,
  Input,
  LoadingBlock,
  Modal,
  PageHeader,
  Pagination,
  ProductThumb,
  Select,
  StockBadge,
  Table,
  Tabs,
  Td,
  Th,
} from '../components/ui';

export default function Inventory() {
  const t = useT();
  const [params, setParams] = useSearchParams();
  const { can } = useAuth();
  const tab = (params.get('tab') as 'stock' | 'count' | 'locations') ?? 'stock';
  return (
    <div>
      <PageHeader
        title={t('Inventory')}
        subtitle={t('Stock per product and warehouse location')}
        actions={
          can('export.run') && (
            <Button icon={<Download className="size-4" />} onClick={() => download('/export/inventory').catch((e) => toast.error(errMsg(e)))}>
              {t('Export inventory')}
            </Button>
          )
        }
      />
      <Tabs
        value={tab}
        onChange={(v) => setParams({ tab: v }, { replace: true })}
        tabs={[
          { value: 'stock', label: t('Current stock') },
          ...(can('stock.adjust') ? [{ value: 'count' as const, label: t('Stock count') }] : []),
          { value: 'locations', label: t('Locations') },
        ]}
      />
      {tab === 'stock' && <StockTab />}
      {tab === 'count' && can('stock.adjust') && <CountTab />}
      {tab === 'locations' && <LocationsTab />}
    </div>
  );
}

function StockTab() {
  const t = useT();
  const { can } = useAuth();
  const navigate = useNavigate();
  const locations = useLocations();
  const [q, setQ] = useState('');
  const [zone, setZone] = useState('');
  const [locationId, setLocationId] = useState('');
  const [stock, setStock] = useState('');
  const [sort, setSort] = useState('location');
  const [dir, setDir] = useState<'asc' | 'desc'>('asc');
  const [page, setPage] = useState(1);
  const [adjust, setAdjust] = useState<Product | null>(null);
  const filters = { q, zone, locationId, stock, sort, dir, page, pageSize: 50, status: 'ACTIVE' };
  const { data, isLoading } = useQuery({
    queryKey: ['products', 'inventory', filters],
    queryFn: () => api.get<Page<Product>>('/products', filters),
    placeholderData: keepPreviousData,
  });
  const zones = useMemo(() => [...new Set((locations.data ?? []).map((l) => l.zone).filter(Boolean))].sort() as string[], [locations.data]);
  const onSort = (s: string) => (setDir(sort === s && dir === 'asc' ? 'desc' : 'asc'), setSort(s));

  return (
    <Card>
      <div className="flex flex-wrap gap-2 border-b border-line p-3">
        <Input className="w-full sm:w-64" placeholder={t('Search barcode, SKU, name…')} value={q} onChange={(e) => (setQ(e.target.value), setPage(1))} />
        <Select className="w-auto" value={zone} onChange={(e) => (setZone(e.target.value), setLocationId(''), setPage(1))}>
          <option value="">{t('All zones')}</option>
          {zones.map((z) => <option key={z} value={z}>{t('Zone')} {z}</option>)}
        </Select>
        <Select className="w-auto" value={locationId} onChange={(e) => (setLocationId(e.target.value), setPage(1))}>
          <option value="">{t('All locations')}</option>
          {locations.data?.filter((l) => !zone || l.zone === zone).map((l) => <option key={l.id} value={l.id}>{l.code}</option>)}
        </Select>
        <Select className="w-auto" value={stock} onChange={(e) => (setStock(e.target.value), setPage(1))}>
          <option value="">{t('Any stock level')}</option>
          <option value="in">{t('In stock')}</option>
          <option value="low">{t('Low stock')}</option>
          <option value="out">{t('Out of stock')}</option>
        </Select>
      </div>
      {isLoading ? (
        <LoadingBlock />
      ) : !data?.data.length ? (
        <EmptyState title={t('No products found')} />
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <Th sort="location" current={sort} dir={dir} onSort={onSort}>{t('Location')}</Th>
                <Th sort="name" current={sort} dir={dir} onSort={onSort}>{t('Product')}</Th>
                <Th sort="quantity" current={sort} dir={dir} onSort={onSort} align="right">{t('Quantity')}</Th>
                <Th sort="minStock" current={sort} dir={dir} onSort={onSort} align="right" className="hidden sm:table-cell">{t('Min')}</Th>
                <Th>{t('Status')}</Th>
                <Th sort="value" current={sort} dir={dir} onSort={onSort} align="right" className="hidden md:table-cell">{t('Value')}</Th>
                {can('stock.adjust') && <Th />}
              </tr>
            </thead>
            <tbody>
              {data.data.map((p) => (
                <tr key={p.id} className="hover:bg-surface-2">
                  <Td className="font-mono text-xs font-medium">{p.locationCode ?? '—'}</Td>
                  <Td>
                    <button className="flex items-center gap-2.5 text-left" onClick={() => navigate(`/products/${p.id}`)}>
                      <ProductThumb url={p.imageUrl} name={p.name} size="sm" />
                      <span>
                        <span className="block max-w-[280px] truncate font-medium hover:underline">{p.name}</span>
                        <span className="font-mono text-xs text-muted">{p.sku}</span>
                      </span>
                    </button>
                  </Td>
                  <Td align="right" className="tabular font-semibold whitespace-nowrap">{fmtQty(p.quantity, p.unit)}</Td>
                  <Td align="right" className="tabular hidden text-fg-2 sm:table-cell">{fmtQty(p.minStock)}</Td>
                  <Td><StockBadge status={p.stockStatus} /></Td>
                  <Td align="right" className="tabular hidden md:table-cell">{fmtMoney(Math.max(0, p.quantity) * p.purchasePrice)}</Td>
                  {can('stock.adjust') && (
                    <Td align="right">
                      <IconButton label={t('Adjust stock')} onClick={() => setAdjust(p)}>
                        <SlidersHorizontal className="size-4" />
                      </IconButton>
                    </Td>
                  )}
                </tr>
              ))}
            </tbody>
          </Table>
          <Pagination page={page} pageSize={50} total={data.total} onPage={setPage} />
        </>
      )}
      {adjust && <AdjustStockModal product={adjust} open onClose={() => setAdjust(null)} />}
    </Card>
  );
}

interface CountLine {
  product: Product;
  counted: string;
}

/** Physical stock take: scan products, enter counted quantities, post adjustments in one go. */
function CountTab() {
  const t = useT();
  const qc = useQueryClient();
  const [idemKey, setIdemKey] = useState(newIdempotencyKey);
  const picker = useRef<ProductPickerHandle>(null);
  const inputs = useRef<Record<number, HTMLInputElement | null>>({});
  const [lines, setLines] = useState<CountLine[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('ims-count-draft') ?? '[]');
    } catch {
      return [];
    }
  });
  const [reason, setReason] = useState('Physical inventory count');
  const [reference, setReference] = useState('');
  const [increment, setIncrement] = useState(false);
  const [chooser, setChooser] = useState<{ code: string; products: Product[] } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem('ims-count-draft', JSON.stringify(lines));
    } catch {
      /* ignore */
    }
  }, [lines]);

  const add = (p: Product) => {
    beep('ok');
    setNotice(null);
    setLines((ls) => {
      const existing = ls.find((l) => l.product.id === p.id);
      if (existing) {
        if (increment) return ls.map((l) => (l.product.id === p.id ? { ...l, counted: String((Number(l.counted) || 0) + 1) } : l));
        return ls;
      }
      return [{ product: p, counted: increment ? '1' : '' }, ...ls];
    });
    // Without increment mode, jump to the counted-quantity field.
    setTimeout(() => (increment ? picker.current?.focus() : inputs.current[p.id]?.focus()), 40);
  };

  const onCode = async (code: string) => {
    const res = await api.get<{ data: Product[] }>('/products/lookup', { code }).catch(() => ({ data: [] as Product[] }));
    if (res.data.length === 1) add(res.data[0]);
    else if (res.data.length > 1) setChooser({ code, products: res.data });
    else (beep('error'), setNotice(t('No product found for barcode {code}', { code })));
  };
  useScanHandler((c) => void onCode(c));

  const counted = lines.filter((l) => l.counted.trim() !== '' && !Number.isNaN(Number(l.counted.replace(',', '.'))));
  const diffs = counted.filter((l) => Number(l.counted.replace(',', '.')) !== l.product.quantity);

  const submit = useMutation({
    mutationFn: () =>
      api.post<{ data: { adjusted: number; unchanged: number; netChange: number } }>(
        '/stock/count',
        {
          reason: t(reason),
          reference: reference || null,
          idempotencyKey: idemKey,
          items: counted.map((l) => ({ productId: l.product.id, countedQuantity: Number(l.counted.replace(',', '.')) })),
        },
        { retries: 2 },
      ),
    onSuccess: (r) => {
      toast.success(t('Stock count saved: {a} adjusted, {u} unchanged', { a: r.data.adjusted, u: r.data.unchanged }));
      setIdemKey(newIdempotencyKey());
      setLines([]);
      setConfirm(false);
      void qc.invalidateQueries();
    },
    onError: (e) => (setConfirm(false), toast.error(errMsg(e))),
  });

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
      <Card>
        <div className="space-y-2 border-b border-line p-4">
          <ProductPicker ref={picker} autoFocus onCode={(c) => void onCode(c)} onSelect={add} placeholder={t('Scan a product to count it…')} />
          <Checkbox checked={increment} onChange={setIncrement} label={t('Count by scanning')} description={t('Each scan adds 1 to the counted quantity (scan every item).')} />
          {notice && <ErrorBox error={notice} />}
        </div>
        {lines.length === 0 ? (
          <EmptyState icon={<ClipboardCheck className="size-5" />} title={t('Start counting')} description={t('Scan each product and type the quantity you physically count. Differences are posted as adjustments.')} />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>{t('Product')}</Th>
                <Th className="hidden sm:table-cell">{t('Location')}</Th>
                <Th align="right">{t('System')}</Th>
                <Th align="center">{t('Counted')}</Th>
                <Th align="right">{t('Difference')}</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => {
                const c = l.counted.trim() === '' ? null : Number(l.counted.replace(',', '.'));
                const d = c == null || Number.isNaN(c) ? null : c - l.product.quantity;
                return (
                  <tr key={l.product.id}>
                    <Td>
                      <div className="max-w-[260px] truncate font-medium">{l.product.name}</div>
                      <div className="font-mono text-xs text-muted">{l.product.sku}</div>
                    </Td>
                    <Td className="hidden font-mono text-xs sm:table-cell">{l.product.locationCode ?? '—'}</Td>
                    <Td align="right" className="tabular">{fmtQty(l.product.quantity)}</Td>
                    <Td align="center">
                      <input
                        ref={(el) => {
                          inputs.current[l.product.id] = el;
                        }}
                        inputMode="decimal"
                        value={l.counted}
                        onChange={(e) => setLines((ls) => ls.map((x) => (x.product.id === l.product.id ? { ...x, counted: e.target.value } : x)))}
                        onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), picker.current?.focus())}
                        className="tabular h-9 w-24 rounded-lg border border-line-strong bg-surface text-center font-semibold focus:border-brand focus:outline-none"
                      />
                    </Td>
                    <Td align="right" className={clsx('tabular font-semibold', d == null ? 'text-muted' : d > 0 ? 'text-ok' : d < 0 ? 'text-bad' : 'text-fg-2')}>
                      {d == null ? '—' : d === 0 ? '0' : fmtSigned(d)}
                    </Td>
                    <Td align="right">
                      <IconButton label={t('Remove line')} onClick={() => setLines((ls) => ls.filter((x) => x.product.id !== l.product.id))}>
                        <Trash2 className="size-4" />
                      </IconButton>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>
      <Card className="self-start">
        <CardHeader title={t('Count summary')} />
        <div className="space-y-3 p-4 text-sm">
          <div className="flex justify-between"><span className="text-muted">{t('Products scanned')}</span><b className="tabular">{lines.length}</b></div>
          <div className="flex justify-between"><span className="text-muted">{t('Counted')}</span><b className="tabular">{counted.length}</b></div>
          <div className="flex justify-between"><span className="text-muted">{t('With differences')}</span><b className="tabular text-warn">{diffs.length}</b></div>
          <Field label={t('Reason')}>
            <Select value={reason} onChange={(e) => setReason(e.target.value)}>
              <option value="Physical inventory count">{t('Physical inventory count')}</option>
              <option value="Cycle count correction">{t('Cycle count correction')}</option>
            </Select>
          </Field>
          <Field label={t('Reference')} hint={t('Optional, e.g. count sheet or RMA number')}>
            <Input value={reference} onChange={(e) => setReference(e.target.value)} />
          </Field>
          <Button variant="primary" className="w-full" disabled={counted.length === 0} onClick={() => setConfirm(true)}>
            {t('Post stock count')}
          </Button>
          {lines.length > 0 && <Button variant="ghost" className="w-full" onClick={() => setLines([])}>{t('Clear')}</Button>}
        </div>
      </Card>
      <ProductChooser code={chooser?.code ?? ''} products={chooser?.products ?? null} onPick={(p) => (setChooser(null), add(p))} onClose={() => setChooser(null)} />
      <ConfirmDialog
        open={confirm}
        title={t('Post stock count?')}
        message={t('{n} products with differences will be adjusted to the counted quantity. Every adjustment is recorded in the transaction history.', { n: diffs.length })}
        loading={submit.isPending}
        onConfirm={() => submit.mutate()}
        onClose={() => setConfirm(false)}
      />
    </div>
  );
}

function LocationsTab() {
  const t = useT();
  const { can } = useAuth();
  const qc = useQueryClient();
  const locations = useLocations();
  const [edit, setEdit] = useState<Partial<Location> | null>(null);
  const [del, setDel] = useState<Location | null>(null);
  const [q, setQ] = useState('');

  const save = useMutation({
    mutationFn: (l: Partial<Location>) => {
      const body = { code: l.code ?? '', description: l.description ?? null, isActive: l.is_active !== 0 };
      return l.id ? api.put(`/locations/${l.id}`, body) : api.post('/locations', body);
    },
    onSuccess: () => (toast.success(t('Location saved')), setEdit(null), void qc.invalidateQueries({ queryKey: ['locations'] })),
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.del(`/locations/${id}`),
    onSuccess: () => (toast.success(t('Location deleted')), setDel(null), void qc.invalidateQueries({ queryKey: ['locations'] })),
    onError: (e) => (toast.error(errMsg(e)), setDel(null)),
  });

  const rows = (locations.data ?? []).filter((l) => !q || l.code.toLowerCase().includes(q.toLowerCase()) || (l.description ?? '').toLowerCase().includes(q.toLowerCase()));
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
        <Input className="w-full sm:w-64" placeholder={t('Search locations…')} value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="text-xs text-muted">{t('Format: Zone-Rack-Shelf (e.g. A-01-03)')}</span>
        {can('catalog.manage') && (
          <Button className="ml-auto" variant="primary" icon={<Plus className="size-4" />} onClick={() => setEdit({ code: '', is_active: 1 })}>
            {t('New location')}
          </Button>
        )}
      </div>
      {locations.isLoading ? (
        <LoadingBlock />
      ) : rows.length === 0 ? (
        <EmptyState icon={<MapPin className="size-5" />} title={t('No locations yet')} description={t('Locations are also created automatically when you assign one to a product.')} />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>{t('Code')}</Th>
              <Th>{t('Zone')}</Th>
              <Th>{t('Rack')}</Th>
              <Th>{t('Shelf/Bin')}</Th>
              <Th className="hidden md:table-cell">{t('Description')}</Th>
              <Th align="right">{t('Products')}</Th>
              <Th align="right">{t('Units')}</Th>
              {can('catalog.manage') && <Th />}
            </tr>
          </thead>
          <tbody>
            {rows.map((l) => (
              <tr key={l.id} className="hover:bg-surface-2">
                <Td className="font-mono font-semibold">
                  <Link to={`/products?locationId=${l.id}`} className="hover:underline">{l.code}</Link>
                </Td>
                <Td>{l.zone ?? '—'}</Td>
                <Td>{l.rack ?? '—'}</Td>
                <Td>{l.shelf ?? '—'}</Td>
                <Td className="hidden text-fg-2 md:table-cell">{l.description ?? ''}</Td>
                <Td align="right" className="tabular">{fmtNumber(l.product_count)}</Td>
                <Td align="right" className="tabular">{fmtQty(l.total_quantity)}</Td>
                {can('catalog.manage') && (
                  <Td align="right" className="whitespace-nowrap">
                    <IconButton label={t('Edit')} onClick={() => setEdit(l)}><Pencil className="size-4" /></IconButton>
                    <IconButton label={t('Delete')} onClick={() => setDel(l)}><Trash2 className="size-4" /></IconButton>
                  </Td>
                )}
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <Modal
        open={Boolean(edit)}
        onClose={() => setEdit(null)}
        size="sm"
        title={edit?.id ? t('Edit location') : t('New location')}
        footer={
          <>
            <Button onClick={() => setEdit(null)}>{t('Cancel')}</Button>
            <Button variant="primary" disabled={!edit?.code?.trim()} loading={save.isPending} onClick={() => edit && save.mutate(edit)}>{t('Save')}</Button>
          </>
        }
      >
        <form className="space-y-3" onSubmit={(e) => (e.preventDefault(), edit?.code?.trim() && save.mutate(edit))}>
          <Field label={t('Code')} required hint={t('Format: Zone-Rack-Shelf (e.g. A-01-03)')}>
            <Input className="font-mono uppercase" value={edit?.code ?? ''} onChange={(e) => setEdit((s) => ({ ...s, code: e.target.value }))} />
          </Field>
          <Field label={t('Description')}>
            <Input value={edit?.description ?? ''} onChange={(e) => setEdit((s) => ({ ...s, description: e.target.value }))} />
          </Field>
          <ErrorBox error={save.error ? errMsg(save.error) : null} />
          <button type="submit" hidden />
        </form>
      </Modal>
      <ConfirmDialog
        open={Boolean(del)}
        title={t('Delete location {code}?', { code: del?.code })}
        confirmLabel={t('Delete')}
        tone="danger"
        loading={remove.isPending}
        onConfirm={() => del && remove.mutate(del.id)}
        onClose={() => setDel(null)}
      />
    </Card>
  );
}
