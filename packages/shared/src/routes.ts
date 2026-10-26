/** Clean application routes shared by the React apps, dev servers, tests and deployment checks. */
export type AppArea = 'admin' | 'staff' | 'member';

export interface AreaRoutes {
  home: string;
  pages: readonly string[];
  aliases?: Readonly<Record<string, string>>;
}

export const WEB_ROUTES: Record<AppArea, AreaRoutes> = {
  admin: {
    home: 'dashboard',
    pages: ['dashboard', 'members', 'orders', 'recharges', 'deposits', 'inventory', 'assets', 'products', 'plans', 'coupons', 'staff-accounts'],
    // finance 是充值、押金分页前的合并页地址，旧链接落到水费充值。
    aliases: { settings: 'plans', 'deposit-settings': 'products', finance: 'recharges' },
  },
  staff: {
    home: 'home',
    pages: ['home', 'order', 'orders', 'members', 'profile'],
  },
  member: {
    home: 'home',
    pages: ['home', 'order', 'orders', 'assets', 'records', 'profile', 'addresses'],
  },
};

export interface ResolvedRoute {
  area: AppArea;
  page: string;
  path: string;
}

const isArea = (value: string | undefined): value is AppArea => !!value && Object.hasOwn(WEB_ROUTES, value);

export function normalizePage(area: AppArea, page?: string): string {
  const routes = WEB_ROUTES[area];
  const target = page || routes.home;
  return routes.aliases?.[target] ?? target;
}

export function pathFor(area: AppArea, page?: string): string {
  const target = normalizePage(area, page);
  if (!WEB_ROUTES[area].pages.includes(target)) throw new Error('页面不存在');
  return '/' + area + (target === WEB_ROUTES[area].home ? '' : '/' + target);
}

/** Resolves `/admin`, `/admin/plans` and aliases. Legacy `.html` and hash links are not application routes. */
export function resolveRoute(pathname: string): ResolvedRoute | null {
  let path: string;
  try { path = decodeURIComponent(pathname); } catch { return null; }
  const parts = path.split('/').filter(Boolean);
  const area = parts[0];
  if (!isArea(area) || parts.length > 2) return null;
  const page = normalizePage(area, parts[1]);
  if (!WEB_ROUTES[area].pages.includes(page)) return null;
  return { area, page, path: pathFor(area, page) };
}
