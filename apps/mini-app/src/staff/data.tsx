import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { ContainerSummaryItem, MemberProfile, Paged, WaterOrder, WaterProduct } from '@kunlun/shared';
import { useAuth } from '@kunlun/ui';

/** Members per search page; 加载更多 appends the next one. */
const MEMBER_PAGE = 20;

interface StaffData {
  /** The first pages of members matching `query`, newest first. */
  members: MemberProfile[];
  memberTotal: number;
  loadMoreMembers(): Promise<void>;
  orders: WaterOrder[];
  products: WaterProduct[];
  containers: ContainerSummaryItem[];
  loaded: boolean;
  error: string;
  query: string;
  setQuery(query: string): void;
  /** The member last opened from the member list; operation dialogs preselect them. */
  selectedMemberId: string | undefined;
  setSelectedMemberId(id: string | undefined): void;
  refresh(): Promise<void>;
}

const StaffDataContext = createContext<StaffData | null>(null);

export function useStaffData() {
  const value = useContext(StaffDataContext);
  if (!value) throw new Error('StaffDataProvider is missing');
  return value;
}

export function StaffDataProvider({ children }: { children: ReactNode }) {
  const { api } = useAuth();
  const [members, setMembers] = useState<MemberProfile[]>([]);
  const [memberTotal, setMemberTotal] = useState(0);
  const [orders, setOrders] = useState<WaterOrder[]>([]);
  const [products, setProducts] = useState<WaterProduct[]>([]);
  const [containers, setContainers] = useState<ContainerSummaryItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [selectedMemberId, setSelectedMemberId] = useState<string>();
  const queryRef = useRef(query);
  queryRef.current = query;
  const membersRef = useRef(members);
  membersRef.current = members;
  // Bumped whenever the member list is replaced, so an in-flight 加载更多 for the old list is dropped.
  const memberList = useRef(0);
  const showMembers = useCallback((page: Paged<MemberProfile>) => {
    memberList.current++;
    setMembers(page.rows); setMemberTotal(page.total);
  }, []);

  const refresh = useCallback(async () => {
    try {
      // Reload from the top but keep as many rows as were already shown, so the member being served stays in the list.
      const rows = Math.min(100, Math.max(MEMBER_PAGE, membersRef.current.length));
      const [m, o, p, c] = await Promise.all([api.membersPage({ q: queryRef.current, pageSize: rows }), api.listOrders(), api.listProducts(), api.containerSummary()]);
      showMembers(m); setOrders(o); setProducts(p); setContainers(c); setLoaded(true); setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      throw e;
    }
  }, [api, showMembers]);
  useEffect(() => { refresh().catch(() => undefined); }, [refresh]);

  const loadMoreMembers = useCallback(async () => {
    const list = memberList.current, shown = membersRef.current;
    const next = await api.membersPage({ q: queryRef.current, page: Math.floor(shown.length / MEMBER_PAGE) + 1, pageSize: MEMBER_PAGE });
    if (list !== memberList.current) return;
    // Members created meanwhile shift the pages down; skip rows that are already shown.
    const ids = new Set(shown.map(m => m.id));
    setMembers([...shown, ...next.rows.filter(m => !ids.has(m.id))]);
    setMemberTotal(next.total);
  }, [api]);

  const searched = useRef(false);
  useEffect(() => {
    if (!searched.current) { searched.current = true; return; }
    let alive = true;
    const timer = window.setTimeout(() => {
      api.membersPage({ q: query, pageSize: MEMBER_PAGE }).then(m => alive && showMembers(m)).catch(e => alive && setError(e.message));
    }, 200);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [api, query, showMembers]);

  return (
    <StaffDataContext.Provider value={{ members, memberTotal, loadMoreMembers, orders, products, containers, loaded, error, query, setQuery, selectedMemberId, setSelectedMemberId, refresh }}>
      {children}
    </StaffDataContext.Provider>
  );
}
