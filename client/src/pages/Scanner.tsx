import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowDownToLine, ArrowUpFromLine, CheckCircle2, MapPin, Plus, Search, Trash2, Undo2, Volume2, VolumeX, XCircle } from 'lucide-react';
import { ApiError, api, newIdempotencyKey } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtQty, fmtTime } from '../lib/format';
import { useT } from '../lib/i18n';
import { beep, setSoundEnabled, soundEnabled } from '../lib/scanner';
import type { Product, Transaction } from '../lib/types';
import { ProductChooser } from '../components/ProductChooser';
import { ProductPicker, type ProductPickerHandle } from '../components/ProductPicker';
import { useScanHandler } from '../components/ScanContext';
import { Button, Card, CardHeader, EmptyState, IconButton, Input, Kbd, ProductThumb, QtyChange, Segmented, StockBadge } from '../components/ui';

type Mode = 'IN' | 'OUT' | 'LOOKUP';
type QtyMode = 'one' | 'fixed' | 'ask';

interface LogEntry {
  key: string;
  at: string;
  product: Product;
  tx: Transaction;
  undone?: boolean;
}

interface LastResult {
  status: 'ok' | 'error' | 'info';
  product?: Product;
  tx?: Transaction;
  code?: string;
  message?: string;
  notFound?: boolean;
  seq: number;
}

function usePersisted<T>(key: string, initial: T, storage: Storage = localStorage) {
  const [v, setV] = useState<T>(() => {
    try {
      const raw = storage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      storage.setItem(key, JSON.stringify(v));
    } catch {
      /* ignore */
    }
  }, [key, v, storage]);
  return [v, setV] as const;
}

export default function Scanner() {
  const t = useT();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { can } = useAuth();
  const picker = useRef<ProductPickerHandle>(null);
  const qtyInput = useRef<HTMLInputElement>(null);

  const [mode, setMode] = usePersisted<Mode>('ims-scan-mode', 'IN');
  const [qtyMode, setQtyMode] = usePersisted<QtyMode>('ims-scan-qtymode', 'one');
  const [fixedQty, setFixedQty] = usePersisted('ims-scan-fixedqty', '10');
  const [reference, setReference] = useState('');
  const [log, setLog] = usePersisted<LogEntry[]>('ims-scan-log', [], sessionStorage);
  const [last, setLast] = useState<LastResult | null>(null);
  const [pending, setPending] = useState<Product | null>(null);
  const [askQty, setAskQty] = useState('1');
  const [chooser, setChooser] = useState<{ code: string; products: Product[] } | null>(null);
  const [sound, setSound] = useState(soundEnabled());
  const seq = useRef(0);

  const focusScan = () => {
    // Immediately (a scanner may already be sending the next code) and again after re-render.
    picker.current?.focus();
    setTimeout(() => picker.current?.focus(), 30);
  };
  useEffect(() => {
    focusScan();
  }, [mode, qtyMode]);

  const show = (r: Omit<LastResult, 'seq'>) => setLast({ ...r, seq: ++seq.current });

  const quantity = () => {
    if (qtyMode === 'one') return 1;
    const n = Number(String(fixedQty).replace(',', '.'));
    return Number.isFinite(n) && n > 0 ? n : 1;
  };

  const post = useCallback(
    async (body: { code?: string; productId?: number; quantity: number }) => {
      try {
        // One key per scan: a network retry sends the same key, so the movement is posted once.
        const res = await api.post<{ data: { product: Product; transaction: Transaction } }>(
          '/stock/scan',
          { ...body, mode, reference: reference || null, idempotencyKey: newIdempotencyKey() },
          { retries: 2 },
        );
        const { product, transaction } = res.data;
        beep(product.stockStatus === 'IN_STOCK' || mode === 'IN' ? 'ok' : 'warn');
        show({ status: 'ok', product, tx: transaction });
        setLog((l) => [{ key: `${transaction.id}`, at: transaction.created_at, product, tx: transaction }, ...l].slice(0, 300));
        void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'picker' });
      } catch (e) {
        beep('error');
        if (e instanceof ApiError && e.code === 'MULTIPLE_MATCHES') {
          setChooser({ code: body.code ?? '', products: e.details.products });
          return;
        }
        if (e instanceof ApiError && e.code === 'INSUFFICIENT_STOCK') {
          const item = e.details.items[0];
          show({
            status: 'error',
            code: body.code,
            message: t('Not enough stock for {sku}: available {available}, requested {requested}', item),
          });
          return;
        }
        show({
          status: 'error',
          code: body.code,
          notFound: e instanceof ApiError && e.code === 'PRODUCT_NOT_FOUND',
          message: e instanceof ApiError && e.code === 'PRODUCT_NOT_FOUND' ? t('No product found for barcode {code}', { code: body.code }) : (e as Error).message,
        });
      } finally {
        focusScan();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mode, reference, qc, t],
  );

  const lookup = async (code: string): Promise<Product | null> => {
    const res = await api.get<{ data: Product[] }>('/products/lookup', { code });
    if (res.data.length === 0) {
      beep('error');
      show({ status: 'error', code, notFound: true, message: t('No product found for barcode {code}', { code }) });
      return null;
    }
    if (res.data.length > 1) {
      beep('warn');
      setChooser({ code, products: res.data });
      return null;
    }
    return res.data[0];
  };

  const startAsk = (p: Product) => {
    beep('ok');
    setPending(p);
    setAskQty('1');
    show({ status: 'info', product: p });
    setTimeout(() => qtyInput.current?.select(), 30);
  };

  const onProduct = (p: Product) => {
    if (mode === 'LOOKUP') {
      beep('ok');
      show({ status: 'info', product: p });
      focusScan();
    } else if (qtyMode === 'ask') startAsk(p);
    else void post({ productId: p.id, quantity: quantity() });
  };

  const onCode = async (code: string) => {
    if (pending) setPending(null);
    if (mode === 'LOOKUP' || qtyMode === 'ask') {
      const p = await lookup(code).catch((e) => (show({ status: 'error', code, message: (e as Error).message }), null));
      if (p) onProduct(p);
      else focusScan();
      return;
    }
    void post({ code, quantity: quantity() });
  };

  useScanHandler((code) => void onCode(code));

  const confirmAsk = () => {
    if (!pending) return;
    const n = Number(askQty.replace(',', '.'));
    if (!Number.isFinite(n) || n <= 0) return;
    const p = pending;
    setPending(null);
    void post({ productId: p.id, quantity: n });
  };

  const undo = async (entry: LogEntry) => {
    try {
      const res = await api.post<{ data: { product: Product; transaction: Transaction } }>(`/transactions/${entry.tx.id}/reverse`, { reason: 'Undo scan' });
      setLog((l) => l.map((e) => (e.key === entry.key ? { ...e, undone: true } : e)));
      show({ status: 'info', product: res.data.product, tx: res.data.transaction, message: t('Scan undone') });
      beep('ok');
      void qc.invalidateQueries();
    } catch (e) {
      beep('error');
      show({ status: 'error', message: (e as Error).message });
    }
    focusScan();
  };

  const active = log.filter((e) => !e.undone);
  const unitsIn = active.filter((e) => e.tx.quantity_change > 0).reduce((s, e) => s + e.tx.quantity_change, 0);
  const unitsOut = active.filter((e) => e.tx.quantity_change < 0).reduce((s, e) => s - e.tx.quantity_change, 0);

  const modeColor = mode === 'IN' ? 'border-emerald-500' : mode === 'OUT' ? 'border-orange-500' : 'border-line-strong';

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{t('Barcode Scanner')}</h1>
          <p className="text-sm text-muted">{t('Continuous scanning — the field stays ready for the next barcode.')}</p>
        </div>
        <div className="flex items-center gap-2">
          <IconButton
            label={sound ? t('Mute sounds') : t('Enable sounds')}
            onClick={() => (setSoundEnabled(!sound), setSound(!sound), focusScan())}
            className="border border-line"
          >
            {sound ? <Volume2 className="size-4" /> : <VolumeX className="size-4" />}
          </IconButton>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className="space-y-4">
          <Card className={clsx('border-t-4 p-4', modeColor)}>
            <div className="flex flex-wrap items-center gap-3">
              <Segmented<Mode>
                size="lg"
                value={mode}
                onChange={(m) => (setMode(m), setPending(null))}
                className="flex w-full sm:w-auto"
                options={[
                  { value: 'IN', label: <><ArrowDownToLine className="size-4.5" /> STOCK IN</>, activeClass: 'bg-emerald-600 text-white shadow-sm' },
                  { value: 'OUT', label: <><ArrowUpFromLine className="size-4.5" /> STOCK OUT</>, activeClass: 'bg-orange-600 text-white shadow-sm' },
                  { value: 'LOOKUP', label: <><Search className="size-4.5" /> {t('Lookup')}</>, activeClass: 'bg-surface text-fg shadow-sm' },
                ]}
              />
              {mode !== 'LOOKUP' && (
                <div className="flex flex-wrap items-center gap-2">
                  <Segmented<QtyMode>
                    value={qtyMode}
                    onChange={setQtyMode}
                    options={[
                      { value: 'one', label: t('1 per scan') },
                      { value: 'fixed', label: t('Fixed qty') },
                      { value: 'ask', label: t('Ask qty') },
                    ]}
                  />
                  {qtyMode === 'fixed' && (
                    <Input
                      aria-label={t('Quantity per scan')}
                      inputMode="decimal"
                      value={fixedQty}
                      onChange={(e) => setFixedQty(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), focusScan())}
                      className="tabular w-20 text-center font-semibold"
                    />
                  )}
                </div>
              )}
            </div>

            <div className="mt-4">
              <ProductPicker ref={picker} sticky autoFocus onCode={(c) => void onCode(c)} onSelect={onProduct} />
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
                <span>
                  {mode === 'IN' && t('Each scan ADDS {q} to stock.', { q: qtyMode === 'ask' ? t('the quantity you enter') : fmtQty(quantity()) })}
                  {mode === 'OUT' && t('Each scan REMOVES {q} from stock.', { q: qtyMode === 'ask' ? t('the quantity you enter') : fmtQty(quantity()) })}
                  {mode === 'LOOKUP' && t('Scan to view product information without changing stock.')}
                </span>
                {mode !== 'LOOKUP' && (
                  <span className="flex items-center gap-1.5">
                    {t('Reference')}
                    <input
                      value={reference}
                      onChange={(e) => setReference(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), focusScan())}
                      placeholder={t('optional')}
                      className="h-7 w-36 rounded-md border border-line bg-surface px-2 text-xs text-fg focus:border-brand focus:outline-none"
                    />
                  </span>
                )}
              </div>
            </div>
          </Card>

          {pending && (
            <Card className="border-brand p-4">
              <form
                onSubmit={(e) => (e.preventDefault(), confirmAsk())}
                className="flex flex-wrap items-center gap-3"
              >
                <ProductThumb url={pending.imageUrl} name={pending.name} />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{pending.name}</div>
                  <div className="font-mono text-xs text-muted">{pending.sku} · {t('in stock')}: {fmtQty(pending.quantity, pending.unit)}</div>
                </div>
                <label className="flex items-center gap-2 text-sm font-medium">
                  {mode === 'IN' ? t('Quantity to add') : t('Quantity to remove')}
                  <input
                    ref={qtyInput}
                    inputMode="decimal"
                    value={askQty}
                    onChange={(e) => setAskQty(e.target.value)}
                    onKeyDown={(e) => e.key === 'Escape' && (setPending(null), focusScan())}
                    className="tabular h-12 w-28 rounded-lg border-2 border-brand bg-surface text-center text-xl font-semibold focus:outline-none"
                  />
                </label>
                <Button type="submit" variant={mode === 'IN' ? 'success' : 'primary'} size="lg">
                  {t('Confirm')} <Kbd>Enter</Kbd>
                </Button>
                <Button onClick={() => (setPending(null), focusScan())}>{t('Cancel')}</Button>
              </form>
            </Card>
          )}

          <LastScanCard last={last} canCreate={can('products.manage')} onCreate={(code) => navigate(`/products/new?barcode=${encodeURIComponent(code)}`)} />
        </div>

        <Card className="flex flex-col xl:max-h-[calc(100vh-9rem)]">
          <CardHeader
            title={t('Scan session')}
            subtitle={t('{n} scans · +{in} in · −{out} out', { n: active.length, in: fmtQty(unitsIn), out: fmtQty(unitsOut) })}
            actions={
              log.length > 0 && (
                <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => (setLog([]), focusScan())}>
                  {t('Clear')}
                </Button>
              )
            }
          />
          {log.length === 0 ? (
            <EmptyState title={t('No scans yet')} description={t('Scanned products appear here. You can undo a scan for 30 minutes.')} />
          ) : (
            <ul className="flex-1 divide-y divide-line overflow-y-auto">
              {log.map((e) => (
                <li key={e.key} className={clsx('flex items-center gap-3 px-4 py-2.5', e.undone && 'opacity-45')}>
                  <div className="w-14 shrink-0 font-mono text-[11px] text-muted">{fmtTime(e.at)}</div>
                  <div className="min-w-0 flex-1">
                    <Link to={`/products/${e.product.id}`} className={clsx('block truncate text-sm font-medium hover:underline', e.undone && 'line-through')}>
                      {e.product.name}
                    </Link>
                    <div className="font-mono text-xs text-muted">{e.product.sku}</div>
                  </div>
                  <div className="text-right">
                    <QtyChange value={e.tx.quantity_change} />
                    <div className="tabular text-[11px] text-muted">→ {fmtQty(e.tx.quantity_after)}</div>
                  </div>
                  {!e.undone && Date.now() - Date.parse(e.at) < 30 * 60_000 ? (
                    <IconButton label={t('Undo')} onClick={() => void undo(e)}>
                      <Undo2 className="size-4" />
                    </IconButton>
                  ) : (
                    <span className="w-8" />
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <ProductChooser
        code={chooser?.code ?? ''}
        products={chooser?.products ?? null}
        onPick={(p) => (setChooser(null), onProduct(p))}
        onClose={() => (setChooser(null), focusScan())}
      />
    </div>
  );
}

function LastScanCard({ last, canCreate, onCreate }: { last: LastResult | null; canCreate: boolean; onCreate: (code: string) => void }) {
  const t = useT();
  if (!last)
    return (
      <Card className="flex min-h-64 flex-col items-center justify-center p-8 text-center">
        <div className="mb-3 flex size-14 items-center justify-center rounded-2xl bg-surface-3">
          <svg viewBox="0 0 32 32" className="size-8 text-muted" fill="currentColor" aria-hidden>
            <rect x="4" y="6" width="2" height="20" /><rect x="8" y="6" width="1" height="20" /><rect x="11" y="6" width="3" height="20" /><rect x="16" y="6" width="1" height="20" /><rect x="19" y="6" width="3" height="20" /><rect x="24" y="6" width="1" height="20" /><rect x="26" y="6" width="2" height="20" />
          </svg>
        </div>
        <p className="font-medium">{t('Ready to scan')}</p>
        <p className="mt-1 max-w-sm text-sm text-muted">{t('Use a USB or Bluetooth barcode scanner, or type a barcode / SKU and press Enter.')}</p>
      </Card>
    );

  if (last.status === 'error')
    return (
      <Card key={last.seq} className="flash-bad border-bad/40 bg-bad-soft p-6">
        <div className="flex items-start gap-3">
          <XCircle className="size-8 shrink-0 text-bad" />
          <div className="min-w-0 flex-1">
            <p className="text-lg font-semibold text-bad">{last.message}</p>
            {last.code && <p className="mt-1 font-mono text-sm text-fg-2">{last.code}</p>}
            {last.notFound && canCreate && last.code && (
              <Button className="mt-3" variant="primary" icon={<Plus className="size-4" />} onClick={() => onCreate(last.code!)}>
                {t('Create product with this barcode')}
              </Button>
            )}
          </div>
        </div>
      </Card>
    );

  const p = last.product!;
  const tx = last.tx;
  return (
    <Card key={last.seq} className={clsx('p-5', last.status === 'ok' && 'flash-ok')}>
      <div className="flex flex-col gap-5 sm:flex-row">
        <ProductThumb url={p.imageUrl} name={p.name} size="xl" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {last.status === 'ok' && <CheckCircle2 className="size-5 text-ok" />}
            {last.message && <span className="text-sm font-medium text-ok">{last.message}</span>}
            <StockBadge status={p.stockStatus} />
            {p.status === 'INACTIVE' && <span className="text-xs font-semibold text-muted uppercase">{t('Inactive')}</span>}
          </div>
          <Link to={`/products/${p.id}`} className="mt-1 block text-xl font-semibold tracking-tight hover:underline sm:text-2xl">
            {p.name}
          </Link>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 font-mono text-sm text-fg-2">
            <span>SKU {p.sku}</span>
            {p.barcode && <span>{p.barcode}</span>}
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div className="rounded-xl bg-surface-2 p-3">
              <div className="text-[11px] font-semibold text-muted uppercase">{t('Current stock')}</div>
              <div className={clsx('tabular text-3xl font-bold', p.stockStatus === 'OUT_OF_STOCK' ? 'text-bad' : p.stockStatus === 'LOW_STOCK' ? 'text-warn' : 'text-fg')}>
                {fmtQty(p.quantity)}
                <span className="ml-1 text-sm font-medium text-muted">{p.unit}</span>
              </div>
            </div>
            <div className="rounded-xl bg-surface-2 p-3">
              <div className="flex items-center gap-1 text-[11px] font-semibold text-muted uppercase">
                <MapPin className="size-3" /> {t('Location')}
              </div>
              <div className="font-mono text-3xl font-bold">{p.locationCode ?? '—'}</div>
            </div>
            {tx && (
              <div className="col-span-2 rounded-xl bg-surface-2 p-3 sm:col-span-1">
                <div className="text-[11px] font-semibold text-muted uppercase">{t('This scan')}</div>
                <div className="flex items-baseline gap-2 text-3xl font-bold">
                  <QtyChange value={tx.quantity_change} />
                </div>
                <div className="tabular text-xs text-muted">
                  {fmtQty(tx.quantity_before)} → {fmtQty(tx.quantity_after)}
                </div>
              </div>
            )}
          </div>
          <div className="mt-3 text-xs text-muted">
            {t('Minimum stock')}: {fmtQty(p.minStock)} · {p.categoryName ?? '—'} · {p.supplierName ?? '—'}
          </div>
        </div>
      </div>
    </Card>
  );
}
