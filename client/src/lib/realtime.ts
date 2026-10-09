import { useEffect, useSyncExternalStore } from 'react';
import type { QueryClient } from '@tanstack/react-query';

export type LiveStatus = 'connecting' | 'live' | 'reconnecting' | 'offline';

let status: LiveStatus = 'connecting';
const listeners = new Set<() => void>();
const setStatus = (s: LiveStatus) => {
  if (s === status) return;
  status = s;
  listeners.forEach((l) => l());
};

/** Current connection state, for the header indicator. */
export function useLiveStatus(): LiveStatus {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => status,
  );
}

/**
 * Keeps every open page in step with the server: when any browser changes data,
 * the server sends a change event and this refreshes the cached queries.
 * The browser reconnects by itself; after a reconnect everything is refreshed,
 * because changes made while disconnected were not delivered.
 */
export function useRealtime(queryClient: QueryClient, onNewVersion?: (version: string) => void) {
  useEffect(() => {
    if (typeof EventSource === 'undefined') {
      setStatus('offline');
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let wasDown = false;
    // The version this page was loaded with; after a server update it differs.
    let loadedVersion: string | null = null;
    const checkVersion = async () => {
      try {
        const r = await fetch('/api/health', { cache: 'no-store' });
        const { version } = (await r.json()) as { version?: string };
        if (!version) return;
        if (loadedVersion === null) loadedVersion = version;
        else if (version !== loadedVersion) onNewVersion?.(version);
      } catch {
        /* checked again on the next reconnect */
      }
    };
    void checkVersion();
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void queryClient.invalidateQueries(), 250);
    };
    const es = new EventSource('/api/events', { withCredentials: true });
    es.addEventListener('change', refresh);
    es.onopen = () => {
      setStatus('live');
      if (wasDown) {
        wasDown = false;
        refresh();
        void checkVersion();
      }
    };
    es.onerror = () => {
      wasDown = true;
      // readyState CLOSED means the server refused (e.g. session ended): stop retrying.
      setStatus(es.readyState === EventSource.CLOSED ? 'offline' : 'reconnecting');
    };
    return () => {
      clearTimeout(timer);
      es.close();
    };
  }, [queryClient, onNewVersion]);
}
