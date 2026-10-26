import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  KUNLUN_PERMISSIONS as P,
  type ContainerLedgerRow, type ContainerSummaryItem, type DepositLedgerRow, type FinanceSummaryReport, type MemberProfile,
  type OverviewReport, type RechargeLedgerRow, type RechargePlan, type WaterOrder, type WaterProduct,
} from '@kunlun/shared';
import { useAuth, useToast } from '@kunlun/ui';

export interface AdminSnapshot {
  members: MemberProfile[];
  plans: RechargePlan[];
  products: WaterProduct[];
  orders: WaterOrder[];
  containers: ContainerSummaryItem[];
  finance: FinanceSummaryReport | null;
  overview: OverviewReport | null;
  recharges: RechargeLedgerRow[];
  deposits: DepositLedgerRow[];
  containerLedgers: ContainerLedgerRow[];
}

interface AdminData extends AdminSnapshot {
  loaded: boolean;
  /** Increments after every successful refresh so pages with their own queries can reload too. */
  version: number;
  memberQuery: string;
  setMemberQuery(query: string): void;
  selectedMemberId: string | null;
  setSelectedMemberId(id: string | null): void;
  refresh(): Promise<void>;
}

const EMPTY: AdminSnapshot = { members: [], plans: [], products: [], orders: [], containers: [], finance: null, overview: null, recharges: [], deposits: [], containerLedgers: [] };
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
  const [memberQuery, setMemberQuery] = useState('');
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null);
  const generation = useRef(0);
  const query = useRef(memberQuery);
  query.current = memberQuery;

  const refresh = useCallback(async () => {
    const mine = ++generation.current;
    const reports = can(P.ReportExport);
    const [members, plans, orders, containers, finance, recharges, deposits, containerLedgers, overview, products] = await Promise.all([
      api.listMembers(query.current),
      api.listPlans(),
      api.listOrders(),
      api.containerSummary(),
      reports ? api.financeSummary() : Promise.resolve(null),
      reports ? api.rechargeLedger() : Promise.resolve([]),
      reports ? api.depositLedger() : Promise.resolve([]),
      reports ? api.containerLedger() : Promise.resolve([]),
      reports ? api.overview() : Promise.resolve(null),
      api.listProducts(),
    ]);
    if (mine !== generation.current) return;
    setSnapshot({ members, plans, products, orders, containers, finance, overview, recharges, deposits, containerLedgers });
    setLoaded(true);
    setVersion(v => v + 1);
  }, [api, can]);

  useEffect(() => {
    const timer = window.setTimeout(() => refresh().catch(e => toast(e.message)), memberQuery ? 200 : 0);
    return () => window.clearTimeout(timer);
  }, [memberQuery, refresh, toast]);

  return (
    <AdminDataContext.Provider value={{ ...snapshot, loaded, version, memberQuery, setMemberQuery, selectedMemberId, setSelectedMemberId, refresh }}>
      {children}
    </AdminDataContext.Provider>
  );
}

/** The member last opened in the 360° drawer, used as the default in operation dialogs. */
export function useSelectedMemberId() {
  const { members, selectedMemberId } = useAdminData();
  return members.some(m => m.id === selectedMemberId) ? selectedMemberId! : members[0]?.id;
}
