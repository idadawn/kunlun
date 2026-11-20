import { useEffect, useRef, type ComponentType } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { mobileFeature, pathFor, resolveRoute, type MobileFeature } from '@kunlun/shared';
import { DialogProvider, Icon, useAuth, useToast, workbenchTabs } from '@kunlun/ui';
import '@kunlun/ui/src/workbench.css';
import { H5Shell } from '../shared/H5Shell';
import { StaffDataProvider, useMobileLayout, useStaffData } from './data';
import { StaffCounter, StaffHome, StaffInventory, StaffMembers, StaffOrders, StaffProfile, type StaffPageProps } from './StaffPages';
import './staff.css';

const PAGES: Record<string, ComponentType<StaffPageProps>> = {
  home: StaffHome, order: StaffCounter, orders: StaffOrders, members: StaffMembers, inventory: StaffInventory, profile: StaffProfile,
};
/** Pages everyone has; the others belong to the feature that opens them. */
const OPEN_PAGES = new Set(['home', 'profile']);

export function StaffApp() {
  return (
    <StaffDataProvider>
      <DialogProvider>
        <Routes>
          <Route path="/staff/:page?" element={<StaffShell />} />
          <Route path="*" element={<Navigate to={pathFor('staff')} replace />} />
        </Routes>
      </DialogProvider>
    </StaffDataProvider>
  );
}

function StaffShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const toast = useToast();
  const { user, refreshUser } = useAuth();
  const { refresh } = useStaffData();
  const layout = useMobileLayout();
  const route = resolveRoute(location.pathname);
  const page = route?.area === 'staff' ? route.page : null;

  // Every page shows live data, and the role's features may have changed in the console meanwhile.
  const firstVisit = useRef(true);
  useEffect(() => {
    if (!page) return;
    const first = firstVisit.current;
    firstVisit.current = false;
    // The profile only displays the account and its current permissions.
    let active = true;
    Promise.all([first ? undefined : refreshUser(), page === 'profile' ? undefined : refresh()])
      .catch(e => { if (active && !first) toast(e.message, 'error'); });
    return () => { active = false; };
  }, [page, refresh, refreshUser, toast]);

  if (!route || route.area !== 'staff') return <Navigate to={pathFor('staff')} replace />;
  if (route.path !== location.pathname) return <Navigate to={route.path + location.search} replace />;

  const go = (target: string) => navigate(pathFor('staff', target));
  const owner = MOBILE_PAGE_FEATURE[route.page];
  const locked = !OPEN_PAGES.has(route.page) && !(owner && layout.has(owner.key));
  const Page = PAGES[route.page];
  return (
    <H5Shell title="绿麒麟水站·员工工作台" tabs={workbenchTabs(user.mobileFeatures)} active={route.page} page={route.page} onNavigate={go}>
      {locked ? <LockedPage feature={owner} go={go} /> : <Page go={go} />}
    </H5Shell>
  );
}

const MOBILE_PAGE_FEATURE: Record<string, MobileFeature | undefined> = {
  order: mobileFeature('order'), orders: mobileFeature('orders'), members: mobileFeature('members'), inventory: mobileFeature('inventory'),
};

function LockedPage({ feature, go }: { feature?: MobileFeature; go: (page: string) => void }) {
  return (
    <div className="h5-body">
      <div className="h5-card wb-empty">
        <span className="quick-icon"><Icon name="shield" size="lg" /></span>
        <b>未开通「{feature?.label ?? '这个功能'}」</b>
        <p>你的角色还没有开通这个功能。需要时请联系管理员在「系统设置 → 移动端配置」开通。</p>
        <button type="button" className="btn primary sm" onClick={() => go('home')}>回到工作台</button>
      </div>
    </div>
  );
}
