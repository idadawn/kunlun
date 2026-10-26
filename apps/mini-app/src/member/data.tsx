import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { MemberProfile, WaterOrder, WaterProduct } from '@kunlun/shared';
import { useAuth } from '@kunlun/ui';

interface MemberData {
  profile: MemberProfile | null;
  orders: WaterOrder[];
  products: WaterProduct[];
  error: string;
  refresh(): Promise<void>;
}

const MemberDataContext = createContext<MemberData | null>(null);

export function useMemberData() {
  const value = useContext(MemberDataContext);
  if (!value) throw new Error('MemberDataProvider is missing');
  return value;
}

/** The signed-in member's own profile, orders and product catalogue; the server enforces self-only access. */
export function MemberDataProvider({ children }: { children: ReactNode }) {
  const { api, user } = useAuth();
  const [profile, setProfile] = useState<MemberProfile | null>(null);
  const [orders, setOrders] = useState<WaterOrder[]>([]);
  const [products, setProducts] = useState<WaterProduct[]>([]);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    try {
      const [p, o, w] = await Promise.all([api.memberProfile(user.subjectId), api.listOrders({ memberId: user.subjectId }), api.listProducts()]);
      setProfile(p); setOrders(o); setProducts(w); setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      throw e;
    }
  }, [api, user.subjectId]);
  useEffect(() => { refresh().catch(() => undefined); }, [refresh]);
  return <MemberDataContext.Provider value={{ profile, orders, products, error, refresh }}>{children}</MemberDataContext.Provider>;
}
