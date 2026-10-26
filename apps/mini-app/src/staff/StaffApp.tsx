import { useEffect, useRef, type ComponentType } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { pathFor, resolveRoute } from '@kunlun/shared';
import { DialogProvider, useToast } from '@kunlun/ui';
import { H5Shell, type H5Tab } from '../shared/H5Shell';
import { StaffDataProvider, useStaffData } from './data';
import { StaffCounter, StaffHome, StaffMembers, StaffOrders, StaffProfile, type StaffPageProps } from './StaffPages';
import './staff.css';

const TABS: H5Tab[] = [
  { page: 'home', label: '工作台', icon: 'home' },
  { page: 'order', label: '点单', icon: 'drop' },
  { page: 'orders', label: '水单', icon: 'order' },
  { page: 'members', label: '会员', icon: 'users' },
  { page: 'profile', label: '我的', icon: 'user' },
];
const PAGES: Record<string, ComponentType<StaffPageProps>> = { home: StaffHome, order: StaffCounter, orders: StaffOrders, members: StaffMembers, profile: StaffProfile };

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
  const { refresh } = useStaffData();
  const route = resolveRoute(location.pathname);
  const page = route?.area === 'staff' ? route.page : null;

  const firstVisit = useRef(true);
  useEffect(() => {
    if (firstVisit.current) { firstVisit.current = false; return; }
    if (page) refresh().catch(e => toast(e.message));
  }, [page, refresh, toast]);

  if (!route || route.area !== 'staff') return <Navigate to={pathFor('staff')} replace />;
  if (route.path !== location.pathname) return <Navigate to={route.path + location.search} replace />;

  const go = (target: string) => navigate(pathFor('staff', target));
  const Page = PAGES[route.page];
  return (
    <H5Shell title="绿麒麟水站·员工工作台" tabs={TABS} active={route.page} page={route.page} onNavigate={go}>
      <Page go={go} />
    </H5Shell>
  );
}
