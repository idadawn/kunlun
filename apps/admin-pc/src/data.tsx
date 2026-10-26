import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  KUNLUN_PERMISSIONS as P,
  type ContainerSummaryItem, type FinanceSummaryReport, type MemberProfile, type MemberQuery,
  type OverviewReport, type RechargePlan, type WaterOrder, type WaterProduct,
} from '@kunlun/shared';
import { useAuth, useToast } from '@kunlun/ui';

/** Members per page of the 会员管理 list. */
export const MEMBER_PAGE_SIZE = 20;
/** Newest orders kept for the dashboard and badges; the 水单管理 table pages on its own. */
const RECENT_ORDERS = 50;

export type MemberFilter = Pick<MemberQuery, 'status' | 'water'>;

export interface AdminSnapshot {
  /** The current page of the 会员管理 list (search, filters and page below). */
  members: MemberProfile[];
  memberTotal: number;
  plans: RechargePlan[];
  products: WaterProduct[];
  orders: WaterOrder[];
  orderTotal: number;
  containers: ContainerSummaryItem[];
  finance: FinanceSummaryReport | null;
  overview: OverviewReport | null;
}

interface AdminData extends AdminSnapshot {
  loaded: boolean;
  /** Increments after every successful refresh so pages with their own queries can reload too. */
  version: number;
  memberQuery: string;
  setMemberQuery(query: string): void;
  memberFilter: MemberFilter;
  setMemberFilter(filter: MemberFilter): void;
  memberPage: number;
  setMemberPage(page: number): void;
  /** The member last opened in the 360° drawer; operation dialogs preselect them. */
  selectedMemberId: string | null;
  setSelectedMemberId(id: string | null): void;
  refresh(): Promise<void>;
}

const EMPTY: AdminSnapshot = { members: [], memberTotal: 0, plans: [], products: [], orders: [], orderTotal: 0, containers: [], finance: null, overview: null };
const AdminDataContext = createContext<AdminData | null>(null);

export function useAdminData() {
  const value = useContext(AdminDataContext);
  if (!value) throw new Error('AdminDataProvider is missing');
  return value;
}

export function AdminDataProvider({ children }: { children: ReactNode }) {
  const { api, can } = useAuth();
  const toast = useToast();
  const [snapshot, setSnapshot] = useState<AdminSnapshot>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [version, setVersion] = useState(0);
  const [memberQuery, setQuery] = useState('');
  const [memberFilter, setFilter] = useState<MemberFilter>({});
  const [memberPage, setMemberPage] = useState(1);
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null);
  const generation = useRef(0);
  const memberParams = useRef<MemberQuery>({});
  memberParams.current = { q: memberQuery, ...memberFilter, page: memberPage, pageSize: MEMBER_PAGE_SIZE };

  const refresh = useCallback(async () => {
    const mine = ++generation.current;
    const reports = can(P.ReportExport);
    const [members, plans, orders, containers, finance, overview, products] = await Promise.all([
      api.membersPage(memberParams.current),
      api.listPlans(),
      api.ordersPage({ pageSize: RECENT_ORDERS }),
      api.containerSummary(),
      reports ? api.financeSummary() : Promise.resolve(null),
      reports ? api.overview() : Promise.resolve(null),
      api.listProducts(),
    ]);
    if (mine !== generation.current) return;
    setSnapshot({ members: members.rows, memberTotal: members.total, plans, products, orders: orders.rows, orderTotal: orders.total, containers, finance, overview });
    setLoaded(true);
    setVersion(v => v + 1);
  }, [api, can]);

  useEffect(() => {
    const timer = window.setTimeout(() => refresh().catch(e => toast(e.message)), memberQuery ? 200 : 0);
    return () => window.clearTimeout(timer);
  }, [memberQuery, memberFilter, memberPage, refresh, toast]);

  // A new search or filter starts again from the first page.
  const setMemberQuery = useCallback((query: string) => { setQuery(query); setMemberPage(1); }, []);
  const setMemberFilter = useCallback((filter: MemberFilter) => { setFilter(filter); setMemberPage(1); }, []);

  return (
    <AdminDataContext.Provider value={{
      ...snapshot, loaded, version, memberQuery, setMemberQuery, memberFilter, setMemberFilter, memberPage, setMemberPage,
      selectedMemberId, setSelectedMemberId, refresh,
    }}>
      {children}
    </AdminDataContext.Provider>
  );
}
