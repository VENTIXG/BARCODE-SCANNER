/**
 * Stock In (goods receipt) and Stock Out (dispatch) screens.
 * One editor for both: scan / search products into lines, then confirm to
 * post all stock movements in a single transaction.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { AlertTriangle, ArrowDownToLine, ArrowUpFromLine, CheckCircle2, Download, Minus, Plus, Printer, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError, api, download, newIdempotencyKey, type Page } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDate, fmtMoney, fmtQty, todayLocal } from '../lib/format';
import { useT } from '../lib/i18n';
import { beep } from '../lib/scanner';
import { errMsg, useSuppliers } from '../lib/queries';
import type { Product, StockDocument } from '../lib/types';
import { ProductChooser } from '../components/ProductChooser';
import { ProductPicker, type ProductPickerHandle } from '../components/ProductPicker';
import { useScanHandler } from '../components/ScanContext';
import {
  Badge,
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

type Kind = 'receipt' | 'dispatch';

interface Line {
  key: string;
  product: Product;
  quantity: string;
  unitPrice: string;
}

interface Draft {
  date: string;
  supplierId: string;
  invoiceNumber: string;
  customerName: string;
  reference: string;
  notes: string;
  updatePrices: boolean;
  lines: Line[];
}

const emptyDraft = (): Draft => ({
  date: todayLocal(),
  supplierId: '',
  invoiceNumber: '',
  customerName: '',
  reference: '',
  notes: '',
  updatePrices: false,
  lines: [],
});

const parseQty = (s: string) => Number(String(s).replace(',', '.'));

export default function StockDocumentPage({ kind }: { kind: Kind }) {
  const t = useT();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'history' ? 'history' : 'new';
  const isIn = kind === 'receipt';
  return (
    <div>
      <PageHeader
        title={isIn ? t('Stock In — Goods receipt') : t('Stock Out — Dispatch')}
        subtitle={isIn ? t('Receive products into the warehouse') : t('Ship products out of the warehouse')}
      />
      <Tabs
        value={tab}
        onChange={(v) => setParams(v === 'history' ? { tab: 'history' } : {}, { replace: true })}
        tabs={[
          { value: 'new', label: isIn ? t('New receipt') : t('New dispatch') },
          { value: 'history', label: isIn ? t('Receipt history') : t('Dispatch history') },
        ]}
      />
      {tab === 'new' ? <Editor kind={kind} /> : <History kind={kind} />}
    </div>
  );
}

function Editor({ kind }: { kind: Kind }) {
  const t = useT();
  const isIn = kind === 'receipt';
  const { user, settings } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const suppliers = useSuppliers();
  const picker = useRef<ProductPickerHandle>(null);
  const storageKey = `ims-draft-${kind}`;

  const [draft, setDraft] = useState<Draft>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      return raw ? { ...emptyDraft(), ...JSON.parse(raw) } : emptyDraft();
    } catch {
      return emptyDraft();
    }
  });
  const [scanQty, setScanQty] = useState('1');
  const [chooser, setChooser] = useState<{ code: string; products: Product[] } | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [done, setDone] = useState<StockDocument | null>(null);
  const [lastKey, setLastKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(draft));
    } catch {
      /* ignore */
    }
  }, [draft, storageKey]);

  const nextNumber = useQuery({
    queryKey: ['next-number', kind],
    queryFn: () => api.get<{ data: string }>(`/${isIn ? 'receipts' : 'dispatches'}/next-number`).then((r) => r.data),
  });

  const addProduct = (p: Product, qty = parseQty(scanQty) || 1) => {
    if (p.status === 'INACTIVE' && isIn) {
      beep('error');
      setNotice(t('Product {sku} is inactive and cannot be received.', { sku: p.sku }));
      return;
    }
    setNotice(null);
    beep('ok');
    setDraft((d) => {
      const existing = d.lines.find((l) => l.product.id === p.id);
      if (existing) {
        setLastKey(existing.key);
        return {
          ...d,
          lines: d.lines.map((l) => (l.key === existing.key ? { ...l, product: p, quantity: String(Math.round((parseQty(l.quantity) + qty) * 1000) / 1000) } : l)),
        };
      }
      const key = `${p.id}-${Date.now()}`;
      setLastKey(key);
      return {
        ...d,
        lines: [...d.lines, { key, product: p, quantity: String(qty), unitPrice: String(isIn ? p.purchasePrice : p.sellingPrice) }],
      };
    });
    picker.current?.focus();
    setTimeout(() => picker.current?.focus(), 20);
  };

  // Prefill from the Low Stock page ("Receive selected")
  useEffect(() => {
    const prefill = (location.state as { prefill?: { product: Product; quantity: number }[] } | null)?.prefill;
    if (prefill?.length) {
      for (const it of prefill) addProduct(it.product, it.quantity);
      navigate(location.pathname, { replace: true, state: null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onCode = async (code: string) => {
    try {
      const res = await api.get<{ data: Product[] }>('/products/lookup', { code });
      if (res.data.length === 1) addProduct(res.data[0]);
      else if (res.data.length > 1) setChooser({ code, products: res.data });
      else {
        beep('error');
        setNotice(t('No product found for barcode {code}', { code }));
      }
    } catch (e) {
      setNotice(errMsg(e));
    }
  };
  useScanHandler((code) => void onCode(code));

  const updateLine = (key: string, patch: Partial<Line>) => setDraft((d) => ({ ...d, lines: d.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) }));
  const removeLine = (key: string) => setDraft((d) => ({ ...d, lines: d.lines.filter((l) => l.key !== key) }));

  const totals = useMemo(() => {
    let qty = 0;
    let value = 0;
    for (const l of draft.lines) {
      const q = parseQty(l.quantity) || 0;
      qty += q;
      value += q * (parseQty(l.unitPrice) || 0);
    }
    return { qty, value };
  }, [draft.lines]);

  const shortages = !isIn ? draft.lines.filter((l) => parseQty(l.quantity) > l.product.quantity) : [];
  const invalidLines = draft.lines.filter((l) => !(parseQty(l.quantity) > 0) || (l.unitPrice !== '' && !(parseQty(l.unitPrice) >= 0)));
  const canConfirm = draft.lines.length > 0 && invalidLines.length === 0 && Boolean(draft.date);

  // Same key until the document is saved: a retry or a second click cannot post it twice.
  const [idemKey, setIdemKey] = useState(newIdempotencyKey);
  const submit = useMutation({
    mutationFn: (force: boolean) =>
      api.post<{ data: StockDocument }>(`/${isIn ? 'receipts' : 'dispatches'}`, {
        idempotencyKey: idemKey,
        date: draft.date,
        notes: draft.notes || null,
        ...(isIn
          ? { supplierId: draft.supplierId ? Number(draft.supplierId) : null, invoiceNumber: draft.invoiceNumber || null, updatePurchasePrices: draft.updatePrices }
          : { customerName: draft.customerName || null, reference: draft.reference || null, force }),
        items: draft.lines.map((l) => ({
          productId: l.product.id,
          quantity: parseQty(l.quantity),
          unitPrice: l.unitPrice === '' ? null : parseQty(l.unitPrice),
        })),
      }, { retries: 2 }),
    onSuccess: (res) => {
      setIdemKey(newIdempotencyKey());
      setConfirm(false);
      setDone(res.data);
      setDraft(emptyDraft());
      beep('ok');
      void qc.invalidateQueries();
    },
    onError: (e) => {
      setConfirm(false);
      beep('error');
      if (e instanceof ApiError && e.code === 'INSUFFICIENT_STOCK') {
        // Refresh the available quantities shown on the lines.
        const items = e.details.items as { productId: number; available: number }[];
        setDraft((d) => ({
          ...d,
          lines: d.lines.map((l) => {
            const it = items.find((i) => i.productId === l.product.id);
            return it ? { ...l, product: { ...l.product, quantity: it.available } } : l;
          }),
        }));
      }
    },
  });

  if (done)
    return (
      <Card className="mx-auto max-w-xl p-8 text-center">
        <CheckCircle2 className="mx-auto size-12 text-ok" />
        <h2 className="mt-3 text-xl font-semibold">{isIn ? t('Receipt confirmed') : t('Dispatch confirmed')}</h2>
        <p className="mt-1 font-mono text-lg">{done.number}</p>
        <p className="mt-2 text-sm text-muted">
          {t('{lines} lines, {qty} units. Stock has been updated.', { lines: done.items?.length ?? 0, qty: fmtQty(done.total_quantity) })}
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <Button icon={<Printer className="size-4" />} onClick={() => navigate(`/${isIn ? 'stock-in' : 'stock-out'}/${done.id}?print=1`)}>
            {t('View / print')}
          </Button>
          <Button variant="primary" autoFocus onClick={() => (setDone(null), void qc.invalidateQueries({ queryKey: ['next-number', kind] }))}>
            {isIn ? t('New receipt') : t('New dispatch')}
          </Button>
        </div>
      </Card>
    );

  const set = (k: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setDraft((d) => ({ ...d, [k]: e.target.value }));
  const insufficient = submit.error instanceof ApiError && submit.error.code === 'INSUFFICIENT_STOCK' ? (submit.error.details.items as { sku: string; name: string; available: number; requested: number }[]) : null;

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader title={isIn ? t('Receipt details') : t('Dispatch details')} />
        <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label={isIn ? t('Receipt number') : t('Dispatch number')} hint={t('Assigned on confirmation')}>
            <Input value={nextNumber.data ?? ''} disabled className="font-mono" />
          </Field>
          <Field label={t('Date')} required>
            <Input type="date" value={draft.date} onChange={set('date')} />
          </Field>
          {isIn ? (
            <>
              <Field label={t('Supplier')}>
                <Select value={draft.supplierId} onChange={set('supplierId')}>
                  <option value="">—</option>
                  {suppliers.data?.filter((s) => s.is_active || String(s.id) === draft.supplierId).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </Select>
              </Field>
              <Field label={t('Invoice / delivery note no.')}>
                <Input value={draft.invoiceNumber} onChange={set('invoiceNumber')} maxLength={100} />
              </Field>
            </>
          ) : (
            <>
              <Field label={t('Customer / recipient')}>
                <Input value={draft.customerName} onChange={set('customerName')} maxLength={200} />
              </Field>
              <Field label={t('Reference')} hint={t('Order, invoice or delivery note number')}>
                <Input value={draft.reference} onChange={set('reference')} maxLength={100} />
              </Field>
            </>
          )}
          <Field label={t('Comments')} className="sm:col-span-2 lg:col-span-3">
            <Input value={draft.notes} onChange={set('notes')} maxLength={2000} />
          </Field>
          <Field label={t('User')}>
            <Input value={user?.fullName ?? ''} disabled />
          </Field>
        </div>
      </Card>

      <Card className={clsx('border-t-4', isIn ? 'border-t-emerald-500' : 'border-t-orange-500')}>
        <div className="border-b border-line p-4">
          <div className="flex flex-col gap-2 sm:flex-row">
            <ProductPicker ref={picker} autoFocus className="flex-1" onCode={(c) => void onCode(c)} onSelect={(p) => addProduct(p)} />
            <label className="flex items-center gap-2 text-xs whitespace-nowrap text-muted">
              {t('Qty per scan')}
              <input
                inputMode="decimal"
                value={scanQty}
                onChange={(e) => setScanQty(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), picker.current?.focus())}
                className="tabular h-14 w-20 rounded-xl border-2 border-line-strong bg-surface text-center text-lg font-semibold text-fg focus:border-brand focus:outline-none"
              />
            </label>
          </div>
          {notice && <div className="mt-2"><ErrorBox error={notice} /></div>}
        </div>

        {draft.lines.length === 0 ? (
          <EmptyState
            icon={isIn ? <ArrowDownToLine className="size-5" /> : <ArrowUpFromLine className="size-5" />}
            title={t('No products added')}
            description={t('Scan barcodes or search products above. Scanning the same product again increases its quantity.')}
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th className="w-8">#</Th>
                <Th>{t('Product')}</Th>
                <Th className="hidden md:table-cell">{t('Location')}</Th>
                <Th align="right">{isIn ? t('In stock') : t('Available')}</Th>
                <Th align="center">{t('Quantity')}</Th>
                <Th align="right" className="hidden sm:table-cell">{isIn ? t('Unit cost') : t('Unit price')}</Th>
                <Th align="right" className="hidden lg:table-cell">{t('Total')}</Th>
                <Th align="right">{isIn ? t('After') : t('Remaining')}</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {draft.lines.map((l, i) => {
                const q = parseQty(l.quantity);
                const after = l.product.quantity + (isIn ? q || 0 : -(q || 0));
                const short = !isIn && q > l.product.quantity;
                return (
                  <tr key={l.key} className={clsx(short && 'bg-bad-soft', l.key === lastKey && !short && 'bg-brand-soft/50')}>
                    <Td className="text-xs text-muted">{i + 1}</Td>
                    <Td>
                      <div className="flex items-center gap-2.5">
                        <ProductThumb url={l.product.imageUrl} name={l.product.name} size="sm" />
                        <div className="min-w-0">
                          <div className="max-w-[260px] truncate font-medium">{l.product.name}</div>
                          <div className="font-mono text-xs text-muted">{l.product.sku}{l.product.barcode ? ` · ${l.product.barcode}` : ''}</div>
                        </div>
                      </div>
                    </Td>
                    <Td className="hidden font-mono text-xs md:table-cell">{l.product.locationCode ?? '—'}</Td>
                    <Td align="right" className="tabular">
                      {fmtQty(l.product.quantity)}
                      {!isIn && l.product.stockStatus !== 'IN_STOCK' && <div><StockBadge status={l.product.stockStatus} /></div>}
                    </Td>
                    <Td align="center">
                      <div className="inline-flex items-center gap-1">
                        <IconButton label={t('Decrease')} onClick={() => updateLine(l.key, { quantity: String(Math.max(0, (q || 0) - 1)) })}>
                          <Minus className="size-3.5" />
                        </IconButton>
                        <input
                          inputMode="decimal"
                          value={l.quantity}
                          onChange={(e) => updateLine(l.key, { quantity: e.target.value })}
                          onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), picker.current?.focus())}
                          className={clsx('tabular h-9 w-20 rounded-lg border bg-surface text-center font-semibold focus:outline-none', short || !(q > 0) ? 'border-bad text-bad' : 'border-line-strong focus:border-brand')}
                        />
                        <IconButton label={t('Increase')} onClick={() => updateLine(l.key, { quantity: String((q || 0) + 1) })}>
                          <Plus className="size-3.5" />
                        </IconButton>
                      </div>
                      {short && <div className="mt-1 text-[11px] font-medium text-bad">{t('Only {n} available', { n: fmtQty(l.product.quantity) })}</div>}
                    </Td>
                    <Td align="right" className="hidden sm:table-cell">
                      <input
                        inputMode="decimal"
                        value={l.unitPrice}
                        onChange={(e) => updateLine(l.key, { unitPrice: e.target.value })}
                        className="tabular h-9 w-24 rounded-lg border border-line-strong bg-surface px-2 text-right focus:border-brand focus:outline-none"
                      />
                    </Td>
                    <Td align="right" className="tabular hidden lg:table-cell">{fmtMoney((q || 0) * (parseQty(l.unitPrice) || 0))}</Td>
                    <Td align="right" className={clsx('tabular font-semibold', after < 0 && 'text-bad')}>{fmtQty(after)}</Td>
                    <Td align="right">
                      <IconButton label={t('Remove line')} onClick={() => removeLine(l.key)}>
                        <Trash2 className="size-4" />
                      </IconButton>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}

        <div className="space-y-3 border-t border-line p-4">
          {shortages.length > 0 && (
            <div className="flex items-start gap-2 rounded-lg border border-bad/30 bg-bad-soft px-3 py-2.5 text-sm text-bad">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span>
                {t('Warning: {n} line(s) request more than the available stock. Stock cannot become negative.', { n: shortages.length })}
              </span>
            </div>
          )}
          {insufficient && (
            <ErrorBox error={`${t('Dispatch rejected — insufficient stock')}: ${insufficient.map((i) => `${i.sku} (${t('available')} ${fmtQty(i.available)}, ${t('requested')} ${fmtQty(i.requested)})`).join('; ')}`} />
          )}
          {submit.error && !insufficient && <ErrorBox error={errMsg(submit.error)} />}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-4 text-sm">
              <span className="text-muted">{t('Lines')}: <b className="tabular text-fg">{draft.lines.length}</b></span>
              <span className="text-muted">{t('Units')}: <b className="tabular text-fg">{fmtQty(totals.qty)}</b></span>
              <span className="text-muted">{t('Value')}: <b className="tabular text-fg">{fmtMoney(totals.value)}</b></span>
              {isIn && <Checkbox checked={draft.updatePrices} onChange={(v) => setDraft((d) => ({ ...d, updatePrices: v }))} label={t('Update purchase prices from this receipt')} />}
            </div>
            <div className="flex gap-2">
              {draft.lines.length > 0 && <Button variant="ghost" onClick={() => setDraft((d) => ({ ...emptyDraft(), date: d.date }))}>{t('Clear')}</Button>}
              {!isIn && shortages.length > 0 && settings.allowNegativeStock && (
                <Button variant="danger" disabled={!canConfirm} onClick={() => submit.mutate(true)} loading={submit.isPending}>
                  {t('Dispatch anyway')}
                </Button>
              )}
              <Button
                variant={isIn ? 'success' : 'primary'}
                size="lg"
                disabled={!canConfirm || shortages.length > 0}
                onClick={() => setConfirm(true)}
                icon={<CheckCircle2 className="size-5" />}
              >
                {isIn ? t('Confirm Receipt') : t('Confirm Dispatch')}
              </Button>
            </div>
          </div>
        </div>
      </Card>

      <ProductChooser code={chooser?.code ?? ''} products={chooser?.products ?? null} onPick={(p) => (setChooser(null), addProduct(p))} onClose={() => setChooser(null)} />
      <ConfirmDialog
        open={confirm}
        title={isIn ? t('Confirm receipt?') : t('Confirm dispatch?')}
        message={
          isIn
            ? t('{lines} lines / {qty} units will be ADDED to stock.', { lines: draft.lines.length, qty: fmtQty(totals.qty) })
            : t('{lines} lines / {qty} units will be REMOVED from stock.', { lines: draft.lines.length, qty: fmtQty(totals.qty) })
        }
        confirmLabel={isIn ? t('Confirm Receipt') : t('Confirm Dispatch')}
        tone={isIn ? 'success' : 'primary'}
        loading={submit.isPending}
        onConfirm={() => submit.mutate(false)}
        onClose={() => setConfirm(false)}
      />
    </div>
  );
}

function History({ kind }: { kind: Kind }) {
  const t = useT();
  const isIn = kind === 'receipt';
  const navigate = useNavigate();
  const { can } = useAuth();
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const { data, isLoading } = useQuery({
    queryKey: ['documents', kind, q, from, to, page],
    queryFn: () => api.get<Page<StockDocument>>(`/${isIn ? 'receipts' : 'dispatches'}`, { q, from, to, page, pageSize: 25 }),
    placeholderData: keepPreviousData,
  });
  return (
    <Card>
      <div className="flex flex-wrap items-end gap-2 border-b border-line p-3">
        <Input className="w-full sm:w-64" placeholder={isIn ? t('Number, invoice, supplier…') : t('Number, customer, reference…')} value={q} onChange={(e) => (setQ(e.target.value), setPage(1))} />
        <Input type="date" className="w-auto" value={from} onChange={(e) => (setFrom(e.target.value), setPage(1))} aria-label={t('From')} />
        <Input type="date" className="w-auto" value={to} onChange={(e) => (setTo(e.target.value), setPage(1))} aria-label={t('To')} />
        {can('export.run') && (
          <Button className="ml-auto" icon={<Download className="size-4" />} onClick={() => download(`/export/documents/${isIn ? 'receipts' : 'dispatches'}`, { from, to }).catch((e) => toast.error(errMsg(e)))}>
            {t('Export lines')}
          </Button>
        )}
      </div>
      {isLoading ? (
        <LoadingBlock />
      ) : !data?.data.length ? (
        <EmptyState title={isIn ? t('No receipts found') : t('No dispatches found')} />
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <Th>{t('Number')}</Th>
                <Th>{t('Date')}</Th>
                <Th>{isIn ? t('Supplier') : t('Customer')}</Th>
                <Th className="hidden md:table-cell">{isIn ? t('Invoice') : t('Reference')}</Th>
                <Th align="right">{t('Lines')}</Th>
                <Th align="right">{t('Units')}</Th>
                <Th align="right" className="hidden lg:table-cell">{t('Value')}</Th>
                <Th className="hidden md:table-cell">{t('User')}</Th>
                <Th>{t('Status')}</Th>
              </tr>
            </thead>
            <tbody>
              {data.data.map((d) => (
                <tr key={d.id} className="cursor-pointer hover:bg-surface-2" onClick={() => navigate(`/${isIn ? 'stock-in' : 'stock-out'}/${d.id}`)}>
                  <Td className="font-mono text-xs font-medium whitespace-nowrap"><Link to={`/${isIn ? 'stock-in' : 'stock-out'}/${d.id}`} className="hover:underline">{d.number}</Link></Td>
                  <Td className="tabular whitespace-nowrap">{fmtDate(d.date)}</Td>
                  <Td className="max-w-[200px] truncate">{(isIn ? d.supplier_name : d.customer_name) ?? '—'}</Td>
                  <Td className="hidden text-xs md:table-cell">{(isIn ? d.invoice_number : d.reference) ?? '—'}</Td>
                  <Td align="right" className="tabular">{d.item_count}</Td>
                  <Td align="right" className="tabular font-medium">{fmtQty(d.total_quantity)}</Td>
                  <Td align="right" className="tabular hidden lg:table-cell">{fmtMoney(d.total_value)}</Td>
                  <Td className="hidden md:table-cell">{d.created_by_username}</Td>
                  <Td>{d.status === 'CANCELLED' ? <Badge tone="bad">{t('Cancelled')}</Badge> : <Badge tone="ok">{t('Confirmed')}</Badge>}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <Pagination page={page} pageSize={25} total={data.total} onPage={setPage} />
        </>
      )}
    </Card>
  );
}
