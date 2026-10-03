import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DatabaseBackup, Download, FolderOpen, RotateCcw, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { api, download } from '../lib/api';
import { useAuth } from '../lib/auth';
import { desktop } from '../lib/desktop';
import { fmtDateTime, fmtRelative } from '../lib/format';
import { useT } from '../lib/i18n';
import { errMsg } from '../lib/queries';
import { Badge, Button, Card, CardHeader, Checkbox, ConfirmDialog, ErrorBox, Field, IconButton, Input, Table, Td, Th } from './ui';

interface BackupInfo {
  dir: string;
  defaultDir: string;
  enabled: boolean;
  keep: number;
  lastBackupAt: string | null;
  files: { name: string; size: number; createdAt: string }[];
}

const size = (b: number) => (b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

/** Admin-only: automatic daily backups, manual backup, download and restore. */
export function BackupsCard() {
  const t = useT();
  const qc = useQueryClient();
  const { logout } = useAuth();
  const fileInput = useRef<HTMLInputElement>(null);
  const [restore, setRestore] = useState<{ name: string; file?: File } | null>(null);
  const [dir, setDir] = useState('');
  const [keep, setKeep] = useState('30');

  const info = useQuery({ queryKey: ['backups'], queryFn: () => api.get<{ data: BackupInfo }>('/backups').then((r) => r.data) });
  useEffect(() => {
    if (!info.data) return;
    setDir(info.data.dir === info.data.defaultDir ? '' : info.data.dir);
    setKeep(String(info.data.keep));
  }, [info.data]);

  const refresh = () => void qc.invalidateQueries({ queryKey: ['backups'] });

  const backupNow = useMutation({
    mutationFn: () => api.post<{ data: { name: string } }>('/backups'),
    onSuccess: (r) => (toast.success(t('Backup saved: {name}', { name: r.data.name })), refresh()),
    onError: (e) => toast.error(errMsg(e)),
  });

  const saveSettings = useMutation({
    mutationFn: (patch: Record<string, string>) => api.put('/settings', patch),
    onSuccess: () => (toast.success(t('Backup settings saved')), refresh()),
  });

  const doRestore = useMutation({
    mutationFn: async () => {
      if (!restore) return;
      if (restore.file) {
        const fd = new FormData();
        fd.append('file', restore.file);
        return api.post('/backups/restore-upload', fd);
      }
      return api.post(`/backups/${encodeURIComponent(restore.name)}/restore`);
    },
    onSuccess: async () => {
      setRestore(null);
      toast.success(t('Backup restored. Sign in again to continue.'));
      qc.clear();
      await logout();
    },
    onError: (e) => toast.error(errMsg(e)),
  });

  const chooseFolder = async () => {
    const picked = await desktop()?.chooseFolder(info.data?.dir);
    if (picked) setDir(picked);
  };

  const data = info.data;
  const stale = data?.enabled && (!data.lastBackupAt || Date.now() - Date.parse(data.lastBackupAt) > 2 * 24 * 3600 * 1000);

  return (
    <Card>
      <CardHeader
        title={t('Backups')}
        subtitle={t('A copy of the whole database is saved automatically once a day.')}
        actions={
          <Button variant="primary" icon={<DatabaseBackup className="size-4" />} loading={backupNow.isPending} onClick={() => backupNow.mutate()}>
            {t('Back up now')}
          </Button>
        }
      />
      <div className="space-y-4 p-4">
        {data && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted">{t('Last backup')}:</span>
            <b>{data.lastBackupAt ? `${fmtDateTime(data.lastBackupAt)} (${fmtRelative(data.lastBackupAt)})` : t('never')}</b>
            {stale && <Badge tone="warn">{t('Back up now')}</Badge>}
          </div>
        )}
        <form
          className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_120px_auto]"
          onSubmit={(e) => (e.preventDefault(), saveSettings.mutate({ backup_dir: dir.trim(), backup_keep: keep }))}
        >
          <Field label={t('Backup folder')} hint={t('Empty = default folder: {dir}. Choose a USB stick, second disk or OneDrive folder for extra safety.', { dir: data?.defaultDir ?? '' })}>
            <div className="flex gap-1">
              <Input id="backup-dir" className="flex-1 font-mono text-xs" value={dir} onChange={(e) => setDir(e.target.value)} placeholder={data?.defaultDir} />
              {desktop() && (
                <IconButton label={t('Choose folder')} className="border border-line-strong" onClick={() => void chooseFolder()}>
                  <FolderOpen className="size-4" />
                </IconButton>
              )}
            </div>
          </Field>
          <Field label={t('Keep last')} hint={t('backups')}>
            <Input id="backup-keep" type="number" min={1} max={365} value={keep} onChange={(e) => setKeep(e.target.value)} className="tabular" />
          </Field>
          <div className="flex items-start pt-6">
            <Button type="submit" loading={saveSettings.isPending}>{t('Save')}</Button>
          </div>
        </form>
        {saveSettings.error && <ErrorBox error={errMsg(saveSettings.error)} />}
        {data && (
          <Checkbox
            checked={data.enabled}
            onChange={(v) => saveSettings.mutate({ backup_enabled: v ? 'true' : 'false' })}
            label={t('Automatic daily backup')}
            description={t('Recommended. Old backups beyond the number above are deleted automatically.')}
          />
        )}
        <div className="flex flex-wrap gap-2">
          {desktop() && data && (
            <Button size="sm" icon={<FolderOpen className="size-3.5" />} onClick={() => void desktop()!.openFolder(data.dir)}>
              {t('Open backup folder')}
            </Button>
          )}
          <Button size="sm" icon={<Upload className="size-3.5" />} onClick={() => fileInput.current?.click()}>
            {t('Restore from file…')}
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept=".db,.sqlite"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) setRestore({ name: f.name, file: f });
              e.target.value = '';
            }}
          />
        </div>
      </div>
      {data && data.files.length > 0 && (
        <div className="max-h-80 overflow-y-auto border-t border-line">
          <Table>
            <thead>
              <tr>
                <Th>{t('Date/Time')}</Th>
                <Th>{t('Type')}</Th>
                <Th align="right">{t('Size')}</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {data.files.map((f) => {
                const kind = f.name.includes('_manual') ? t('Manual') : f.name.includes('_before-restore') ? t('Before restore') : t('Automatic');
                return (
                  <tr key={f.name}>
                    <Td className="tabular whitespace-nowrap">{fmtDateTime(f.createdAt)}</Td>
                    <Td>{kind}</Td>
                    <Td align="right" className="tabular">{size(f.size)}</Td>
                    <Td align="right" className="whitespace-nowrap">
                      <IconButton label={t('Download')} onClick={() => download(`/backups/${encodeURIComponent(f.name)}/download`).catch((e) => toast.error(errMsg(e)))}>
                        <Download className="size-4" />
                      </IconButton>
                      <IconButton label={t('Restore this backup')} onClick={() => setRestore({ name: f.name })}>
                        <RotateCcw className="size-4" />
                      </IconButton>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </div>
      )}
      <ConfirmDialog
        open={Boolean(restore)}
        title={t('Restore backup?')}
        message={t('All current data will be replaced by "{name}". A backup of the current data is taken first, so you can undo this. Everyone will be signed out.', { name: restore?.name })}
        confirmLabel={t('Restore')}
        tone="danger"
        loading={doRestore.isPending}
        onConfirm={() => doRestore.mutate()}
        onClose={() => setRestore(null)}
      />
    </Card>
  );
}
