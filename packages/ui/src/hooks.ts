import { useCallback, useEffect, useRef, useState } from 'react';

/** Loads data on mount and whenever `deps` change; stale responses from older requests are ignored. */
export function useLoader<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const version = useRef(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const loader = useCallback(load, deps);
  const reload = useCallback(async () => {
    const mine = ++version.current;
    try {
      const value = await loader();
      if (mine === version.current) { setData(value); setError(''); }
    } catch (e) {
      if (mine === version.current) setError(e instanceof Error ? e.message : String(e));
    }
  }, [loader]);
  useEffect(() => { void reload(); }, [reload]);
  return { data, error, reload, setData };
}

/** A request key that stays stable for the lifetime of one form, so retries are idempotent. */
export function useIdempotencyKey() {
  return useState(() => crypto.randomUUID())[0];
}

/** Saves a downloaded file using a temporary object URL. */
export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
