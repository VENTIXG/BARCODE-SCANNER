import { useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as XLSX from 'xlsx';
import clsx from 'clsx';
import { AlertTriangle, ArrowRight, CheckCircle2, Download, FileSpreadsheet, FileUp, RotateCcw, Upload, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { api, download } from '../lib/api';
import { fmtDateTime, fmtMoney, fmtNumber, fmtQty, localDateToIso, parseDecimal, todayLocal } from '../lib/format';
import { useT } from '../lib/i18n';
import { FIELDS, mappingFor, parseSheet, type FieldKey, type ParsedSheet } from '../lib/importSheet';
import { sha256Hex } from '../lib/invoiceFile';
import { errMsg } from '../lib/queries';
import { Badge, Button, Card, CardHeader, Checkbox, EmptyState, ErrorBox, Input, PageHeader, Segmented, Select, Table, Tabs, Td, Th } from '../components/ui';


interface RowResult {
  rowNumber: number;
  status: 'new' | 'existing' | 'error';
  errors: string[];
  warnings: string[];
  match?: {
    id: number;
    sku: string;
    name: string;
    matchedBy: 'sku' | 'barcode' | 'name';
    current?: { quantity: number; purchasePrice: number; sellingPrice: number | null };
  };
}

interface PreviousImport {
  fileName: string | null;
  quantityMode: QuantityMode | null;
  stockRows: number;
  username: string | null;
  createdAt: string;
}

interface ValidateResponse {
  summary: { total: number; new: number; existing: number; existingWithQuantity: number; errors: number; warnings: number };
  previousImports: PreviousImport[];
  rows: RowResult[];
}

interface ImportSummary {
  imported: number;
  updated: number;
  skipped: number;
  errors: number;
  total: number;
  createdCategories: string[];
  createdSuppliers: string[];
  errorRows: { rowNumber: number; errors: string[] }[];
}

type Strategy = 'skip' | 'update' | 'ask';
/** The Quantity column for products that already exist. */
type QuantityMode = 'add' | 'set' | 'ignore';

export default function ImportExport() {
  const t = useT();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'export' ? 'export' : 'import';
  return (
    <div>
      <PageHeader title={t('Import / Export')} subtitle={t('Bulk import products from Excel and export reports')} />
      <Tabs
        value={tab}
        onChange={(v) => setParams(v === 'export' ? { tab: 'export' } : {}, { replace: true })}
        tabs={[
          { value: 'import', label: t('Import products') },
          { value: 'export', label: t('Export to Excel') },
        ]}
      />
      {tab === 'import' ? <ImportWizard /> : <ExportPanel />}
    </div>
  );
}

function Steps({ step }: { step: number }) {
  const t = useT();
  const labels = [t('Upload file'), t('Map columns'), t('Preview & validate'), t('Result')];
  return (
    <ol className="mb-5 flex flex-wrap items-center gap-2 text-sm">
      {labels.map((l, i) => (
        <li key={l} className="flex items-center gap-2">
          <span className={clsx('flex size-6 items-center justify-center rounded-full text-xs font-semibold', i < step ? 'bg-ok text-white' : i === step ? 'bg-brand text-white' : 'bg-surface-3 text-muted')}>
            {i < step ? '✓' : i + 1}
          </span>
          <span className={i === step ? 'font-medium text-fg' : 'text-muted'}>{l}</span>
          {i < labels.length - 1 && <ArrowRight className="size-3.5 text-muted" />}
        </li>
      ))}
    </ol>
  );
}

function ImportWizard() {
  const t = useT();
  const qc = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const workbook = useRef<XLSX.WorkBook | null>(null);
  const [step, setStep] = useState(0);
  const [parsed, setParsed] = useState<ParsedSheet | null>(null);
  const [mapping, setMapping] = useState<(FieldKey | '')[]>([]);
  const [parseError, setParseError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  // Existing products get the file's values (empty cells keep what is stored).
  const [strategy, setStrategy] = useState<Strategy>('update');
  // No default: what the quantity of an existing product means is asked, never assumed.
  const [quantityMode, setQuantityMode] = useState<QuantityMode | null>(null);
  const [allowDuplicate, setAllowDuplicate] = useState(false);
  const [fileHash, setFileHash] = useState<string | null>(null);
  const [createMissing, setCreateMissing] = useState(true);
  const [decisions, setDecisions] = useState<Record<string, 'skip' | 'update'>>({});
  const [filter, setFilter] = useState<'all' | 'new' | 'existing' | 'error'>('all');
  const [validation, setValidation] = useState<ValidateResponse | null>(null);
  const [result, setResult] = useState<ImportSummary | null>(null);

  const reset = () => {
    setStep(0);
    setParsed(null);
    setValidation(null);
    setResult(null);
    setDecisions({});
    setQuantityMode(null);
    setAllowDuplicate(false);
    setFileHash(null);
    setParseError(null);
    workbook.current = null;
  };

  const loadFile = async (file: File) => {
    setParseError(null);
    if (!/\.(xlsx|xls|csv)$/i.test(file.name)) {
      setParseError(t('Unsupported file type. Please upload .xlsx, .xls or .csv'));
      return;
    }
    try {
      const buf = await file.arrayBuffer();
      // CSV: cells stay text, so leading zeros of codes and decimal commas are kept (the server reads numbers).
      const wb = XLSX.read(buf, { type: 'array', cellDates: false, codepage: 65001, raw: /\.csv$/i.test(file.name) });
      workbook.current = wb;
      const p = parseSheet(wb, file.name, wb.SheetNames[0]);
      if (!p.rows.length) throw new Error(t('The file has no data rows'));
      // Recognises the same file later, so its quantities are not added to stock twice unnoticed.
      setFileHash(await sha256Hex(new Uint8Array(buf)));
      setParsed(p);
      setMapping(mappingFor(p));
      setStep(1);
    } catch (e) {
      setParseError(errMsg(e));
    }
  };

  const changeSheet = (sheet: string) => {
    if (!workbook.current || !parsed) return;
    const p = parseSheet(workbook.current, parsed.fileName, sheet);
    setParsed(p);
    setMapping(mappingFor(p));
  };

  /** Build API rows from the mapping; rowNumber = Excel row number. */
  const apiRows = useMemo(() => {
    if (!parsed) return [];
    return parsed.rows.map((r, i) => {
      const out: Record<string, unknown> = { rowNumber: parsed.rowNumbers[i] };
      mapping.forEach((field, col) => {
        if (!field) return;
        const v = r[col];
        out[field] = v === undefined ? null : v;
      });
      return out;
    });
  }, [parsed, mapping]);

  const mappedFields = new Set(mapping.filter(Boolean));
  const missingRequired = FIELDS.filter((f) => f.key === 'sku' && !mappedFields.has(f.key));

  const validate = useMutation({
    mutationFn: () => api.post<{ data: ValidateResponse }>('/import/products/validate', { rows: apiRows, fileHash }).then((r) => r.data),
    onSuccess: (v) => {
      setValidation(v);
      setFilter(v.summary.errors ? 'error' : 'all');
      setStep(2);
    },
  });

  const commit = useMutation({
    mutationFn: () =>
      api
        .post<{ data: ImportSummary }>('/import/products/commit', {
          rows: apiRows,
          fileName: parsed?.fileName,
          fileHash,
          options: { duplicateStrategy: strategy, decisions, quantityMode: needsQuantityChoice ? quantityMode : undefined, createMissing, allowDuplicate },
        })
        .then((r) => r.data),
    onSuccess: (r) => {
      setResult(r);
      setStep(3);
      void qc.invalidateQueries();
    },
  });

  const rowsByNumber = useMemo(() => new Map(apiRows.map((r) => [r.rowNumber as number, r])), [apiRows]);
  const toImport = validation ? validation.summary.new + (strategy === 'update' ? validation.summary.existing : strategy === 'ask' ? Object.values(decisions).filter((d) => d === 'update').length : 0) : 0;
  // Existing products that get a quantity from the file: the person says what the quantity means.
  const updates = (r: RowResult) => r.status === 'existing' && (strategy === 'update' || (strategy === 'ask' && decisions[String(r.rowNumber)] === 'update'));
  const hasQuantity = (r: RowResult) => {
    const q = rowsByNumber.get(r.rowNumber)?.quantity;
    return q != null && String(q).trim() !== '';
  };
  const quantityRows = validation ? validation.rows.filter((r) => updates(r) && hasQuantity(r)).length : 0;
  const needsQuantityChoice = quantityRows > 0;
  const stockedBefore = validation?.previousImports.filter((p) => p.stockRows > 0) ?? [];
  const duplicateBlocked = needsQuantityChoice && quantityMode === 'add' && stockedBefore.length > 0 && !allowDuplicate;
  const commitBlocker =
    toImport === 0 ? null : needsQuantityChoice && !quantityMode ? t('Choose what the quantities of existing products mean') : duplicateBlocked ? t('Confirm adding this file to stock again') : null;

  return (
    <div>
      <Steps step={step} />

      {step === 0 && (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
          <Card
            className={clsx('flex flex-col items-center justify-center border-2 border-dashed px-6 py-16 text-center transition-colors', dragging ? 'border-brand bg-brand-soft' : 'border-line-strong')}
            onDragOver={(e) => (e.preventDefault(), setDragging(true))}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const f = e.dataTransfer.files[0];
              if (f) void loadFile(f);
            }}
          >
            <div className="mb-3 flex size-12 items-center justify-center rounded-xl bg-brand-soft text-brand-fg">
              <FileUp className="size-6" />
            </div>
            <p className="font-medium">{t('Drag & drop an Excel or CSV file here')}</p>
            <p className="mt-1 text-sm text-muted">.xlsx · .xls · .csv</p>
            <Button className="mt-4" variant="primary" icon={<Upload className="size-4" />} onClick={() => fileInput.current?.click()}>
              {t('Choose file')}
            </Button>
            <input ref={fileInput} type="file" accept=".xlsx,.xls,.csv" hidden onChange={(e) => e.target.files?.[0] && void loadFile(e.target.files[0])} />
            {parseError && <div className="mt-4 w-full max-w-md"><ErrorBox error={parseError} /></div>}
          </Card>
          <Card className="p-5">
            <FileSpreadsheet className="size-6 text-ok" />
            <h3 className="mt-2 font-semibold">{t('Excel template')}</h3>
            <p className="mt-1 text-sm text-muted">{t('Download a ready-made template with the correct columns and instructions.')}</p>
            <Button className="mt-4 w-full" icon={<Download className="size-4" />} onClick={() => download('/import/template').catch((e) => toast.error(errMsg(e)))}>
              {t('Download Excel Template')}
            </Button>
            <button type="button" className="mt-2 w-full text-center text-xs text-brand-fg underline" onClick={() => download('/import/template', { layout: 'full' }).catch((e) => toast.error(errMsg(e)))}>
              {t('Template with every product field')}
            </button>
            <div className="mt-5 border-t border-line pt-4 text-xs text-muted">
              <p className="mb-1 font-medium text-fg-2">{t('Standard columns')}</p>
              <p className="font-mono">A {t('SKU')} · B {t('Barcode Number')} · C {t('Quantity')} · D {t('Purchase Price')} · E {t('Selling Price')}</p>
              <p className="mt-2">{t('SKUs and descriptions may contain spaces. Column A may hold the SKU or the product description. An empty selling price stays empty.')}</p>
              <p className="mb-1 mt-3 font-medium text-fg-2">{t('Also accepted')}</p>
              <p>{FIELDS.map((f) => t(f.label)).join(' · ')}</p>
              <p className="mt-3">{t('Columns are detected automatically (English or Greek headers); you can adjust the mapping in the next step.')}</p>
            </div>
          </Card>
        </div>
      )}

      {step === 1 && parsed && (
        <Card>
          <CardHeader
            title={t('Map columns')}
            subtitle={t('{file} — {n} data rows', { file: parsed.fileName, n: fmtNumber(parsed.rows.length) })}
            actions={
              parsed.sheets.length > 1 && (
                <Select className="w-auto" value={parsed.sheet} onChange={(e) => changeSheet(e.target.value)} aria-label={t('Sheet')}>
                  {parsed.sheets.map((s) => <option key={s}>{s}</option>)}
                </Select>
              )
            }
          />
          <Table>
            <thead>
              <tr>
                <Th>{t('Column in file')}</Th>
                <Th>{t('Import as')}</Th>
                <Th>{t('Sample values')}</Th>
              </tr>
            </thead>
            <tbody>
              {parsed.headers.map((h, i) => (
                <tr key={i}>
                  <Td className="font-medium">{h}</Td>
                  <Td>
                    <Select
                      className={clsx('w-52', mapping[i] && 'border-ok')}
                      value={mapping[i]}
                      onChange={(e) => {
                        const v = e.target.value as FieldKey | '';
                        setMapping((m) => m.map((x, j) => (j === i ? v : v && x === v ? '' : x)));
                      }}
                    >
                      <option value="">{t('— Ignore —')}</option>
                      {FIELDS.map((f) => <option key={f.key} value={f.key}>{t(f.label)}{f.key === 'sku' ? ' *' : ''}</option>)}
                    </Select>
                  </Td>
                  <Td className="max-w-[360px] truncate font-mono text-xs text-fg-2">
                    {parsed.rows.slice(0, 3).map((r) => (r[i] == null ? '∅' : String(r[i]))).join(' · ')}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <div className="grid gap-4 border-t border-line p-4 md:grid-cols-2">
            {/* Not a <label>: a label would name (and click) the first button of the group. */}
            <div role="group" aria-labelledby="strategy-label">
              <span id="strategy-label" className="mb-1.5 block text-xs font-medium text-fg-2">{t('If the SKU or barcode already exists')}</span>
              <Segmented<Strategy>
                value={strategy}
                onChange={setStrategy}
                className="flex w-full"
                options={[
                  { value: 'update', label: t('Update existing') },
                  { value: 'skip', label: t('Skip') },
                  { value: 'ask', label: t('Ask me') },
                ]}
              />
              <span className="mt-1 block text-xs text-muted">{t('Update: the file’s quantity, prices and other values are saved; empty cells keep what is stored.')}</span>
            </div>
            <div className="pt-6">
              <Checkbox checked={createMissing} onChange={setCreateMissing} label={t('Create missing categories and suppliers')} />
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line p-4">
            <Button icon={<RotateCcw className="size-4" />} onClick={reset}>{t('Choose another file')}</Button>
            <div className="flex items-center gap-3">
              {missingRequired.length > 0 && <span className="text-sm text-bad">{t('Map the SKU column to continue')}</span>}
              {validate.error && <span className="text-sm text-bad">{errMsg(validate.error)}</span>}
              <Button variant="primary" disabled={missingRequired.length > 0} loading={validate.isPending} onClick={() => validate.mutate()}>
                {t('Validate {n} rows', { n: fmtNumber(apiRows.length) })}
              </Button>
            </div>
          </div>
        </Card>
      )}

      {step === 2 && validation && (
        <Card>
          <div className="grid grid-cols-2 gap-3 border-b border-line p-4 sm:grid-cols-4">
            {[
              { label: t('Rows'), value: validation.summary.total, tone: 'text-fg' },
              { label: t('New products'), value: validation.summary.new, tone: 'text-ok' },
              { label: t('Already exist'), value: validation.summary.existing, tone: 'text-brand-fg' },
              { label: t('With errors'), value: validation.summary.errors, tone: 'text-bad' },
            ].map((s) => (
              <div key={s.label} className="rounded-lg bg-surface-2 p-3">
                <div className="text-[11px] font-semibold text-muted uppercase">{s.label}</div>
                <div className={`tabular text-2xl font-semibold ${s.tone}`}>{fmtNumber(s.value)}</div>
              </div>
            ))}
          </div>
          {validation.previousImports.length > 0 && (
            <div className="mx-4 mt-4 flex items-start gap-2 rounded-lg border border-warn/40 bg-warn-soft p-3 text-sm">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" />
              <div>
                <p className="font-medium">
                  {t('This file was already imported on {date}{by}.', {
                    date: fmtDateTime(validation.previousImports[0].createdAt),
                    by: validation.previousImports[0].username ? ` (${validation.previousImports[0].username})` : '',
                  })}
                </p>
                {needsQuantityChoice && quantityMode === 'add' && stockedBefore.length > 0 && (
                  <div className="mt-2">
                    <Checkbox checked={allowDuplicate} onChange={setAllowDuplicate} label={t('Add its quantities to stock again')} />
                  </div>
                )}
              </div>
            </div>
          )}
          {needsQuantityChoice && (
            <QuantityChoice rows={quantityRows} value={quantityMode} onChange={setQuantityMode} />
          )}
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-3">
            <Segmented
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'all', label: t('All') },
                { value: 'new', label: t('New') },
                { value: 'existing', label: t('Existing') },
                { value: 'error', label: t('Errors') },
              ]}
            />
            {strategy === 'ask' && validation.summary.existing > 0 && (
              <div className="flex gap-2">
                <Button size="sm" onClick={() => setDecisions(Object.fromEntries(validation.rows.filter((r) => r.status === 'existing').map((r) => [String(r.rowNumber), 'update'])))}>
                  {t('Update all existing')}
                </Button>
                <Button size="sm" onClick={() => setDecisions({})}>{t('Skip all existing')}</Button>
              </div>
            )}
          </div>
          <PreviewTable
            rows={validation.rows.filter((r) => filter === 'all' || r.status === filter)}
            data={rowsByNumber}
            strategy={strategy}
            decisions={decisions}
            quantityMode={quantityMode}
            onDecision={(n, d) => setDecisions((s) => ({ ...s, [String(n)]: d }))}
          />
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line p-4">
            <Button onClick={() => setStep(1)}>{t('Back to mapping')}</Button>
            <div className="flex items-center gap-3">
              {validation.summary.errors > 0 && (
                <span className="flex items-center gap-1 text-sm text-warn">
                  <AlertTriangle className="size-4" /> {t('{n} rows with errors will be skipped', { n: validation.summary.errors })}
                </span>
              )}
              {commitBlocker && <span className="text-sm text-warn">{commitBlocker}</span>}
              {commit.error && <span className="text-sm text-bad">{errMsg(commit.error)}</span>}
              <Button variant="primary" disabled={toImport === 0 || !!commitBlocker} loading={commit.isPending} onClick={() => commit.mutate()}>
                {t('Import {n} valid rows', { n: fmtNumber(toImport) })}
              </Button>
            </div>
          </div>
        </Card>
      )}

      {step === 3 && result && (
        <Card className="p-6">
          <div className="flex items-center gap-3">
            <CheckCircle2 className="size-8 text-ok" />
            <div>
              <h2 className="text-lg font-semibold">{t('Import completed')}</h2>
              <p className="text-sm text-muted">{parsed?.fileName}</p>
            </div>
          </div>
          <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              { label: t('Imported'), value: result.imported, tone: 'text-ok' },
              { label: t('Updated'), value: result.updated, tone: 'text-brand-fg' },
              { label: t('Skipped'), value: result.skipped, tone: 'text-fg-2' },
              { label: t('Errors'), value: result.errors, tone: 'text-bad' },
            ].map((s) => (
              <div key={s.label} className="rounded-xl border border-line p-4">
                <div className="text-xs font-semibold text-muted uppercase">{s.label}</div>
                <div className={`tabular text-3xl font-semibold ${s.tone}`}>{fmtNumber(s.value)}</div>
              </div>
            ))}
          </div>
          {(result.createdCategories.length > 0 || result.createdSuppliers.length > 0) && (
            <div className="mt-4 text-sm text-fg-2">
              {result.createdCategories.length > 0 && <p>{t('New categories')}: {result.createdCategories.join(', ')}</p>}
              {result.createdSuppliers.length > 0 && <p>{t('New suppliers')}: {result.createdSuppliers.join(', ')}</p>}
            </div>
          )}
          {result.errorRows.length > 0 && (
            <div className="mt-4 max-h-64 overflow-y-auto rounded-lg border border-bad/30">
              {result.errorRows.map((r) => (
                <div key={r.rowNumber} className="flex gap-3 border-b border-line px-3 py-2 text-sm last:border-0">
                  <span className="font-mono text-xs text-muted">{t('Row')} {r.rowNumber}</span>
                  <span className="text-bad">{r.errors.join('; ')}</span>
                </div>
              ))}
            </div>
          )}
          <div className="mt-6 flex gap-2">
            <Button icon={<RotateCcw className="size-4" />} onClick={reset}>{t('Import another file')}</Button>
            <Link to="/products"><Button variant="primary">{t('View products')}</Button></Link>
          </div>
        </Card>
      )}
    </div>
  );
}

/** What the Quantity column means for products that already exist; asked, never assumed. */
function QuantityChoice({ rows, value, onChange }: { rows: number; value: QuantityMode | null; onChange: (v: QuantityMode) => void }) {
  const t = useT();
  const options: { value: QuantityMode; label: string; hint: string }[] = [
    { value: 'add', label: t('Add to stock'), hint: t('A delivery: the quantity is added to the current stock (10 + 5 = 15).') },
    { value: 'set', label: t('Set the stock'), hint: t('A stock count: the stock becomes the quantity in the file (10 → 5).') },
    { value: 'ignore', label: t('Leave the stock'), hint: t('Only prices and the other values are updated.') },
  ];
  return (
    <div className={clsx('mx-4 mt-4 rounded-lg border p-3', value ? 'border-line' : 'border-warn/50 bg-warn-soft/40')}>
      <p className="text-sm font-medium">{t('{n} existing products have a quantity in the file. What does it mean?', { n: fmtNumber(rows) })}</p>
      <div className="mt-2 grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label={t('Quantity of existing products')}>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={value === o.value}
            onClick={() => onChange(o.value)}
            className={clsx(
              'rounded-lg border p-3 text-left transition-colors',
              value === o.value ? 'border-brand bg-brand-soft' : 'border-line bg-surface hover:border-line-strong',
            )}
          >
            <span className="block text-sm font-semibold">{o.label}</span>
            <span className="mt-0.5 block text-xs text-muted">{o.hint}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function PreviewTable({
  rows,
  data,
  strategy,
  decisions,
  quantityMode,
  onDecision,
}: {
  rows: RowResult[];
  data: Map<number, Record<string, unknown>>;
  strategy: Strategy;
  decisions: Record<string, 'skip' | 'update'>;
  quantityMode: QuantityMode | null;
  onDecision: (row: number, d: 'skip' | 'update') => void;
}) {
  const t = useT();
  const LIMIT = 500;
  if (!rows.length) return <EmptyState title={t('No rows in this view')} />;
  const cell = (v: unknown) => (v == null || v === '' ? <span className="text-muted">—</span> : String(v));
  const empty = (v: unknown) => v == null || String(v).trim() === '';
  const updates = (r: RowResult) => r.status === 'existing' && (strategy === 'update' || (strategy === 'ask' && decisions[String(r.rowNumber)] === 'update'));
  /** Under the file's value: what is stored now and what it becomes. */
  const stockNote = (r: RowResult, q: unknown) => {
    const cur = r.match?.current;
    if (!cur || !updates(r)) return null;
    const n = parseDecimal(String(q ?? ''));
    if (empty(q) || quantityMode === 'ignore' || !quantityMode || Number.isNaN(n)) return t('stock {n}', { n: fmtQty(cur.quantity) });
    return `${fmtQty(cur.quantity)} → ${fmtQty(quantityMode === 'add' ? cur.quantity + n : n)}`;
  };
  const priceNote = (r: RowResult, v: unknown, now: number | null | undefined) => {
    if (!r.match?.current || !updates(r)) return null;
    return empty(v) ? t('keeps {p}', { p: fmtMoney(now) }) : t('now {p}', { p: fmtMoney(now) });
  };
  const note = (s: string | null) => s && <div className="text-[11px] whitespace-nowrap text-muted">{s}</div>;
  return (
    <div className="max-h-[60vh] overflow-auto">
      <Table>
        <thead>
          <tr>
            <Th>{t('Row')}</Th>
            <Th>{t('Status')}</Th>
            <Th>SKU</Th>
            <Th>{t('Barcode')}</Th>
            <Th>{t('Product Name')}</Th>
            <Th align="right">{t('Quantity')}</Th>
            <Th align="right">{t('Purchase Price')}</Th>
            <Th align="right">{t('Selling Price')}</Th>
            <Th>{t('Messages')}</Th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, LIMIT).map((r) => {
            const d = data.get(r.rowNumber) ?? {};
            return (
              <tr key={r.rowNumber} className={r.status === 'error' ? 'bg-bad-soft/60' : ''}>
                <Td className="font-mono text-xs text-muted">{r.rowNumber}</Td>
                <Td>
                  {r.status === 'new' && <Badge tone="ok">{t('New')}</Badge>}
                  {r.status === 'error' && <Badge tone="bad" icon={<XCircle className="size-3" />}>{t('Error')}</Badge>}
                  {r.status === 'existing' &&
                    (strategy === 'ask' ? (
                      <Select className="h-8 w-32 text-xs" value={decisions[String(r.rowNumber)] ?? 'skip'} onChange={(e) => onDecision(r.rowNumber, e.target.value as 'skip')}>
                        <option value="skip">{t('Skip')}</option>
                        <option value="update">{t('Update')}</option>
                      </Select>
                    ) : (
                      <Badge tone="brand">{strategy === 'update' ? t('Update') : t('Skip')}</Badge>
                    ))}
                </Td>
                <Td className="whitespace-pre font-mono text-xs">{cell(d.sku)}</Td>
                <Td className="whitespace-pre font-mono text-xs">{cell(d.barcode)}</Td>
                <Td className="max-w-[240px] truncate">{cell(d.name ?? r.match?.name)}</Td>
                <Td align="right" className="tabular">{cell(d.quantity)}{note(stockNote(r, d.quantity))}</Td>
                <Td align="right" className="tabular">{cell(d.purchasePrice)}{note(priceNote(r, d.purchasePrice, r.match?.current?.purchasePrice))}</Td>
                <Td align="right" className="tabular">{cell(d.sellingPrice)}{note(priceNote(r, d.sellingPrice, r.match?.current?.sellingPrice))}</Td>
                <Td className="text-xs">
                  {r.errors.map((e) => <div key={e} className="text-bad">{t(e)}</div>)}
                  {r.warnings.map((w) => <div key={w} className="text-warn">{t(w)}</div>)}
                  {r.match && (
                    <div className="text-muted">
                      {t('Existing')}: <Link to={`/products/${r.match.id}`} className="whitespace-pre underline">{r.match.sku}</Link>
                      {r.match.matchedBy === 'name' && <> · {t('found by description')}</>}
                      {r.match.matchedBy === 'barcode' && <> · {t('found by barcode')}</>}
                    </div>
                  )}
                </Td>
              </tr>
            );
          })}
        </tbody>
      </Table>
      {rows.length > LIMIT && <p className="p-3 text-center text-xs text-muted">{t('Showing first {n} rows', { n: LIMIT })}</p>}
    </div>
  );
}

function ExportPanel() {
  const t = useT();
  const [from, setFrom] = useState(todayLocal(-30));
  const [to, setTo] = useState(todayLocal());
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (key: string, url: string, params?: Record<string, string | undefined>) => {
    setBusy(key);
    try {
      await download(url, params);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(null);
    }
  };
  const range = { from: from ? localDateToIso(from) : undefined, to: to ? localDateToIso(to, true) : undefined };
  const dateRange = { from: from || undefined, to: to || undefined };

  const simple = [
    { key: 'products', title: t('All products'), desc: t('SKU | Barcode Number | Quantity | Purchase Price | Selling Price (edit and re-import).'), url: '/export/products' },
    { key: 'products-full', title: t('All products — every field'), desc: t('Name, description, category, supplier, location, prices and status as well.'), url: '/export/products-full' },
    { key: 'inventory', title: t('Current inventory'), desc: t('Stock per product with location and value, sorted by location.'), url: '/export/inventory' },
    { key: 'low', title: t('Low stock products'), desc: t('Products at or below minimum stock, with suggested order quantity.'), url: '/export/low-stock' },
    { key: 'cat', title: t('Products by category'), desc: t('Summary sheet plus one sheet per category.'), url: '/export/grouped/category' },
    { key: 'sup', title: t('Products by supplier'), desc: t('Summary sheet plus one sheet per supplier.'), url: '/export/grouped/supplier' },
  ];
  const ranged = [
    { key: 'moves', title: t('Stock movement history'), desc: t('All inventory transactions in the period.'), url: '/export/transactions', params: range },
    { key: 'in', title: t('Stock IN'), desc: t('Stock-in transactions in the period.'), url: '/export/transactions', params: { ...range, preset: 'stock-in' } },
    { key: 'out', title: t('Stock OUT'), desc: t('Stock-out transactions in the period.'), url: '/export/transactions', params: { ...range, preset: 'stock-out' } },
    { key: 'rcv', title: t('Goods receipts (lines)'), desc: t('Receipt documents with supplier and invoice.'), url: '/export/documents/receipts', params: dateRange },
    { key: 'dsp', title: t('Dispatches (lines)'), desc: t('Dispatch documents with customer and reference.'), url: '/export/documents/dispatches', params: dateRange },
  ];

  const Row = ({ k, title, desc, onClick }: { k: string; title: string; desc: string; onClick: () => void }) => (
    <div className="flex items-center gap-3 px-4 py-3">
      <FileSpreadsheet className="size-5 shrink-0 text-ok" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{title}</div>
        <div className="text-xs text-muted">{desc}</div>
      </div>
      <Button size="sm" icon={<Download className="size-3.5" />} loading={busy === k} onClick={onClick}>
        .xlsx
      </Button>
    </div>
  );

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader title={t('Catalog & stock')} subtitle={t('Current state')} />
        <div className="divide-y divide-line">
          {simple.map((e) => <Row key={e.key} k={e.key} title={e.title} desc={e.desc} onClick={() => void run(e.key, e.url)} />)}
        </div>
      </Card>
      <Card>
        <CardHeader
          title={t('Movements')}
          subtitle={t('For a date range')}
          actions={
            <div className="flex items-center gap-1.5">
              <Input type="date" className="h-8 w-auto text-xs" value={from} onChange={(e) => setFrom(e.target.value)} aria-label={t('From')} />
              <span className="text-muted">–</span>
              <Input type="date" className="h-8 w-auto text-xs" value={to} onChange={(e) => setTo(e.target.value)} aria-label={t('To')} />
            </div>
          }
        />
        <div className="divide-y divide-line">
          {ranged.map((e) => <Row key={e.key} k={e.key} title={e.title} desc={e.desc} onClick={() => void run(e.key, e.url, e.params)} />)}
        </div>
      </Card>
    </div>
  );
}
