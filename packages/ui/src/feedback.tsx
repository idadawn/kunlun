import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Icon } from './icons';

type Toast = (message: string) => void;
const ToastContext = createContext<Toast>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState('');
  const [visible, setVisible] = useState(false);
  const timer = useRef<number>();
  const toast = useCallback<Toast>(text => {
    setMessage(text); setVisible(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setVisible(false), 2600);
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div className={`gq-toast${visible ? ' show' : ''}`} role="status" aria-live="polite"><Icon name="check" /><span>{message}</span></div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

/** Wraps an async UI action so failures surface as a toast instead of an unhandled rejection. */
export function useRun() {
  const toast = useToast();
  return useCallback(<A extends unknown[]>(fn: (...args: A) => unknown) => (...args: A) => {
    Promise.resolve().then(() => fn(...args)).catch((e: unknown) => toast(e instanceof Error ? e.message : String(e)));
  }, [toast]);
}

type Close<T> = (result?: T) => void;
interface DialogApi { open<T = void>(render: (close: Close<T>) => ReactNode): Promise<T | undefined> }
const DialogContext = createContext<DialogApi | null>(null);

/** Hosts stacked modal dialogs opened imperatively, e.g. `dialogs.open(close => <RechargeDialog onClose={close} />)`. */
export function DialogProvider({ children }: { children: ReactNode }) {
  const [stack, setStack] = useState<Array<{ id: number; node: () => ReactNode }>>([]);
  const nextId = useRef(0);
  const api = useMemo<DialogApi>(() => ({
    open: <T,>(render: (close: Close<T>) => ReactNode) => new Promise<T | undefined>(resolve => {
      const id = ++nextId.current;
      const close: Close<T> = result => { setStack(items => items.filter(item => item.id !== id)); resolve(result); };
      setStack(items => [...items, { id, node: () => render(close) }]);
    }),
  }), []);
  return (
    <DialogContext.Provider value={api}>
      {children}
      {stack.map(item => <DialogSlot key={item.id} node={item.node} />)}
    </DialogContext.Provider>
  );
}

// Each slot renders independently so parent re-renders do not reset dialog-local state.
function DialogSlot({ node }: { node: () => ReactNode }) {
  return <>{node()}</>;
}

export function useDialogs(): DialogApi {
  const api = useContext(DialogContext);
  if (!api) throw new Error('DialogProvider is missing');
  return api;
}

/** Native modal dialog with the shared membership-dialog styling. */
export function Dialog({ title, onClose, children, footer, className = '', description }: {
  title: ReactNode;
  onClose: () => void;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
  description?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const dialog = ref.current!;
    if (!dialog.open) dialog.showModal();
    const handleCancel = (event: Event) => { event.preventDefault(); closeRef.current(); };
    dialog.addEventListener('cancel', handleCancel);
    return () => dialog.removeEventListener('cancel', handleCancel);
  }, []);
  return (
    <dialog ref={ref} className={`membership-dialog ${className}`.trim()}>
      <header>
        <div><h2>{title}</h2>{description && <p className="membership-note">{description}</p>}</div>
        <button type="button" className="btn sm" onClick={onClose} aria-label="关闭">关闭</button>
      </header>
      {children}
      {footer && <footer>{footer}</footer>}
    </dialog>
  );
}

/**
 * Form dialog: browser validation runs first, then `onSubmit`; a thrown error is shown inline and the
 * dialog stays open so the operator can correct it. Successful submissions close the dialog.
 */
export function FormDialog({ title, onClose, onSubmit, submitLabel = '保存', children, className = '', description, extraActions }: {
  title: ReactNode;
  onClose: () => void;
  onSubmit?: () => Promise<void> | void;
  submitLabel?: string;
  children: ReactNode;
  className?: string;
  description?: ReactNode;
  extraActions?: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!onSubmit || busy) return;
    setBusy(true); setError('');
    try { await onSubmit(); onClose(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(false); }
  };
  return (
    <Dialog title={title} onClose={onClose} className={className} description={description}>
      <form onSubmit={submit}>
        <div className="membership-fields">{children}</div>
        <p role="alert" className="account-error">{error}</p>
        {(onSubmit || extraActions) && (
          <footer>
            {extraActions}
            {onSubmit && <button className="btn primary" type="submit" disabled={busy}>{busy ? '正在提交…' : submitLabel}</button>}
          </footer>
        )}
      </form>
    </Dialog>
  );
}

/** Label + control pair used inside `.membership-fields`. */
export function Field({ label, htmlFor, children }: { label: ReactNode; htmlFor: string; children: ReactNode }) {
  return <><label htmlFor={htmlFor}>{label}</label>{children}</>;
}

/** Asks before an irreversible action; resolves the dialog with `true` only after `onConfirm` succeeds. */
export function ConfirmDialog({ title, message, confirmLabel = '确认', onConfirm, onClose }: {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  onConfirm: () => Promise<void> | void;
  onClose: (confirmed?: boolean) => void;
}) {
  // The first close wins: a successful confirmation resolves `true` before the form closes itself.
  return (
    <FormDialog title={title} submitLabel={confirmLabel} onClose={() => onClose(false)} onSubmit={async () => { await onConfirm(); onClose(true); }}
      extraActions={<button type="button" className="btn" onClick={() => onClose(false)}>取消</button>}>
      <p className="membership-note" style={{ fontSize: 13.5, color: 'var(--text)' }}>{message}</p>
    </FormDialog>
  );
}
