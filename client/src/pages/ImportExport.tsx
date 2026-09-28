import { useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as XLSX from 'xlsx';
import clsx from 'clsx';
import { AlertTriangle, ArrowRight, CheckCircle2, Download, FileSpreadsheet, FileUp, RotateCcw, Upload, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { api, download } from '../lib/api';
import { fmtNumber, localDateToIso, todayLocal } from '../lib/format';
import { useT } from '../lib/i18n';
import { errMsg } from '../lib/queries';
import { Badge, Button, Card, CardHeader, Checkbox, EmptyState, ErrorBox, Field, Input, PageHeader, Segmented, Select, Table, Tabs, Td, Th } from '../components/ui';

// ---- Column mapping -------------------------------------------------------------

const FIELDS = [
  { key: 'sku', label: 'SKU', required: true },
  { key: 'barcode', label: 'Barcode' },
  { key: 'name', label: 'Product Name', required: true },
  { key: 'description', label: 'Description' },
  { key: 'category', label: 'Category' },
  { key: 'supplier', label: 'Supplier' },
  { key: 'unit', label: 'Unit' },
  { key: 'quantity', label: 'Quantity' },
  { key: 'minStock', label: 'Minimum Stock' },
  { key: 'location', label: 'Location' },
  { key: 'purchasePrice', label: 'Purchase Price' },
  { key: 'sellingPrice', label: 'Selling Price' },
  { key: 'status', label: 'Status' },
] as const;
type FieldKey = (typeof FIELDS)[number]['key'];

/** Header synonyms (English + Greek) used for automatic column detection. */
const SYNONYMS: Record<FieldKey, string[]> = {
  sku: ['sku', 'code', 'item code', 'product code', 'article', 'κωδικος', 'κωδικος ειδους', 'κωδ', 'κωδικος προιοντος'],
  barcode: ['barcode', 'bar code', 'ean', 'ean13', 'upc', 'gtin', 'ean upc', 'barcode ean', 'γραμμωτος κωδικας'],
  name: ['product name', 'name', 'item name', 'product', 'item', 'title', 'ονομα', 'ονομασια', 'ονομα προιοντος', 'ειδος', 'περιγραφη ειδους'],
  description: ['description', 'details', 'περιγραφη', 'σχολια'],
  category: ['category', 'group', 'product group', 'κατηγορια', 'ομαδα'],
  supplier: ['supplier', 'vendor', 'manufacturer', 'προμηθευτης'],
  unit: ['unit', 'uom', 'unit of measure', 'μοναδα', 'μμ', 'μοναδα μετρησης'],
  quantity: ['quantity', 'qty', 'stock', 'on hand', 'current stock', 'ποσοτητα', 'αποθεμα', 'ποσ'],
  minStock: ['minimum stock', 'min stock', 'min', 'minimum', 'reorder level', 'reorder point', 'ελαχιστο', 'ελαχιστο αποθεμα'],
  location: ['location', 'bin', 'shelf', 'position', 'θεση', 'ραφι', 'θεση αποθηκης'],
  purchasePrice: ['purchase price', 'cost', 'cost price', 'buy price', 'unit cost', 'τιμη αγορας', 'κοστος'],
  sellingPrice: ['selling price', 'price', 'sale price', 'retail price', 'sell price', 'τιμη πωλησης', 'τιμη λιανικης', 'τιμη'],
  status: ['status', 'active', 'state', 'κατασταση'],
};

const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

function autoMap(headers: string[]): (FieldKey | '')[] {
  const result: (FieldKey | '')[] = headers.map(() => '');
  const used = new Set<FieldKey>();
  // Pass 1: exact synonym matches; pass 2: header contains a synonym.
  for (const pass of [0, 1]) {
    headers.forEach((h, i) => {
      if (result[i]) return;
      const n = norm(h);
      if (!n) return;
      for (const f of FIELDS) {
        if (used.has(f.key)) continue;
        const hit = SYNONYMS[f.key].some((s) => (pass === 0 ? n === s : n.includes(s) && s.length > 2));
        if (hit) {
          result[i] = f.key;
          used.add(f.key);
          break;
        }
      }
    });
  }
  return result;
}

interface Parsed {
  fileName: string;
  sheets: string[];
  sheet: string;
  headerRow: number; // 0-based index in the sheet
  headers: string[];
  rows: unknown[][];
}

function parseSheet(wb: XLSX.WorkBook, fileName: string, sheet: string): Parsed {
  const data = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheet], { header: 1, raw: true, defval: null, blankrows: false });
  // The header is the first row with at least two non-empty cells.
  let headerRow = data.findIndex((r) => r.filter((c) => c !== null && String(c).trim() !== '').length >= 2);
  if (headerRow < 0) headerRow = 0;
  const width = Math.max(0, ...data.map((r) => r.length));
  const headers = Array.from({ length: width }, (_, i) => {
    const h = data[headerRow]?.[i];
    return h == null || String(h).trim() === '' ? `Column ${i + 1}` : String(h).trim();
  });
  const rows = data.slice(headerRow + 1).filter((r) => r.some((c) => c !== null && String(c).trim() !== ''));
  return { fileName, sheets: wb.SheetNames, sheet, headerRow, headers, rows };
}

interface RowResult {
  rowNumber: number;
  status: 'new' | 'existing' | 'error';
  errors: string[];
  warnings: string[];
  match?: { id: number; sku: string; name: string; matchedBy: 'sku' | 'barcode' };
}

interface ValidateResponse {
  summary: { total: number; new: number; existing: number; errors: number; warnings: number };
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
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [mapping, setMapping] = useState<(FieldKey | '')[]>([]);
  const [parseError, setParseError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [strategy, setStrategy] = useState<Strategy>('skip');
  const [quantityMode, setQuantityMode] = useState<'ignore' | 'set' | 'add'>('ignore');
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
      const wb = XLSX.read(buf, { type: 'array', cellDates: false, codepage: 65001 });
      workbook.current = wb;
      const p = parseSheet(wb, file.name, wb.SheetNames[0]);
      if (!p.rows.length) throw new Error(t('The file has no data rows'));
      setParsed(p);
      setMapping(autoMap(p.headers));
      setStep(1);
    } catch (e) {
      setParseError(errMsg(e));
    }
  };

  const changeSheet = (sheet: string) => {
    if (!workbook.current || !parsed) return;
    const p = parseSheet(workbook.current, parsed.fileName, sheet);
    setParsed(p);
    setMapping(autoMap(p.headers));
  };

  /** Build API rows from the mapping; rowNumber = Excel row number. */
  const apiRows = useMemo(() => {
    if (!parsed) return [];
    return parsed.rows.map((r, i) => {
      const out: Record<string, unknown> = { rowNumber: parsed.headerRow + i + 2 };
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
    mutationFn: () => api.post<{ data: ValidateResponse }>('/import/products/validate', { rows: apiRows }).then((r) => r.data),
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
          options: { duplicateStrategy: strategy, decisions, quantityMode, createMissing },
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
            <div className="mt-5 border-t border-line pt-4 text-xs text-muted">
              <p className="mb-1 font-medium text-fg-2">{t('Supported columns')}</p>
              <p>{FIELDS.map((f) => f.label).join(' · ')}</p>
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
          <div className="grid gap-4 border-t border-line p-4 md:grid-cols-3">
            <Field label={t('If the SKU or barcode already exists')}>
              <Segmented<Strategy>
                value={strategy}
                onChange={setStrategy}
                className="flex w-full"
                options={[
                  { value: 'skip', label: t('Skip') },
                  { value: 'update', label: t('Update existing') },
                  { value: 'ask', label: t('Ask me') },
                ]}
              />
            </Field>
            <Field label={t('Quantity column for existing products')} hint={t('Every stock change is recorded as a transaction')}>
              <Select value={quantityMode} onChange={(e) => setQuantityMode(e.target.value as 'ignore')}>
                <option value="ignore">{t("Don't change stock")}</option>
                <option value="set">{t('Set as current stock (adjustment)')}</option>
                <option value="add">{t('Add to stock (Stock IN)')}</option>
              </Select>
            </Field>
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
              {commit.error && <span className="text-sm text-bad">{errMsg(commit.error)}</span>}
              <Button variant="primary" disabled={toImport === 0} loading={commit.isPending} onClick={() => commit.mutate()}>
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

function PreviewTable({
  rows,
  data,
  strategy,
  decisions,
  onDecision,
}: {
  rows: RowResult[];
  data: Map<number, Record<string, unknown>>;
  strategy: Strategy;
  decisions: Record<string, 'skip' | 'update'>;
  onDecision: (row: number, d: 'skip' | 'update') => void;
}) {
  const t = useT();
  const LIMIT = 500;
  if (!rows.length) return <EmptyState title={t('No rows in this view')} />;
  const cell = (v: unknown) => (v == null || v === '' ? <span className="text-muted">—</span> : String(v));
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
                <Td className="font-mono text-xs">{cell(d.sku)}</Td>
                <Td className="font-mono text-xs">{cell(d.barcode)}</Td>
                <Td className="max-w-[240px] truncate">{cell(d.name ?? r.match?.name)}</Td>
                <Td align="right" className="tabular">{cell(d.quantity)}</Td>
                <Td className="text-xs">
                  {r.errors.map((e) => <div key={e} className="text-bad">{e}</div>)}
                  {r.warnings.map((w) => <div key={w} className="text-warn">{w}</div>)}
                  {r.match && <div className="text-muted">{t('Existing')}: <Link to={`/products/${r.match.id}`} className="underline">{r.match.sku}</Link></div>}
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
    { key: 'products', title: t('All products'), desc: t('Every product, in the import template layout (edit and re-import).'), url: '/export/products' },
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
