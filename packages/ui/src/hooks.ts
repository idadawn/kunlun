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

/** UUID v4, including WebViews where randomUUID is unavailable. */
export function newRequestKey() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

/** A request key that stays stable for the lifetime of one form, so retries are idempotent. */
export function useIdempotencyKey() {
  return useState(newRequestKey)[0];
}

/** Saves a downloaded file using a temporary object URL. */
export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
