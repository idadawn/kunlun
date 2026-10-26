import { useEffect, useRef, useState, type ComponentType } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { pathFor, resolveRoute, type FulfillMode } from '@kunlun/shared';
import { DialogProvider, MemberAssetsDialog, useDialogs, useToast } from '@kunlun/ui';
import { H5Shell, Loading, type H5Tab } from '../shared/H5Shell';
import { MemberDataProvider, useMemberData } from './data';
import { MemberAddresses, MemberAssets, MemberHome, MemberOrderPage, MemberOrders, MemberProfilePage, MemberRecords, type MemberPageProps } from './MemberPages';
import { PickupCodeSheet } from './PickupCodeSheet';
import './member.css';

const TABS: H5Tab[] = [
  { page: 'home', label: '首页', icon: 'home' },
  { page: 'order', label: '点单', icon: 'drop' },
  { page: 'orders', label: '水单', icon: 'order' },
  { page: 'assets', label: '资产', icon: 'box' },
  { page: 'profile', label: '我的', icon: 'user' },
];
const PAGES: Record<string, ComponentType<MemberPageProps>> = {
  home: MemberHome, order: MemberOrderPage, orders: MemberOrders, assets: MemberAssets, records: MemberRecords, profile: MemberProfilePage, addresses: MemberAddresses,
};

type SheetState = { orderNo: string; code: string } | null;

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
  const dialogs = useDialogs();
  const toast = useToast();
  const { profile, error, refresh } = useMemberData();
  const [sheet, setSheet] = useState<SheetState>(null);
  const route = resolveRoute(location.pathname);
  const page = route?.area === 'member' ? route.page : null;

  const firstVisit = useRef(true);
  useEffect(() => {
    if (firstVisit.current) { firstVisit.current = false; return; }
    if (page === 'home' || page === 'order' || page === 'orders' || page === 'profile') refresh().catch(e => toast(e.message));
  }, [page, refresh, toast]);

  if (!route || route.area !== 'member') return <Navigate to={pathFor('member')} replace />;
  if (route.path !== location.pathname) return <Navigate to={route.path + location.search} replace />;

  const go = (target: string) => navigate(pathFor('member', target));
  const Page = PAGES[route.page];
  const overlay = sheet && <PickupCodeSheet orderNo={sheet.orderNo} code={sheet.code} onClose={() => setSheet(null)} />;

  return (
    <H5Shell title="绿麒麟水站" tabs={TABS} active={route.page === 'addresses' ? 'profile' : route.page} page={route.page} onNavigate={go} overlay={overlay}>
      {profile ? (
        <Page
          profile={profile}
          go={go}
          openOrder={(mode: FulfillMode) => navigate(`${pathFor('member', 'order')}?mode=${mode === 'PICKUP' ? 'pickup' : 'delivery'}`)}
          showPickup={(orderNo, code) => setSheet({ orderNo, code })}
          openAssets={() => dialogs.open(close => <MemberAssetsDialog memberId={profile.id} memberName={profile.name} members={[]} onClose={close} onDone={refresh} />)}
        />
      ) : <Loading error={error} onRetry={() => refresh().catch(() => undefined)} />}
    </H5Shell>
  );
}
