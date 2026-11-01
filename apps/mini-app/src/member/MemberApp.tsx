import { useEffect, useRef, type ComponentType } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { pathFor, resolveRoute } from '@kunlun/shared';
import { DialogProvider, useToast } from '@kunlun/ui';
import { H5Shell, Loading, type H5Tab } from '../shared/H5Shell';
import { MemberDataProvider, useMemberData } from './data';
import { MemberAssets, MemberHome, MemberOrders, MemberProfilePage, MemberRecords, type MemberPageProps } from './MemberPages';
import './member.css';

/** 会员端只查记录：用水、水票、押金和桶。订水、付款都在店里由员工登记。 */
const TABS: H5Tab[] = [
  { page: 'home', label: '首页', icon: 'home' },
  { page: 'orders', label: '用水记录', icon: 'order' },
  { page: 'assets', label: '押金与桶', icon: 'box' },
  { page: 'profile', label: '我的', icon: 'user' },
];
const PAGES: Record<string, ComponentType<MemberPageProps>> = {
  home: MemberHome, orders: MemberOrders, assets: MemberAssets, records: MemberRecords, profile: MemberProfilePage,
};

export function MemberApp() {
  return (
    <MemberDataProvider>
      <DialogProvider>
        <Routes>
          <Route path="/member/:page?" element={<MemberShell />} />
          <Route path="*" element={<Navigate to={pathFor('member')} replace />} />
        </Routes>
      </DialogProvider>
    </MemberDataProvider>
  );
}

function MemberShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const toast = useToast();
  const { profile, error, refresh } = useMemberData();
  const route = resolveRoute(location.pathname);
  const page = route?.area === 'member' ? route.page : null;

  const firstVisit = useRef(true);
  useEffect(() => {
    if (firstVisit.current) { firstVisit.current = false; return; }
    if (page === 'home' || page === 'orders' || page === 'profile') refresh().catch(e => toast(e.message));
  }, [page, refresh, toast]);

  if (!route || route.area !== 'member') return <Navigate to={pathFor('member')} replace />;
  if (route.path !== location.pathname) return <Navigate to={route.path + location.search} replace />;

  const go = (target: string) => navigate(pathFor('member', target));
  const Page = PAGES[route.page];

  return (
    <H5Shell title="绿麒麟水站" tabs={TABS} active={route.page === 'records' ? 'profile' : route.page} page={route.page} onNavigate={go}>
      {profile ? <Page profile={profile} go={go} /> : <Loading error={error} onRetry={() => refresh().catch(() => undefined)} />}
    </H5Shell>
  );
}
