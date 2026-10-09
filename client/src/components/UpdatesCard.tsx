import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, HardDrive, Loader2, MonitorDown, RefreshCw, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/api';
import { desktop, type DesktopUpdateState } from '../lib/desktop';
import { fmtDateTime, fmtRelative } from '../lib/format';
import { useT } from '../lib/i18n';
import { errMsg } from '../lib/queries';
import { Badge, Button, Card, CardHeader } from './ui';

interface UpdateStatus {
  managed: boolean;
  version: string;
  autoUpdate: boolean | null;
  updateTime: string | null;
  state: string | null;
  lastResult: string | null;
  message: string | null;
  lastCheckAt: string | null;
  latestVersion: string | null;
  previousVersion: string | null;
  requestPending: boolean;
  history: { at: string; from: string; to: string; result: string; message?: string }[];
  disk: { freeMb: number; totalMb: number } | null;
}

const gb = (mb: number) => `${(mb / 1024).toFixed(1)} GB`;

function Line({ tone, icon, children }: { tone: 'ok' | 'warn' | 'bad' | 'muted'; icon?: React.ReactNode; children: React.ReactNode }) {
  const colors = { ok: 'text-ok', warn: 'text-warn', bad: 'text-bad', muted: 'text-muted' };
  return (
    <div className={`flex items-start gap-2 text-sm ${colors[tone]}`}>
      <span className="mt-0.5 shrink-0">{icon}</span>
      <span>{children}</span>
    </div>
  );
}

/** Windows app: its own automatic updates (separate from the server's). */
function DesktopUpdates() {
  const t = useT();
  const bridge = desktop();
  const [s, setS] = useState<DesktopUpdateState | null>(null);
  useEffect(() => {
    if (!bridge?.updates) return;
    void bridge.updates.status().then(setS);
    return bridge.updates.onChange(setS);
  }, [bridge]);
  if (!bridge?.updates) return null;
  const busy = s?.state === 'checking' || s?.state === 'downloading';
  return (
    <div className="space-y-2 border-t border-line p-4">
      <div className="flex flex-wrap items-center gap-2 text-sm font-semibold">
        <MonitorDown className="size-4 text-brand-fg" />
        {t('Windows app on this PC')}
        <Badge>{bridge.appVersion}</Badge>
      </div>
      {s?.state === 'downloaded' ? (
        <div className="flex flex-wrap items-center gap-2">
          <Line tone="ok" icon={<CheckCircle2 className="size-4" />}>
            {t('Version {v} is ready. It is installed when the app closes, or now:', { v: s.version ?? '' })}
          </Line>
          <Button size="sm" variant="primary" onClick={() => void bridge.updates!.installNow()}>{t('Restart and update')}</Button>
        </div>
      ) : s?.state === 'downloading' ? (
        <Line tone="muted" icon={<Loader2 className="size-4 animate-spin" />}>{t('Downloading version {v}… {p}%', { v: s.version ?? '', p: Math.round(s.percent ?? 0) })}</Line>
      ) : s?.state === 'error' ? (
        <Line tone="warn" icon={<TriangleAlert className="size-4" />}>{t('Could not check for updates: {m}. The app tries again later.', { m: s.message ?? '' })}</Line>
      ) : s?.state === 'disabled' ? (
        <Line tone="muted">{s.message ?? t('Automatic updates are off in this copy of the app.')}</Line>
      ) : (
        <Line tone="ok" icon={<CheckCircle2 className="size-4" />}>
          {t('Updates itself automatically.')} {s?.checkedAt ? t('Last check: {when}.', { when: fmtRelative(s.checkedAt) }) : ''}
        </Line>
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" icon={<RefreshCw className="size-3.5" />} loading={busy} onClick={() => void bridge.updates!.check().then(setS)}>
          {t('Check now')}
        </Button>
        {bridge.changeServer && (
          <Button size="sm" variant="ghost" onClick={() => void bridge.changeServer!()}>
            {bridge.mode === 'remote' ? t('Change server…') : t('Connect to a company server…')}
          </Button>
        )}
      </div>
    </div>
  );
}

/** Admin-only: version, automatic updates (server and Windows app) and free disk space. */
export function UpdatesCard() {
  const t = useT();
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: ['system-update'],
    queryFn: () => api.get<{ data: UpdateStatus }>('/system/update').then((r) => r.data),
    refetchInterval: (q) => {
      const d = q.state.data;
      return d && (d.requestPending || d.state === 'checking' || d.state === 'updating') ? 3000 : 60_000;
    },
  });
  const check = useMutation({
    mutationFn: () => api.post<{ data: UpdateStatus }>('/system/update/check'),
    onSuccess: (r) => (qc.setQueryData(['system-update'], r.data), toast.success(t('The server will check for a new version in a few seconds.'))),
    onError: (e) => toast.error(errMsg(e)),
  });

  const d = status.data;
  const working = d && (d.requestPending || d.state === 'checking' || d.state === 'updating');
  const isLocalDesktop = desktop()?.mode === 'local';

  return (
    <Card>
      <CardHeader
        title={t('Updates')}
        subtitle={t('Version {v}', { v: d?.version ?? '…' })}
        actions={
          d?.managed && (
            <Button icon={<RefreshCw className="size-4" />} loading={Boolean(working) || check.isPending} onClick={() => check.mutate()}>
              {t('Check for updates now')}
            </Button>
          )
        }
      />
      {d && (
        <div className="space-y-2 p-4">
          {d.managed ? (
            <>
              <Line tone={d.autoUpdate ? 'ok' : 'warn'} icon={d.autoUpdate ? <CheckCircle2 className="size-4" /> : <TriangleAlert className="size-4" />}>
                {d.autoUpdate
                  ? t('Server updates are automatic: every night at {time}, with a backup first and an automatic return to the previous version if the new one does not start.', { time: d.updateTime ?? '03:30' })
                  : t('Automatic server updates are off. Use "Check for updates now" or run sudo ims update on the server.')}
              </Line>
              {working ? (
                <Line tone="muted" icon={<Loader2 className="size-4 animate-spin" />}>
                  {d.state === 'updating'
                    ? t('Updating… The app restarts and reconnects by itself in about a minute.')
                    : t('Checking for a new version…')}
                </Line>
              ) : d.lastResult === 'rolled-back' || d.lastResult === 'failed' ? (
                <Line tone="bad" icon={<TriangleAlert className="size-4" />}>
                  {d.lastResult === 'rolled-back'
                    ? t('The last update did not start correctly, so the server returned to version {v} by itself. Your data was not affected.', { v: d.version })
                    : t('The last update could not be completed.')}{' '}
                  {d.message}
                </Line>
              ) : d.lastResult === 'available' ? (
                <Line tone="warn" icon={<TriangleAlert className="size-4" />}>
                  {t('Version {v} is available.', { v: d.latestVersion ?? '' })} {d.message}
                </Line>
              ) : d.lastCheckAt ? (
                <Line tone="ok" icon={<CheckCircle2 className="size-4" />}>{t('This is the newest version.')}</Line>
              ) : null}
              {d.lastCheckAt && <p className="text-xs text-muted">{t('Last check: {when}.', { when: `${fmtDateTime(d.lastCheckAt)} (${fmtRelative(d.lastCheckAt)})` })}</p>}
              {d.history.length > 0 && (
                <ul className="space-y-0.5 text-xs text-muted">
                  {d.history.slice(0, 5).map((h) => (
                    <li key={h.at + h.to}>
                      {fmtDateTime(h.at)}: {h.from} → {h.to}{' '}
                      {h.result === 'updated' ? <Badge tone="ok">{t('Update done')}</Badge> : <Badge tone="bad">{t('Returned to previous')}</Badge>}
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : isLocalDesktop ? (
            <Line tone="muted">{t('This PC runs its own copy of the app; it is updated with the Windows app below.')}</Line>
          ) : (
            <Line tone="muted">{t('This server was not installed with the installer, so it is updated by hand (see the installation guide).')}</Line>
          )}
          {d.disk && (
            <Line tone={d.disk.freeMb < 1024 ? 'bad' : 'muted'} icon={<HardDrive className="size-4" />}>
              {t('Free disk space: {free} of {total}', { free: gb(d.disk.freeMb), total: gb(d.disk.totalMb) })}
              {d.disk.freeMb < 1024 && ` — ${t('low: delete old files or enlarge the disk')}`}
            </Line>
          )}
        </div>
      )}
      <DesktopUpdates />
    </Card>
  );
}
