import { createContext, useContext, useEffect, useRef, type MutableRefObject, type ReactNode } from 'react';

type Handler = (code: string) => void;
const ScanContext = createContext<MutableRefObject<Handler | null>>({ current: null });

export function ScanProvider({ children }: { children: ReactNode }) {
  const ref = useRef<Handler | null>(null);
  return <ScanContext.Provider value={ref}>{children}</ScanContext.Provider>;
}

export const useScanOverride = () => useContext(ScanContext);

/** While mounted, scans caught outside input fields are routed to `handler`. */
export function useScanHandler(handler: Handler) {
  const ref = useContext(ScanContext);
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    const fn: Handler = (code) => latest.current(code);
    ref.current = fn;
    return () => {
      if (ref.current === fn) ref.current = null;
    };
  }, [ref]);
}
