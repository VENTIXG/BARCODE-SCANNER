import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import type { Category, Location, Supplier } from './types';

export const useCategories = () =>
  useQuery({ queryKey: ['categories'], queryFn: () => api.get<{ data: Category[] }>('/categories').then((r) => r.data), staleTime: 60_000 });

export const useSuppliers = () =>
  useQuery({ queryKey: ['suppliers'], queryFn: () => api.get<{ data: Supplier[] }>('/suppliers').then((r) => r.data), staleTime: 60_000 });

export const useLocations = () =>
  useQuery({ queryKey: ['locations'], queryFn: () => api.get<{ data: Location[] }>('/locations').then((r) => r.data), staleTime: 60_000 });

/** Toast-friendly message from any thrown error. */
export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
