import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { rememberProducts, type MemberProfile, type WaterOrder } from '@kunlun/shared';
import { useAuth } from '@kunlun/ui';

interface MemberData {
  profile: MemberProfile | null;
  orders: WaterOrder[];
  error: string;
  refresh(): Promise<void>;
}

const MemberDataContext = createContext<MemberData | null>(null);

export function useMemberData() {
  const value = useContext(MemberDataContext);
  if (!value) throw new Error('MemberDataProvider is missing');
  return value;
}

/** The signed-in member's own profile and water orders; the server enforces self-only, read-only access. */
export function MemberDataProvider({ children }: { children: ReactNode }) {
  const { api, user } = useAuth();
  const [profile, setProfile] = useState<MemberProfile | null>(null);
  const [orders, setOrders] = useState<WaterOrder[]>([]);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    try {
      const [p, o, products] = await Promise.all([api.memberProfile(user.subjectId), api.listOrders({ memberId: user.subjectId }), api.listProducts()]);
      rememberProducts(products);
      setProfile(p); setOrders(o); setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      throw e;
    }
  }, [api, user.subjectId]);
  useEffect(() => { refresh().catch(() => undefined); }, [refresh]);
  return <MemberDataContext.Provider value={{ profile, orders, error, refresh }}>{children}</MemberDataContext.Provider>;
}
