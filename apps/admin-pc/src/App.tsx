import { useEffect, useRef, useState } from 'react';
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { KUNLUN_BRAND, pathFor, resolveRoute } from '@kunlun/shared';
import { ChangePasswordDialog, DialogProvider, Icon, Logo, useAuth, useDialogs, useToast, type IconName } from '@kunlun/ui';
import { PAGE_NAMES, useGo } from './common';
import { AdminDataProvider, useAdminData } from './data';
import { Dashboard } from './pages/Dashboard';
import { Members } from './pages/Members';
import { Orders } from './pages/Orders';
import { Finance } from './pages/Finance';
import { Inventory } from './pages/Inventory';
import { Assets } from './pages/Assets';
import { Products } from './pages/Products';
import { Plans } from './pages/Plans';
import { Coupons } from './pages/Coupons';
import { StaffAccounts } from './pages/StaffAccounts';

export function App() {
  return (
    <AdminDataProvider>
      <DialogProvider>
        <Routes>
          <Route path={pathFor('admin')} element={<AdminLayout />}>
            <Route index element={<Dashboard />} />
            <Route path="members" element={<Members />} />
            <Route path="orders" element={<Orders />} />
            <Route path="finance" element={<Finance />} />
            <Route path="inventory" element={<Inventory />} />
            <Route path="assets" element={<Assets />} />
            <Route path="products" element={<Products />} />
            <Route path="plans" element={<Plans />} />
            <Route path="coupons" element={<Coupons />} />
            <Route path="staff-accounts" element={<StaffAccounts />} />
            <Route path="settings" element={<Navigate to={pathFor('admin', 'settings')} replace />} />
            <Route path="deposit-settings" element={<Navigate to={pathFor('admin', 'deposit-settings')} replace />} />
          </Route>
          <Route path="*" element={<Navigate to={pathFor('admin')} replace />} />
        </Routes>
      </DialogProvider>
    </AdminDataProvider>
  );
}

const NAV: Array<{ label: string; items: Array<[string, IconName]> }> = [
  { label: '经营管理', items: [['dashboard', 'grid'], ['members', 'users'], ['orders', 'order'], ['finance', 'wallet'], ['inventory', 'box'], ['assets', 'box']] },
  { label: '商品与营销', items: [['products', 'drop'], ['plans', 'wallet'], ['coupons', 'deposit']] },
  { label: '系统设置', items: [['staff-accounts', 'shield']] },
];
const COLLAPSE_KEY = 'kunlun.sidebar.collapsed';
const readCollapsed = () => { try { return localStorage.getItem(COLLAPSE_KEY) === 'true'; } catch { return false; } };

function useSidebarCollapsed() {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  useEffect(() => {
    document.documentElement.classList.toggle('sidebar-collapsed', collapsed);
    return () => document.documentElement.classList.remove('sidebar-collapsed');
  }, [collapsed]);
  useEffect(() => {
    const sync = (e: StorageEvent) => { if (e.key === COLLAPSE_KEY) setCollapsed(e.newValue === 'true'); };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);
  const toggle = () => setCollapsed(value => {
    try { localStorage.setItem(COLLAPSE_KEY, String(!value)); } catch { /* The control still works without persistence. */ }
    return !value;
  });
  return [collapsed, toggle] as const;
}

function AdminLayout() {
  const location = useLocation();
  const page = resolveRoute(location.pathname)?.page ?? 'dashboard';
  const { orders, overview, refresh } = useAdminData();
  const [collapsed, toggle] = useSidebarCollapsed();
  const toast = useToast();
  const go = useGo();
  const pending = overview ? overview.pendingDelivery + overview.pendingPickup + overview.dispatched
    : orders.filter(o => o.status === 'PENDING' || o.status === 'DISPATCHED').length;

  // Every page shows live data: entering another page reloads the shared snapshot, as the original console did.
  const firstPage = useRef(true);
  useEffect(() => {
    if (firstPage.current) { firstPage.current = false; return; }
    refresh().catch(e => toast(e.message));
  }, [page, refresh, toast]);
  useEffect(() => { document.querySelector('.main-wrap')?.scrollTo(0, 0); }, [page]);

  return (
    <div id="adminApp" className="admin-app">
      <aside className="sidebar" id="adminSidebar" aria-label="主导航">
        <div className="brand"><Logo /><div className="brand-copy"><h1>{KUNLUN_BRAND.brand}</h1><small>水站会员管理系统</small></div></div>
        {NAV.map(group => (
          <div key={group.label} style={{ display: 'contents' }}>
            <div className="nav-label">{group.label}</div>
            {group.items.map(([id, icon]) => (
              <button key={id} type="button" className={`nav-item${page === id ? ' active' : ''}`} aria-label={PAGE_NAMES[id]} title={PAGE_NAMES[id]} aria-current={page === id ? 'page' : undefined} onClick={() => go(id)}>
                <Icon name={icon} /><span className="nav-text">{PAGE_NAMES[id]}</span>
                {id === 'orders' && pending > 0 && <span className="nav-badge">{pending}</span>}
              </button>
            ))}
          </div>
        ))}
        <div className="sidebar-bottom">
          <div className="station" title={KUNLUN_BRAND.store}>
            <div className="station-avatar"><Icon name="store" /></div>
            <div className="station-copy"><b>{KUNLUN_BRAND.store}</b><small>{KUNLUN_BRAND.product} · 营业中</small></div>
          </div>
        </div>
      </aside>
      <main className="main-wrap">
        <Topbar page={page} collapsed={collapsed} toggle={toggle} />
        <div className="page-content">
          <section id={`page-${page}`} className="section active"><Outlet /></section>
        </div>
      </main>
    </div>
  );
}

function Topbar({ page, collapsed, toggle }: { page: string; collapsed: boolean; toggle: () => void }) {
  const { user, logout } = useAuth();
  const { setMemberQuery } = useAdminData();
  const dialogs = useDialogs();
  const go = useGo();
  const [search, setSearch] = useState('');
  const label = collapsed ? '展开导航栏' : '收起导航栏';
  return (
    <div className="topbar">
      <button type="button" className="sidebar-toggle" aria-label={label} title={label} aria-controls="adminSidebar" aria-expanded={!collapsed} onClick={toggle}>
        <svg className="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M9 4v16" /><path className="sidebar-toggle-arrow" d="m16 9-3 3 3 3" /></svg>
      </button>
      <div className="breadcrumb">{KUNLUN_BRAND.store} / <b>{PAGE_NAMES[page]}</b> <span className="pill">{KUNLUN_BRAND.product}</span></div>
      <div className="top-actions">
        <label className="search-mini"><Icon name="search" />
          <input placeholder="搜索会员姓名、手机号、会员编号" aria-label="搜索会员" value={search} onChange={e => setSearch(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { setMemberQuery(search.trim()); setSearch(''); go('members'); } }} />
        </label>
        <button type="button" className="icon-btn" title="待处理水单" aria-label="待处理水单" onClick={() => go('orders')}><Icon name="bell" /><i className="dot" /></button>
        <button type="button" className="btn sm" onClick={() => dialogs.open(close => <ChangePasswordDialog onClose={close} />)}>修改密码</button>
        <div className="user" role="button" tabIndex={0} style={{ cursor: 'pointer' }} title="点击退出管理员登录"
          onClick={() => { if (confirm(`当前登录管理员：${user.displayName} (${user.codeOrNo})\n确定退出登录并返回登录界面吗？`)) void logout(); }}
          onKeyDown={e => { if (e.key === 'Enter') (e.currentTarget as HTMLElement).click(); }}>
          <div className="avatar">{user.displayName[0]}</div>
          <div className="user-text"><b>{user.displayName}</b><small>ADMIN · {user.codeOrNo}（点击退出）</small></div>
        </div>
      </div>
    </div>
  );
}
