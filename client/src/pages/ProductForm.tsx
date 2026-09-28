import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError, api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtQty } from '../lib/format';
import { useT } from '../lib/i18n';
import { errMsg, useCategories, useLocations, useSuppliers } from '../lib/queries';
import type { Product } from '../lib/types';
import { Button, Card, CardHeader, ConfirmDialog, ErrorBox, Field, IconButton, Input, LoadingBlock, Modal, PageHeader, Segmented, Select, Textarea } from '../components/ui';

interface FormState {
  sku: string;
  barcode: string;
  name: string;
  description: string;
  categoryId: string;
  supplierId: string;
  unit: string;
  minStock: string;
  purchasePrice: string;
  sellingPrice: string;
  status: 'ACTIVE' | 'INACTIVE';
  locationCode: string;
  initialQuantity: string;
}

const UNITS = ['pcs', 'box', 'pack', 'kg', 'g', 'lt', 'm', 'roll', 'set', 'pair', 'pallet'];
const num = (s: string) => (s.trim() === '' ? 0 : Number(s.replace(',', '.')));

function QuickCreate({ kind, open, onClose, onCreated }: { kind: 'categories' | 'suppliers'; open: boolean; onClose: () => void; onCreated: (id: number) => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const m = useMutation({
    mutationFn: () => api.post<{ data: { id: number } }>(`/${kind}`, { name }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: [kind] });
      onCreated(r.data.id);
      setName('');
      onClose();
    },
  });
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      title={kind === 'categories' ? t('New category') : t('New supplier')}
      footer={
        <>
          <Button onClick={onClose}>{t('Cancel')}</Button>
          <Button variant="primary" disabled={!name.trim()} loading={m.isPending} onClick={() => m.mutate()}>{t('Create')}</Button>
        </>
      }
    >
      <form onSubmit={(e) => (e.preventDefault(), name.trim() && m.mutate())} className="space-y-3">
        <Field label={t('Name')} required>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <ErrorBox error={m.error ? errMsg(m.error) : null} />
      </form>
    </Modal>
  );
}

export default function ProductForm() {
  const t = useT();
  const { id } = useParams();
  const isEdit = Boolean(id);
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { settings, can } = useAuth();
  const categories = useCategories();
  const suppliers = useSuppliers();
  const locations = useLocations();
  const [quick, setQuick] = useState<'categories' | 'suppliers' | null>(null);
  const [dupConfirm, setDupConfirm] = useState<{ products: { sku: string; name: string }[] } | null>(null);

  const existing = useQuery({
    queryKey: ['product', id],
    queryFn: () => api.get<{ data: Product }>(`/products/${id}`).then((r) => r.data),
    enabled: isEdit,
  });

  const [f, setF] = useState<FormState>({
    sku: '',
    barcode: search.get('barcode') ?? '',
    name: '',
    description: '',
    categoryId: '',
    supplierId: '',
    unit: settings.defaultUnit || 'pcs',
    minStock: '0',
    purchasePrice: '',
    sellingPrice: '',
    status: 'ACTIVE',
    locationCode: '',
    initialQuantity: '',
  });
  const [loaded, setLoaded] = useState(!isEdit);

  useEffect(() => {
    const p = existing.data;
    if (!p || loaded) return;
    setF({
      sku: p.sku,
      barcode: p.barcode ?? '',
      name: p.name,
      description: p.description ?? '',
      categoryId: p.categoryId ? String(p.categoryId) : '',
      supplierId: p.supplierId ? String(p.supplierId) : '',
      unit: p.unit,
      minStock: String(p.minStock),
      purchasePrice: String(p.purchasePrice),
      sellingPrice: String(p.sellingPrice),
      status: p.status,
      locationCode: p.locationCode ?? '',
      initialQuantity: '',
    });
    setLoaded(true);
  }, [existing.data, loaded]);

  const set = (k: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF((s) => ({ ...s, [k]: e.target.value }));

  // Live uniqueness check for SKU / barcode
  const [codes, setCodes] = useState({ sku: '', barcode: '' });
  useEffect(() => {
    const h = setTimeout(() => setCodes({ sku: f.sku.trim(), barcode: f.barcode.trim() }), 300);
    return () => clearTimeout(h);
  }, [f.sku, f.barcode]);
  const unique = useQuery({
    queryKey: ['check-unique', codes, id],
    queryFn: () =>
      api.get<{ sku: { id: number; sku: string; name: string } | null; barcode: { id: number; sku: string; name: string }[] }>('/products/check-unique', {
        sku: codes.sku,
        barcode: codes.barcode,
        excludeId: id,
      }),
    enabled: Boolean(codes.sku || codes.barcode),
  });

  const save = useMutation({
    mutationFn: (confirmDuplicateBarcode: boolean) => {
      const body = {
        sku: f.sku.trim(),
        barcode: f.barcode.trim() || null,
        name: f.name.trim(),
        description: f.description,
        categoryId: f.categoryId ? Number(f.categoryId) : null,
        supplierId: f.supplierId ? Number(f.supplierId) : null,
        unit: f.unit,
        minStock: num(f.minStock),
        purchasePrice: num(f.purchasePrice),
        sellingPrice: num(f.sellingPrice),
        status: f.status,
        locationCode: f.locationCode.trim() || null,
        confirmDuplicateBarcode,
        ...(isEdit ? {} : { initialQuantity: num(f.initialQuantity) }),
      };
      return isEdit ? api.put<{ data: Product }>(`/products/${id}`, body) : api.post<{ data: Product }>('/products', body);
    },
    onSuccess: (res) => {
      toast.success(isEdit ? t('Product saved') : t('Product {sku} created', { sku: res.data.sku }));
      void qc.invalidateQueries();
      navigate(`/products/${res.data.id}`);
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'DUPLICATE_BARCODE') setDupConfirm(e.details);
    },
  });

  const numbersInvalid = [f.minStock, f.purchasePrice, f.sellingPrice, f.initialQuantity].some((v) => v.trim() !== '' && (Number.isNaN(num(v)) || num(v) < 0));
  const canSubmit = f.sku.trim() && f.name.trim() && !/\s/.test(f.sku.trim()) && !unique.data?.sku && !numbersInvalid;

  if (isEdit && (existing.isLoading || !loaded)) return <LoadingBlock />;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (canSubmit) save.mutate(false);
  };
  // Scanners end with Enter: don't submit the form from code fields.
  const noEnter = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const form = e.currentTarget.form;
      const idx = Array.from(form?.elements ?? []).indexOf(e.currentTarget);
      (form?.elements[idx + 1] as HTMLElement | undefined)?.focus();
    }
  };

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        back={
          <Link to={isEdit ? `/products/${id}` : '/products'} className="mb-2 inline-flex items-center gap-1 text-xs text-muted hover:text-fg">
            <ArrowLeft className="size-3.5" /> {isEdit ? existing.data?.name : t('Products')}
          </Link>
        }
        title={isEdit ? t('Edit product') : t('New product')}
      />
      <form onSubmit={submit} className="space-y-4">
        <Card>
          <CardHeader title={t('Identification')} />
          <div className="grid gap-4 p-4 sm:grid-cols-2">
            <Field label="SKU" required error={unique.data?.sku ? t('Already used by {name}', { name: unique.data.sku.name }) : /\s/.test(f.sku.trim()) ? t('No spaces allowed') : undefined}>
              <Input value={f.sku} onChange={set('sku')} onKeyDown={noEnter} className="font-mono" invalid={Boolean(unique.data?.sku)} autoFocus={!isEdit} maxLength={64} />
            </Field>
            <Field
              label={t('Barcode (EAN / UPC)')}
              hint={t('Click the field and scan the product')}
              error={unique.data?.barcode.length ? t('Also used by {list} — you will be asked to confirm', { list: unique.data.barcode.map((b) => b.sku).join(', ') }) : undefined}
            >
              <Input value={f.barcode} onChange={set('barcode')} onKeyDown={noEnter} className="font-mono" maxLength={64} />
            </Field>
            <Field label={t('Product name')} required className="sm:col-span-2">
              <Input value={f.name} onChange={set('name')} maxLength={200} />
            </Field>
            <Field label={t('Description')} className="sm:col-span-2">
              <Textarea value={f.description} onChange={set('description')} rows={2} maxLength={2000} />
            </Field>
          </div>
        </Card>

        <Card>
          <CardHeader title={t('Classification')} />
          <div className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label={t('Category')}>
              <div className="flex gap-1">
                <Select value={f.categoryId} onChange={set('categoryId')}>
                  <option value="">—</option>
                  {categories.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </Select>
                {can('catalog.manage') && (
                  <IconButton label={t('New category')} className="border border-line-strong" onClick={() => setQuick('categories')}>
                    <Plus className="size-4" />
                  </IconButton>
                )}
              </div>
            </Field>
            <Field label={t('Supplier')}>
              <div className="flex gap-1">
                <Select value={f.supplierId} onChange={set('supplierId')}>
                  <option value="">—</option>
                  {suppliers.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </Select>
                {can('catalog.manage') && (
                  <IconButton label={t('New supplier')} className="border border-line-strong" onClick={() => setQuick('suppliers')}>
                    <Plus className="size-4" />
                  </IconButton>
                )}
              </div>
            </Field>
            <Field label={t('Warehouse location')} hint={t('Zone-Rack-Shelf, e.g. A-01-03')}>
              <Input value={f.locationCode} onChange={set('locationCode')} onKeyDown={noEnter} list="locations" className="font-mono uppercase" maxLength={40} />
              <datalist id="locations">{locations.data?.map((l) => <option key={l.id} value={l.code} />)}</datalist>
            </Field>
            <Field label={t('Status')}>
              <Segmented
                value={f.status}
                onChange={(status) => setF((s) => ({ ...s, status }))}
                className="flex w-full"
                options={[
                  { value: 'ACTIVE', label: t('Active') },
                  { value: 'INACTIVE', label: t('Inactive') },
                ]}
              />
            </Field>
          </div>
        </Card>

        <Card>
          <CardHeader title={t('Stock & prices')} />
          <div className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-5">
            <Field label={t('Unit of measure')}>
              <Select value={f.unit} onChange={set('unit')}>
                {[...new Set([...UNITS, f.unit])].map((u) => <option key={u} value={u}>{u}</option>)}
              </Select>
            </Field>
            {isEdit ? (
              <Field label={t('Current quantity')} hint={t('Changed only through stock movements or adjustments')}>
                <Input value={fmtQty(existing.data?.quantity ?? 0)} disabled className="tabular" />
              </Field>
            ) : (
              <Field label={t('Initial quantity')} hint={t('Recorded as INITIAL_STOCK')}>
                <Input inputMode="decimal" value={f.initialQuantity} onChange={set('initialQuantity')} className="tabular" placeholder="0" />
              </Field>
            )}
            <Field label={t('Minimum stock')}>
              <Input inputMode="decimal" value={f.minStock} onChange={set('minStock')} className="tabular" />
            </Field>
            <Field label={t('Purchase price')}>
              <Input inputMode="decimal" value={f.purchasePrice} onChange={set('purchasePrice')} className="tabular" placeholder="0,00" />
            </Field>
            <Field label={t('Selling price')}>
              <Input inputMode="decimal" value={f.sellingPrice} onChange={set('sellingPrice')} className="tabular" placeholder="0,00" />
            </Field>
          </div>
          {numbersInvalid && <div className="px-4 pb-4"><ErrorBox error={t('Numbers must be zero or positive.')} /></div>}
        </Card>

        {save.error && !(save.error instanceof ApiError && save.error.code === 'DUPLICATE_BARCODE') && <ErrorBox error={errMsg(save.error)} />}

        <div className="flex justify-end gap-2">
          <Button onClick={() => navigate(-1)}>{t('Cancel')}</Button>
          <Button type="submit" variant="primary" disabled={!canSubmit} loading={save.isPending}>
            {isEdit ? t('Save changes') : t('Create product')}
          </Button>
        </div>
      </form>

      {quick && (
        <QuickCreate
          kind={quick}
          open
          onClose={() => setQuick(null)}
          onCreated={(newId) => setF((s) => ({ ...s, [quick === 'categories' ? 'categoryId' : 'supplierId']: String(newId) }))}
        />
      )}
      <ConfirmDialog
        open={Boolean(dupConfirm)}
        title={t('Duplicate barcode')}
        message={t('Barcode {code} is already used by: {list}. Save anyway? Scanning this barcode will then ask which product you mean.', {
          code: f.barcode,
          list: dupConfirm?.products.map((p) => `${p.sku} (${p.name})`).join(', '),
        })}
        confirmLabel={t('Save with duplicate barcode')}
        loading={save.isPending}
        onConfirm={() => (setDupConfirm(null), save.mutate(true))}
        onClose={() => setDupConfirm(null)}
      />
    </div>
  );
}
