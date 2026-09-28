import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Moon, Sun, Volume2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { errMsg } from '../lib/queries';
import { beep, setSoundEnabled, soundEnabled } from '../lib/scanner';
import { useTheme } from '../lib/theme';
import { Button, Card, CardHeader, Checkbox, ErrorBox, Field, Input, PageHeader, Segmented } from '../components/ui';

interface Warehouse {
  id: number;
  code: string;
  name: string;
  address: string | null;
}

export default function Settings() {
  const { t, lang, setLang } = useI18n();
  const { can, refresh } = useAuth();
  const { theme, setTheme } = useTheme();
  const qc = useQueryClient();
  const admin = can('settings.manage');
  const [sound, setSound] = useState(soundEnabled());

  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api.get<{ data: Record<string, string> }>('/settings').then((r) => r.data) });
  const warehouses = useQuery({ queryKey: ['warehouses'], queryFn: () => api.get<{ data: Warehouse[] }>('/warehouses').then((r) => r.data) });

  const [s, setS] = useState<Record<string, string>>({});
  const [wh, setWh] = useState<Warehouse | null>(null);
  useEffect(() => settings.data && setS(settings.data), [settings.data]);
  useEffect(() => {
    if (warehouses.data?.[0]) setWh(warehouses.data[0]);
  }, [warehouses.data]);

  const saveSettings = useMutation({
    mutationFn: () =>
      api.put('/settings', {
        company_name: s.company_name,
        currency: s.currency,
        default_unit: s.default_unit,
        allow_negative_stock: s.allow_negative_stock,
      }),
    onSuccess: () => (toast.success(t('Settings saved')), void refresh(), void qc.invalidateQueries({ queryKey: ['settings'] })),
    onError: (e) => toast.error(errMsg(e)),
  });
  const saveWarehouse = useMutation({
    mutationFn: () => api.put(`/warehouses/${wh!.id}`, { code: wh!.code, name: wh!.name, address: wh!.address }),
    onSuccess: () => (toast.success(t('Warehouse saved')), void qc.invalidateQueries({ queryKey: ['warehouses'] })),
    onError: (e) => toast.error(errMsg(e)),
  });

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader title={t('Settings')} />

      <Card>
        <CardHeader title={t('Appearance')} subtitle={t('Saved on this device')} />
        <div className="grid gap-4 p-4 sm:grid-cols-2">
          <Field label={t('Theme')}>
            <Segmented
              value={theme}
              onChange={setTheme}
              className="flex w-full"
              options={[
                { value: 'light', label: <><Sun className="size-4" /> {t('Light')}</> },
                { value: 'dark', label: <><Moon className="size-4" /> {t('Dark')}</> },
              ]}
            />
          </Field>
          <Field label={t('Language')}>
            <Segmented
              value={lang}
              onChange={setLang}
              className="flex w-full"
              options={[
                { value: 'el', label: 'Ελληνικά' },
                { value: 'en', label: 'English' },
              ]}
            />
          </Field>
        </div>
      </Card>

      <Card>
        <CardHeader title={t('Barcode scanner')} subtitle={t('Saved on this device')} />
        <div className="space-y-3 p-4">
          <Checkbox
            checked={sound}
            onChange={(v) => (setSoundEnabled(v), setSound(v))}
            label={t('Sound feedback on scan')}
            description={t('Short beep on success, low double tone on errors.')}
          />
          <div className="flex gap-2">
            <Button size="sm" icon={<Volume2 className="size-3.5" />} onClick={() => beep('ok')}>{t('Test success')}</Button>
            <Button size="sm" icon={<Volume2 className="size-3.5" />} onClick={() => beep('error')}>{t('Test error')}</Button>
          </div>
          <p className="text-xs text-muted">
            {t('USB and Bluetooth scanners in keyboard (HID) mode work without drivers. Configure the scanner to send Enter after each code. Scans are also caught when no field has focus.')}
          </p>
        </div>
      </Card>

      {admin && (
        <>
          <Card>
            <CardHeader title={t('General')} />
            <form className="grid gap-4 p-4 sm:grid-cols-2" onSubmit={(e) => (e.preventDefault(), saveSettings.mutate())}>
              <Field label={t('Company name')} className="sm:col-span-2">
                <Input value={s.company_name ?? ''} onChange={(e) => setS({ ...s, company_name: e.target.value })} />
              </Field>
              <Field label={t('Currency')} hint="ISO 4217, e.g. EUR">
                <Input value={s.currency ?? ''} maxLength={3} className="uppercase" onChange={(e) => setS({ ...s, currency: e.target.value.toUpperCase() })} />
              </Field>
              <Field label={t('Default unit')}>
                <Input value={s.default_unit ?? ''} onChange={(e) => setS({ ...s, default_unit: e.target.value })} />
              </Field>
              <div className="sm:col-span-2">
                <Checkbox
                  checked={s.allow_negative_stock === 'true'}
                  onChange={(v) => setS({ ...s, allow_negative_stock: v ? 'true' : 'false' })}
                  label={t('Allow negative stock (not recommended)')}
                  description={t('When enabled, dispatches exceeding available stock can be forced after a warning.')}
                />
              </div>
              <div className="sm:col-span-2 flex justify-end">
                <Button type="submit" variant="primary" loading={saveSettings.isPending}>{t('Save')}</Button>
              </div>
            </form>
          </Card>

          {wh && (
            <Card>
              <CardHeader title={t('Warehouse')} subtitle={t('The database supports multiple warehouses; this installation uses the default one.')} />
              <form className="grid gap-4 p-4 sm:grid-cols-3" onSubmit={(e) => (e.preventDefault(), saveWarehouse.mutate())}>
                <Field label={t('Code')}><Input value={wh.code} onChange={(e) => setWh({ ...wh, code: e.target.value })} /></Field>
                <Field label={t('Name')} className="sm:col-span-2"><Input value={wh.name} onChange={(e) => setWh({ ...wh, name: e.target.value })} /></Field>
                <Field label={t('Address')} className="sm:col-span-3"><Input value={wh.address ?? ''} onChange={(e) => setWh({ ...wh, address: e.target.value })} /></Field>
                <div className="sm:col-span-3 flex justify-end">
                  <Button type="submit" variant="primary" loading={saveWarehouse.isPending}>{t('Save')}</Button>
                </div>
              </form>
            </Card>
          )}
          {settings.error && <ErrorBox error={errMsg(settings.error)} />}
        </>
      )}
    </div>
  );
}
