import { useEffect, useRef, type ReactNode } from 'react';
import { Icon, type IconName } from '@kunlun/ui';

export interface H5Tab { page: string; label: string; icon: IconName }

/** Phone-style shell shared by the staff and member H5 areas: navbar, scrolling page and bottom tabs. */
export function H5Shell({ title, tabs, active, page, onNavigate, overlay, children }: {
  title: string;
  tabs: H5Tab[];
  active: string;
  page: string;
  onNavigate: (page: string) => void;
  overlay?: ReactNode;
  children: ReactNode;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  useEffect(() => { if (scroll.current) scroll.current.scrollTop = 0; }, [page]);
  return (
    <div className="mobile-showcase">
      <div className="phone">
        <div className="phone-screen">
          <div className="wx-navbar"><div className="wx-title">{title}</div></div>
          <div className="h5-scroll" ref={scroll}>
            <div className="h5-page active">{children}</div>
          </div>
          {overlay}
          <nav className="h5-bottom">
            {tabs.map(tab => (
              <button key={tab.page} type="button" className={`h5-nav${tab.page === active ? ' active' : ''}`} aria-current={tab.page === active ? 'page' : undefined} onClick={() => onNavigate(tab.page)}>
                <Icon name={tab.icon} />{tab.label}
              </button>
            ))}
          </nav>
        </div>
      </div>
    </div>
  );
}

/** Bottom sheet rendered inside the phone screen. */
export function Sheet({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="sheet-mask open" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="sheet-head"><h3>{title}</h3><button type="button" className="sheet-close" aria-label="关闭" onClick={onClose}><Icon name="close" size="sm" /></button></div>
        <div className="sheet-body">{children}</div>
        {footer && <div className="sheet-foot">{footer}</div>}
      </div>
    </div>
  );
}

export const Loading = ({ error, onRetry }: { error?: string; onRetry?: () => void }) => (
  <div className="h5-body">
    {error ? <><p className="account-error" role="alert">{error}</p>{onRetry && <button type="button" className="btn sm" onClick={onRetry}>重试</button>}</> : <p className="membership-note">正在加载…</p>}
  </div>
);
