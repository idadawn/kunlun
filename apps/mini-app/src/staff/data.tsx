import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { ContainerSummaryItem, MemberProfile, WaterOrder, WaterProduct } from '@kunlun/shared';
import { useAuth } from '@kunlun/ui';

interface StaffData {
  members: MemberProfile[];
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
  const [orders, setOrders] = useState<WaterOrder[]>([]);
  const [products, setProducts] = useState<WaterProduct[]>([]);
  const [containers, setContainers] = useState<ContainerSummaryItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [selectedMemberId, setSelectedMemberId] = useState<string>();
  const queryRef = useRef(query);
  queryRef.current = query;

  const refresh = useCallback(async () => {
    try {
      const [m, o, p, c] = await Promise.all([api.listMembers(queryRef.current), api.listOrders(), api.listProducts(), api.containerSummary()]);
      setMembers(m); setOrders(o); setProducts(p); setContainers(c); setLoaded(true); setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      throw e;
    }
  }, [api]);
  useEffect(() => { refresh().catch(() => undefined); }, [refresh]);

  const searched = useRef(false);
  useEffect(() => {
    if (!searched.current) { searched.current = true; return; }
    let alive = true;
    const timer = window.setTimeout(() => {
      api.listMembers(query).then(m => alive && setMembers(m)).catch(e => alive && setError(e.message));
    }, 200);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [api, query]);

  return (
    <StaffDataContext.Provider value={{ members, orders, products, containers, loaded, error, query, setQuery, selectedMemberId, setSelectedMemberId, refresh }}>
      {children}
    </StaffDataContext.Provider>
  );
}
