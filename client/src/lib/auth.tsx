import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, setUnauthorizedHandler } from './api';
import { setCurrency } from './format';
import type { AppSettings, User } from './types';

interface AuthState {
  user: User | null;
  settings: AppSettings;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  can: (permission: string) => boolean;
}

const DEFAULT_SETTINGS: AppSettings = { companyName: '', currency: 'EUR', allowNegativeStock: false, defaultUnit: 'pcs' };
const AuthContext = createContext<AuthState>(null!);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);
  const qc = useQueryClient();

  const refresh = useCallback(async () => {
    try {
      const res = await api.get<{ data: User; settings: AppSettings }>('/auth/me');
      setUser(res.data);
      setSettings(res.settings);
      setCurrency(res.settings.currency);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setUser(null);
      qc.clear();
    });
    void refresh();
  }, [refresh, qc]);

  const login = useCallback(
    async (username: string, password: string) => {
      await api.post('/auth/login', { username, password });
      await refresh();
    },
    [refresh],
  );

  const logout = useCallback(async () => {
    await api.post('/auth/logout').catch(() => undefined);
    setUser(null);
    qc.clear();
  }, [qc]);

  const can = useCallback((p: string) => Boolean(user?.permissions.includes(p)), [user]);

  const value = useMemo(
    () => ({ user, settings, loading, login, logout, refresh, can }),
    [user, settings, loading, login, logout, refresh, can],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
