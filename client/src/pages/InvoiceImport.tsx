/**
 * Stock In from a supplier invoice: upload the invoice (PDF, Excel or CSV), read its lines with
 * the supplier's saved column layout (chosen once from the first invoice), check the matches,
 * and receive it as a goods receipt. Descriptions stay exactly as on the invoice.
 */
import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { AlertTriangle, CheckCircle2, FileText, FileUp, RotateCcw, Search, Upload } from 'lucide-react';
import { ApiError, api, newIdempotencyKey } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDate, fmtMoney, fmtNumber, todayLocal } from '../lib/format';
import { useT } from '../lib/i18n';
import { errMsg, useSuppliers } from '../lib/queries';
import type { Product } from '../lib/types';
import {
  INVOICE_FIELDS,
  buildTable,
  columnsFromLayout,
  extractLines,
  findHeader,
  layoutFrom,
  lineText,
  readInvoiceFile,
  rowCount,
  suggestColumns,
  type ExtractedLine,
  type InvoiceField,
  type InvoiceLayout,
  type InvoiceSource,
  type Table as InvoiceTable,
} from '../lib/invoiceFile';
import { ProductPicker } from '../components/ProductPicker';
import { Badge, Button, Card, CardHeader, Checkbox, EmptyState, ErrorBox, Field, Input, Modal, Select, Table, Td, Th } from '../components/ui';

const FIELD_LABEL: Record<InvoiceField, string> = {
  description: 'Description',
  sku: 'Supplier code',
  barcode: 'Barcode',
  quantity: 'Quantity',
  unitPrice: 'Unit price',
  lineTotal: 'Line total (net)',
};

type MatchBy = 'barcode' | 'sku' | 'supplier-code' | 'saved-description' | 'description' | 'other-supplier' | 'spacing' | 'similar';
const BY_LABEL: Record<MatchBy, string> = {
  barcode: 'same barcode',
  sku: 'same code',
  'supplier-code': "supplier's code (saved)",
  'saved-description': "supplier's description (saved)",
  description: 'same description',
  'other-supplier': 'saved for another supplier',
  spacing: 'differs only in spaces',
  similar: 'similar description',
};

interface ProductSummary {
  id: number;
  sku: string;
  name: string;
  barcode: string | null;
  status: string;
  unit: string;
  purchasePrice: number;
}

interface LineMatch {
  line: { lineNo: number; description: string | null; sku: string | null; barcode: string | null; quantity: number | null; unitPrice: number | null };
  status: 'matched' | 'review' | 'new' | 'error';
  productId: number | null;
  by: MatchBy | null;
  candidates: { product: ProductSummary; by: MatchBy; score?: number }[];
  errors: string[];
  warnings: string[];
}

interface Duplicate {
  receiptId: number;
  receiptNumber: string;
  receiptDate: string;
  invoiceNumber: string | null;
  reason: 'number' | 'file';
}

interface MatchResponse {
  lines: LineMatch[];
  duplicates: Duplicate[];
  summary: { total: number; matched: number; review: number; new: number; errors: number };
}

type Action = 'product' | 'new' | 'skip' | '';

interface Decision {
  action: Action;
  product: ProductSummary | null;
  quantity: string;
  unitPrice: string;
  newSku: string;
  newName: string;
  newSellingPrice: string;
}

const numText = (n: number | null | undefined) => (n == null ? '' : String(n).replace('.', ','));
/** Prices with at least two decimals (7,20), at most four. */
const priceText = (n: number | null | undefined) =>
  n == null ? '' : n.toLocaleString('el-GR', { minimumFractionDigits: 2, maximumFractionDigits: 4, useGrouping: false });

/** The server's messages about a line, in the language of the screen. */
const MESSAGES: [RegExp, string][] = [
  [/^Unit price (.+) on the invoice; (.+) after discount \(net value \/ quantity\) is used$/, 'Unit price {1} on the invoice; {2} after discount (net value / quantity) is used'],
  [/^Same product as line (.+)$/, 'Same product as line {1}'],
  [/^Product (.+) is inactive: activate it or choose another product$/, 'Product {1} is inactive: activate it or choose another product'],
  [/^The barcode also fits (.+)$/, 'The barcode also fits {1}'],
  [/^The code also fits (.+)$/, 'The code also fits {1}'],
  [/^Fits several products: (.+)$/, 'Fits several products: {1}'],
  [/^Code (.+) is our SKU of a product of another supplier$/, 'Code {1} is our SKU of a product of another supplier'],
  [/^(Quantity|Unit price|Line total) "(.+)" is not a number$/, '{1} "{2}" is not a number'],
];
function useMessage() {
  const t = useT();
  return (msg: string) => {
    for (const [re, key] of MESSAGES) {
      const m = msg.match(re);
      if (m) return t(key, Object.fromEntries(m.slice(1).map((v, i) => [String(i + 1), t(v)])));
    }
    return t(msg);
  };
}
const parseNum = (s: string) => (s.trim() === '' ? null : Number(s.replace(/\s/g, '').replace(',', '.')));

export default function InvoiceImport() {
  const t = useT();
  const message = useMessage();
  const qc = useQueryClient();
  const { can } = useAuth();
  const canCreate = can('products.manage');
  const suppliers = useSuppliers();
  const fileInput = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<'start' | 'columns' | 'review' | 'done'>('start');
  const [supplierId, setSupplierId] = useState('');
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [date, setDate] = useState(todayLocal());
  const [source, setSource] = useState<InvoiceSource | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [headerIndex, setHeaderIndex] = useState(-1);
  const [mapping, setMapping] = useState<(InvoiceField | '')[]>([]);
  const [joinWrapped, setJoinWrapped] = useState(false);
  const [updatePrices, setUpdatePrices] = useState(true);
  const [fromSaved, setFromSaved] = useState(false);
  const [lines, setLines] = useState<ExtractedLine[]>([]);
  const [matchResult, setMatchResult] = useState<MatchResponse | null>(null);
  const [decisions, setDecisions] = useState<Record<number, Decision>>({});
  const [allowDuplicate, setAllowDuplicate] = useState(false);
  const [picking, setPicking] = useState<number | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ receipt: { id: number; receipt_number: string }; created: { sku: string }[]; skipped: number } | null>(null);
  const idemKey = useRef(newIdempotencyKey());

  const history = useQuery({
    queryKey: ['invoices'],
    queryFn: () => api.get<{ data: { id: number; invoice_number: string; invoice_date: string; supplier_name: string; receipt_id: number; receipt_number: string; receipt_status: string; line_count: number; file_name: string | null }[] }>('/invoices').then((r) => r.data),
  });

  const table: InvoiceTable | null = useMemo(() => (source && headerIndex >= 0 ? buildTable(source, headerIndex) : null), [source, headerIndex]);
  const extracted = useMemo(() => (table ? extractLines(table, mapping, joinWrapped) : []), [table, mapping, joinWrapped]);
  const supplierName = suppliers.data?.find((s) => String(s.id) === supplierId)?.name ?? '';

  const reset = () => {
    setStep('start');
    setSource(null);
    setFile(null);
    setLines([]);
    setMatchResult(null);
    setDecisions({});
    setAllowDuplicate(false);
    setInvoiceNumber('');
    setError(null);
    setDone(null);
    idemKey.current = newIdempotencyKey();
  };

  /** Match the lines on the server and prepare one decision per line. */
  const runMatch = async (found: ExtractedLine[], src: InvoiceSource) => {
    const res = await api.post<{ data: MatchResponse }>('/invoices/match', {
      supplierId: Number(supplierId),
      invoiceNumber: invoiceNumber.trim() || null,
      fileHash: src.hash,
      lines: found.map((l) => ({ lineNo: l.lineNo, description: l.description, sku: l.sku, barcode: l.barcode, quantity: l.quantity, unitPrice: l.unitPrice, lineTotal: l.lineTotal })),
    });
    const next: Record<number, Decision> = {};
    for (const m of res.data.lines) {
      const chosen = m.productId ? (m.candidates.find((c) => c.product.id === m.productId)?.product ?? null) : null;
      next[m.line.lineNo] = {
        // Only a reliable match is pre-selected; everything else waits for a person.
        action: m.status === 'matched' ? 'product' : m.status === 'error' ? 'skip' : '',
        product: chosen,
        quantity: numText(m.line.quantity),
        unitPrice: priceText(m.line.unitPrice),
        newSku: m.line.sku ?? '',
        newName: m.line.description ?? m.line.sku ?? '',
        newSellingPrice: '',
      };
    }
    setLines(found);
    setMatchResult(res.data);
    setDecisions(next);
    setAllowDuplicate(false);
    setStep('review');
  };

  const loadFile = async (f: File) => {
    setError(null);
    if (!supplierId) {
      setError(t('Choose the supplier first: each supplier has its own invoice layout'));
      return;
    }
    setBusy(true);
    try {
      const layout = (await api.get<{ data: InvoiceLayout | null }>(`/invoices/layout/${supplierId}`)).data;
      const src = await readInvoiceFile(f, layout?.sheet);
      setFile(f);
      setSource(src);
      setJoinWrapped(layout?.joinWrapped ?? false);
      setUpdatePrices(layout?.updatePrices ?? true);
      // The supplier's saved layout: straight to the lines when the invoice still looks the same.
      if (layout && layout.source === src.kind) {
        const h = findHeader(src, layout);
        if (h >= 0) {
          const tbl = buildTable(src, h);
          const map = columnsFromLayout(tbl, layout);
          const found = extractLines(tbl, map, layout.joinWrapped);
          setHeaderIndex(h);
          setMapping(map);
          if (found.length) {
            setFromSaved(true);
            await runMatch(found, src);
            return;
          }
        }
      }
      // First invoice of this supplier (or a changed layout): the person checks the columns once.
      const h = findHeader(src);
      const start = h >= 0 ? h : 0;
      setHeaderIndex(start);
      setMapping(suggestColumns(buildTable(src, start).headers));
      setFromSaved(false);
      setStep('columns');
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const changeHeader = (i: number) => {
    if (!source) return;
    setHeaderIndex(i);
    setMapping(suggestColumns(buildTable(source, i).headers));
  };

  const decide = (lineNo: number, patch: Partial<Decision>) => setDecisions((d) => ({ ...d, [lineNo]: { ...d[lineNo], ...patch } }));

  const rows = matchResult?.lines ?? [];
  const undecided = rows.filter((m) => !decisions[m.line.lineNo]?.action);
  const used = rows.filter((m) => ['product', 'new'].includes(decisions[m.line.lineNo]?.action));
  const invalid = used.filter((m) => {
    const d = decisions[m.line.lineNo];
    const q = parseNum(d.quantity);
    const p = parseNum(d.unitPrice);
    return !q || q <= 0 || Number.isNaN(q) || (p !== null && (Number.isNaN(p) || p < 0)) || (d.action === 'product' && !d.product) || (d.action === 'new' && !d.newName.trim());
  });
  const duplicates = matchResult?.duplicates ?? [];

  const commit = useMutation({
    mutationFn: () =>
      api.post<{ data: { receipt: { id: number; receipt_number: string }; created: { sku: string }[]; skipped: number } }>(
        '/invoices/commit',
        {
          idempotencyKey: idemKey.current,
          supplierId: Number(supplierId),
          invoiceNumber: invoiceNumber.trim(),
          date,
          fileName: file?.name ?? null,
          fileHash: source?.hash ?? null,
          updatePurchasePrices: updatePrices,
          allowDuplicate,
          layout: source && table ? layoutFrom(source, table, mapping, { joinWrapped, updatePrices }) : null,
          lines: rows.map((m) => {
            const d = decisions[m.line.lineNo];
            const action = d.action || 'skip';
            return {
              lineNo: m.line.lineNo,
              description: m.line.description,
              sku: m.line.sku,
              barcode: m.line.barcode,
              quantity: parseNum(d.quantity) ?? 0,
              unitPrice: parseNum(d.unitPrice),
              action: action === 'product' || action === 'new' ? action : 'skip',
              productId: action === 'product' ? d.product?.id : null,
              newProduct:
                action === 'new'
                  ? { sku: d.newSku.trim() || null, name: d.newName.trim() || null, sellingPrice: parseNum(d.newSellingPrice) }
                  : null,
            };
          }).filter((l) => l.action !== 'skip' || l.quantity > 0),
        },
        { retries: 2 },
      ),
    onSuccess: (r) => {
      setDone(r.data);
      setStep('done');
      void qc.invalidateQueries();
    },
    onError: (e) => {
      // Received before: shown above the lines; the person decides.
      if (e instanceof ApiError && e.code === 'DUPLICATE_INVOICE' && matchResult)
        setMatchResult({ ...matchResult, duplicates: (e.details?.duplicates as Duplicate[]) ?? matchResult.duplicates });
    },
  });

  // ---- Step 1: supplier, invoice, file ------------------------------------------------------
  if (step === 'start')
    return (
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
        <Card className="p-5">
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label={t('Supplier')} required>
              <Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
                <option value="">{t('— Choose —')}</option>
                {suppliers.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            </Field>
            <Field label={t('Invoice number')} required>
              <Input value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} maxLength={100} />
            </Field>
            <Field label={t('Invoice date')} required>
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
          </div>
          <div
            className={clsx('mt-5 flex flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-12 text-center', supplierId ? 'border-line-strong' : 'border-line opacity-60')}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const f = e.dataTransfer.files[0];
              if (f) void loadFile(f);
            }}
          >
            <div className="mb-3 flex size-12 items-center justify-center rounded-xl bg-brand-soft text-brand-fg">
              <FileUp className="size-6" />
            </div>
            <p className="font-medium">{t("Drop the supplier's invoice here")}</p>
            <p className="mt-1 text-sm text-muted">.pdf · .xlsx · .xls · .csv</p>
            <Button className="mt-4" variant="primary" icon={<Upload className="size-4" />} loading={busy} disabled={!supplierId} onClick={() => fileInput.current?.click()}>
              {t('Choose invoice file')}
            </Button>
            <input
              ref={fileInput}
              type="file"
              accept=".pdf,.xlsx,.xls,.csv"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) void loadFile(f);
              }}
            />
          </div>
          {error != null && <div className="mt-4"><ErrorBox error={t(errMsg(error))} /></div>}
        </Card>
        <Card>
          <CardHeader title={t('How it works')} />
          <ol className="list-decimal space-y-2 px-8 pb-5 text-sm text-fg-2">
            <li>{t('Choose the supplier, write the invoice number and drop the file.')}</li>
            <li>{t('The first invoice of a supplier: confirm which column is the description, quantity and price. It is remembered.')}</li>
            <li>{t('Lines that match a product for sure are ready. Uncertain lines wait for you: choose the product, create a new one or skip.')}</li>
            <li>{t('Receive: stock goes up as a goods receipt with the invoice number. Descriptions stay exactly as on the invoice.')}</li>
          </ol>
          <div className="border-t border-line">
            <div className="px-4 pt-3 text-xs font-semibold text-muted uppercase">{t('Recent invoices')}</div>
            {history.data?.length ? (
              <ul className="divide-y divide-line">
                {history.data.slice(0, 8).map((h) => (
                  <li key={h.id} className="flex items-center justify-between gap-2 px-4 py-2 text-sm">
                    <span className="min-w-0 truncate">
                      {h.supplier_name} · <span className="font-mono">{h.invoice_number}</span>
                    </span>
                    <Link to={`/stock-in/${h.receipt_id}`} className="shrink-0 font-mono text-xs underline">
                      {h.receipt_number}
                      {h.receipt_status === 'CANCELLED' && ` (${t('Cancelled')})`}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-4 py-3 text-sm text-muted">{t('No invoices imported yet')}</p>
            )}
          </div>
        </Card>
      </div>
    );

  // ---- Step 2: columns (first invoice of a supplier) ------------------------------------------
  if (step === 'columns' && source && table)
    return (
      <Card>
        <CardHeader
          title={t('Columns of the invoice')}
          subtitle={t('{file} — chosen once for {supplier}; the next invoices are read by themselves', { file: source.fileName, supplier: supplierName })}
        />
        <div className="grid gap-4 border-b border-line p-4 md:grid-cols-[minmax(0,1fr)_auto]">
          <Field label={t('Header row of the invoice (the one with the column titles)')}>
            <Select value={headerIndex} onChange={(e) => changeHeader(Number(e.target.value))}>
              {Array.from({ length: Math.min(rowCount(source), 120) }, (_, i) => (
                <option key={i} value={i}>
                  {i + 1}: {lineText(source, i).slice(0, 110) || '—'}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex items-end pb-1">
            <Checkbox checked={joinWrapped} onChange={setJoinWrapped} label={t('Descriptions continue on the next line')} />
          </div>
        </div>
        <div className="max-h-[55vh] overflow-auto">
          <Table>
            <thead>
              <tr>
                {table.headers.map((h, i) => (
                  <Th key={i}>
                    <div className="mb-1 whitespace-pre-wrap text-xs font-semibold normal-case">{h}</div>
                    <Select
                      className={clsx('h-8 w-40 text-xs', mapping[i] && 'border-ok')}
                      value={mapping[i] ?? ''}
                      aria-label={`${t('Column')} ${h}`}
                      onChange={(e) => {
                        const v = e.target.value as InvoiceField | '';
                        setMapping((m) => table.headers.map((_, j) => (j === i ? v : v && m[j] === v ? '' : (m[j] ?? ''))));
                      }}
                    >
                      <option value="">{t('— Ignore —')}</option>
                      {INVOICE_FIELDS.map((f) => <option key={f} value={f}>{t(FIELD_LABEL[f])}</option>)}
                    </Select>
                  </Th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.slice(0, 14).map((r) => (
                <tr key={r.source}>
                  {table.headers.map((_, i) => (
                    <Td key={i} className="whitespace-pre-wrap text-xs">{r.cells[i] == null ? '' : String(r.cells[i])}</Td>
                  ))}
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line p-4">
          <Button icon={<RotateCcw className="size-4" />} onClick={reset}>{t('Another file')}</Button>
          <div className="flex items-center gap-3 text-sm">
            <span className={extracted.length ? 'text-fg-2' : 'text-bad'}>
              {extracted.length
                ? t('{n} product lines found', { n: fmtNumber(extracted.length) })
                : t('Choose the description (or code) and the quantity column')}
            </span>
            {error != null && <span className="text-bad">{t(errMsg(error))}</span>}
            <Button
              variant="primary"
              disabled={!extracted.length}
              loading={busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  setFromSaved(false);
                  await runMatch(extracted, source);
                } catch (e) {
                  setError(e);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {t('Check the lines')}
            </Button>
          </div>
        </div>
        <p className="border-t border-line px-4 py-3 text-xs text-muted">
          {t('With a "Line total (net)" column the cost per unit is the net value divided by the quantity, so discounts are included; otherwise the unit price is used.')}
        </p>
      </Card>
    );

  // ---- Step 4: done ---------------------------------------------------------------------------
  if (step === 'done' && done)
    return (
      <Card className="p-6">
        <div className="flex items-center gap-3">
          <CheckCircle2 className="size-8 text-ok" />
          <div>
            <h2 className="text-lg font-semibold">{t('Invoice received')}</h2>
            <p className="text-sm text-muted">
              {supplierName} · {invoiceNumber} · {done.receipt.receipt_number}
            </p>
          </div>
        </div>
        <p className="mt-4 text-sm text-fg-2">
          {t('{n} lines received, {c} new products, {s} lines skipped.', { n: used.length, c: done.created.length, s: done.skipped })}
        </p>
        <div className="mt-6 flex gap-2">
          <Button icon={<RotateCcw className="size-4" />} onClick={reset}>{t('Import another invoice')}</Button>
          <Link to={`/stock-in/${done.receipt.id}`}>
            <Button variant="primary" icon={<FileText className="size-4" />}>{t('View receipt')}</Button>
          </Link>
        </div>
      </Card>
    );

  // ---- Step 3: review --------------------------------------------------------------------------
  if (step !== 'review' || !matchResult) return null;
  const s = matchResult.summary;
  const unmatchedNew = rows.filter((m) => m.status === 'new' && !decisions[m.line.lineNo]?.action);

  return (
    <Card>
      <CardHeader
        title={`${supplierName} · ${invoiceNumber || t('(no invoice number)')}`}
        subtitle={
          <>
            {source?.fileName} · {fromSaved ? t('read with the saved layout of this supplier') : t('read with the columns you chose')}{' '}
            <button type="button" className="underline" onClick={() => setStep('columns')}>{t('Change columns')}</button>
          </>
        }
      />
      <div className="grid grid-cols-2 gap-3 border-b border-line p-4 sm:grid-cols-4">
        {[
          { label: t('Matched'), value: s.matched, tone: 'text-ok' },
          { label: t('To check'), value: s.review, tone: 'text-warn' },
          { label: t('Not in the warehouse'), value: s.new, tone: 'text-brand-fg' },
          { label: t('Not product lines'), value: s.errors, tone: 'text-muted' },
        ].map((x) => (
          <div key={x.label} className="rounded-lg bg-surface-2 p-3">
            <div className="text-[11px] font-semibold text-muted uppercase">{x.label}</div>
            <div className={`tabular text-2xl font-semibold ${x.tone}`}>{fmtNumber(x.value)}</div>
          </div>
        ))}
      </div>

      {duplicates.length > 0 && (
        <div className="m-4 rounded-lg border border-warn/40 bg-warn-soft p-3 text-sm">
          <div className="flex items-center gap-2 font-semibold text-warn">
            <AlertTriangle className="size-4" /> {t('This invoice was already received')}
          </div>
          <ul className="mt-1 list-disc pl-6">
            {duplicates.map((d) => (
              <li key={d.receiptId}>
                <Link to={`/stock-in/${d.receiptId}`} className="font-mono underline">{d.receiptNumber}</Link> · {fmtDate(d.receiptDate)} ·{' '}
                {d.reason === 'file' ? t('the same file') : t('invoice {n}', { n: d.invoiceNumber ?? '' })}
              </li>
            ))}
          </ul>
          <div className="mt-2">
            <Checkbox checked={allowDuplicate} onChange={setAllowDuplicate} label={t('Receive it again anyway (the stock goes up a second time)')} />
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 px-4 pt-3">
        {unmatchedNew.length > 0 && canCreate && (
          <Button size="sm" onClick={() => unmatchedNew.forEach((m) => decide(m.line.lineNo, { action: 'new' }))}>
            {t('New product for the {n} lines not in the warehouse', { n: unmatchedNew.length })}
          </Button>
        )}
        {undecided.length > 0 && (
          <Button size="sm" onClick={() => undecided.forEach((m) => decide(m.line.lineNo, { action: 'skip' }))}>
            {t('Skip the {n} undecided lines', { n: undecided.length })}
          </Button>
        )}
      </div>

      <div className="max-h-[65vh] overflow-auto">
        <Table>
          <thead>
            <tr>
              <Th>#</Th>
              <Th>{t('On the invoice')}</Th>
              <Th align="right">{t('Quantity')}</Th>
              <Th align="right">{t('Unit price')}</Th>
              <Th>{t('Product in the warehouse')}</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => {
              const d = decisions[m.line.lineNo];
              const n = m.line.lineNo;
              const extractedLine = lines.find((l) => l.lineNo === n);
              return (
                <tr key={n} className={clsx(m.status === 'error' && 'opacity-60', !d.action && 'bg-warn-soft/50')}>
                  <Td className="align-top font-mono text-xs text-muted">
                    {n}
                    {extractedLine && <div className="text-[10px]">{t('row')} {extractedLine.sourceRow}</div>}
                  </Td>
                  <Td className="max-w-[340px] align-top">
                    <div className="whitespace-pre-wrap font-medium">{m.line.description ?? '—'}</div>
                    {(m.line.sku || m.line.barcode) && (
                      <div className="mt-0.5 whitespace-pre font-mono text-xs text-muted">
                        {m.line.sku && <>{t('Code')}: {m.line.sku} </>}
                        {m.line.barcode && <>· {m.line.barcode}</>}
                      </div>
                    )}
                    {m.errors.map((e) => <div key={e} className="text-xs text-bad">{message(e)}</div>)}
                    {m.warnings.map((w) => <div key={w} className="text-xs text-warn">{message(w)}</div>)}
                  </Td>
                  <Td align="right" className="align-top">
                    <Input className="h-8 w-20 text-right tabular" inputMode="decimal" value={d.quantity} disabled={d.action === 'skip'} onChange={(e) => decide(n, { quantity: e.target.value })} aria-label={t('Quantity')} />
                  </Td>
                  <Td align="right" className="align-top">
                    <Input className="h-8 w-24 text-right tabular" inputMode="decimal" value={d.unitPrice} disabled={d.action === 'skip'} onChange={(e) => decide(n, { unitPrice: e.target.value })} aria-label={t('Unit price')} placeholder="—" />
                  </Td>
                  <Td className="min-w-[320px] align-top">
                    <LineChoice
                      match={m}
                      decision={d}
                      canCreate={canCreate}
                      onChange={(patch) => decide(n, patch)}
                      onPick={() => setPicking(n)}
                    />
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
        {!rows.length && <EmptyState title={t('No product lines')} />}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line p-4">
        <div className="flex flex-wrap items-center gap-4">
          <Button icon={<RotateCcw className="size-4" />} onClick={reset}>{t('Cancel')}</Button>
          <Checkbox checked={updatePrices} onChange={setUpdatePrices} label={t('Update purchase prices from the invoice')} />
        </div>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          {!invoiceNumber.trim() && <span className="text-bad">{t('Write the invoice number')}</span>}
          {undecided.length > 0 && <span className="text-warn">{t('{n} lines to decide', { n: undecided.length })}</span>}
          {invalid.length > 0 && <span className="text-bad">{t('Check quantity / price / product on line {n}', { n: invalid.map((m) => m.line.lineNo).join(', ') })}</span>}
          {commit.error && !(commit.error instanceof ApiError && commit.error.code === 'DUPLICATE_INVOICE' && !allowDuplicate) && <span className="text-bad">{errMsg(commit.error)}</span>}
          <Field label={t('Invoice number')} className="w-40">
            <Input value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} className="h-8" />
          </Field>
          <Button
            variant="primary"
            loading={commit.isPending}
            disabled={!invoiceNumber.trim() || undecided.length > 0 || invalid.length > 0 || !used.length || (duplicates.length > 0 && !allowDuplicate)}
            onClick={() => commit.mutate()}
          >
            {t('Receive {n} lines', { n: used.length })}
          </Button>
        </div>
      </div>

      <Modal open={picking != null} onClose={() => setPicking(null)} title={t('Choose the product')} size="lg">
        {picking != null && (
          <div className="space-y-3">
            <p className="whitespace-pre-wrap rounded-lg bg-surface-2 p-2 text-sm">{rows.find((m) => m.line.lineNo === picking)?.line.description}</p>
            <ProductPicker
              size="md"
              autoFocus
              placeholder={t('Search by name, SKU or barcode')}
              onSelect={(p: Product) => {
                decide(picking, { action: 'product', product: { id: p.id, sku: p.sku, name: p.name, barcode: p.barcode, status: p.status, unit: p.unit, purchasePrice: p.purchasePrice } });
                setPicking(null);
              }}
              onCode={async (code) => {
                const found = (await api.get<{ data: Product[] }>('/products/lookup', { code })).data;
                if (found.length === 1) {
                  const p = found[0];
                  decide(picking, { action: 'product', product: { id: p.id, sku: p.sku, name: p.name, barcode: p.barcode, status: p.status, unit: p.unit, purchasePrice: p.purchasePrice } });
                  setPicking(null);
                }
              }}
            />
          </div>
        )}
      </Modal>
    </Card>
  );
}

function LineChoice({
  match,
  decision,
  canCreate,
  onChange,
  onPick,
}: {
  match: LineMatch;
  decision: Decision;
  canCreate: boolean;
  onChange: (patch: Partial<Decision>) => void;
  onPick: () => void;
}) {
  const t = useT();
  if (match.status === 'error') return <Badge>{t('Skipped')}</Badge>;
  const value = decision.action === 'product' && decision.product ? `p${decision.product.id}` : decision.action;
  const options = match.candidates.filter((c) => c.product.id !== decision.product?.id || decision.action !== 'product');
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        {match.status === 'matched' && decision.action === 'product' && <Badge tone="ok">{t(BY_LABEL[match.by ?? 'description'])}</Badge>}
        {match.status === 'review' && <Badge tone="warn">{t('Check')}</Badge>}
        {match.status === 'new' && <Badge tone="brand">{t('Not in the warehouse')}</Badge>}
      </div>
      <Select
        className={clsx('h-9 text-sm', !decision.action && 'border-warn')}
        value={value}
        aria-label={t('Product for line {n}', { n: match.line.lineNo })}
        onChange={(e) => {
          const v = e.target.value;
          if (v === 'pick') return onPick();
          if (v.startsWith('p')) {
            const id = Number(v.slice(1));
            const c = match.candidates.find((x) => x.product.id === id)?.product ?? (decision.product?.id === id ? decision.product : null);
            return onChange({ action: 'product', product: c });
          }
          onChange({ action: v as Action });
        }}
      >
        <option value="">{t('— Decide —')}</option>
        {decision.action === 'product' && decision.product && (
          <option value={`p${decision.product.id}`}>
            {decision.product.sku} — {decision.product.name}
          </option>
        )}
        {options.map((c) => (
          <option key={c.product.id} value={`p${c.product.id}`}>
            {c.product.sku} — {c.product.name} ({t(BY_LABEL[c.by])}
            {c.score ? ` ${Math.round(c.score * 100)}%` : ''})
          </option>
        ))}
        <option value="pick">{t('Another product…')}</option>
        {canCreate && <option value="new">{t('New product (named as on the invoice)')}</option>}
        <option value="skip">{t('Skip this line')}</option>
      </Select>
      {decision.action === 'product' && decision.product && (
        <div className="flex items-center gap-2 text-xs text-muted">
          <Link to={`/products/${decision.product.id}`} className="whitespace-pre font-mono underline" target="_blank">
            {decision.product.sku}
          </Link>
          <span className="truncate">{decision.product.name}</span>
          <span className="tabular">· {t('cost now')} {fmtMoney(decision.product.purchasePrice)}</span>
          <button type="button" className="ml-auto inline-flex items-center gap-1 underline" onClick={onPick}>
            <Search className="size-3" /> {t('Change')}
          </button>
        </div>
      )}
      {decision.action === 'new' && (
        <div className="grid grid-cols-[1fr_120px_96px] gap-1.5">
          <Input className="h-8 text-xs" value={decision.newName} onChange={(e) => onChange({ newName: e.target.value })} aria-label={t('Name')} placeholder={t('Name')} />
          <Input className="h-8 font-mono text-xs" value={decision.newSku} onChange={(e) => onChange({ newSku: e.target.value })} aria-label="SKU" placeholder={t('SKU: automatic')} />
          <Input className="h-8 text-xs" inputMode="decimal" value={decision.newSellingPrice} onChange={(e) => onChange({ newSellingPrice: e.target.value })} aria-label={t('Selling price')} placeholder={t('Selling price')} />
        </div>
      )}
    </div>
  );
}
