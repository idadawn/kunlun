import type { ReactNode } from 'react';
import {
  KUNLUN_BRAND, containerLabel, isActiveOrder, mobileLayout, money, orderStatusLabel, waterFallbackLabel,
  type ContainerSummaryItem, type MobileFeature, type MobileFeatureKey, type OverviewReport, type WaterOrder,
} from '@kunlun/shared';
import { Icon, type IconName } from './icons';

/*
 * 员工手机端工作台。员工端用真实数据渲染，管理端「移动端配置」在手机框里用同一组件预览，两边显示一致。
 * 样式在 ./workbench.css，由使用方显式引入（会员端不需要）。
 */

export interface WorkbenchTab { page: string; label: string; icon: IconName }

/** 工作台 · the role's first features with a page · 我的. */
export function workbenchTabs(features: readonly string[] | null | undefined): WorkbenchTab[] {
  return [
    { page: 'home', label: '工作台', icon: 'home' },
    ...mobileLayout(features).tabs.map(f => ({ page: f.page!, label: f.tab ?? f.label, icon: f.icon as IconName })),
    { page: 'profile', label: '我的', icon: 'user' },
  ];
}

/** The staff app's bottom tab bar. */
export function WorkbenchTabBar({ tabs, active, onNavigate }: { tabs: WorkbenchTab[]; active: string; onNavigate: (page: string) => void }) {
  return (
    <nav className="h5-bottom" aria-label="底部导航">
      {tabs.map(tab => (
        <button key={tab.page} type="button" className={`h5-nav${tab.page === active ? ' active' : ''}`} aria-current={tab.page === active ? 'page' : undefined} onClick={() => onNavigate(tab.page)}>
          <Icon name={tab.icon} />{tab.label}
        </button>
      ))}
    </nav>
  );
}

/** H5 water order card. Staff see the delivery contact from the order's address snapshot. */
export function OrderCard({ order, title, showContact = false, actions }: { order: WaterOrder; title: string; showContact?: boolean; actions?: ReactNode }) {
  const active = isActiveOrder(order);
  const snapshot = order.addressSnapshot;
  const delivery = order.fulfillMode === 'DELIVERY';
  return (
    <div className="h5-order">
      <div className="h5-order-top">
        <div><b>{title}</b><small>{order.orderNo}</small></div>
        <span className={`tag ${active ? 'orange' : 'gray'}`}>{orderStatusLabel(order)}</span>
      </div>
      <div className="h5-product">
        <div>
          <b>{order.productSnapshot?.waterLabel || waterFallbackLabel(order.waterType)} × {order.orderQty}</b>
          <small>{delivery ? snapshot?.address || '未设置配送地址' : '到店自提'}</small>
        </div>
      </div>
      {showContact && delivery && snapshot?.contactPhone && (
        <div className="h5-address"><Icon name="phone" />收货人 {snapshot.contactName} <a href={`tel:${snapshot.contactPhone}`}>{snapshot.contactPhone}</a></div>
      )}
      {order.remark && <div className="h5-address">备注：{order.remark}</div>}
      <div className="h5-order-foot">
        <small>{active ? `预占 ${order.reservedQty} 张` : `实取 ${order.actualQty || 0} 张`}</small>
        {actions && <div className="membership-actions">{actions}</div>}
      </div>
    </div>
  );
}

export interface WorkbenchData {
  name: string;
  account: string;
  /** Newest orders; undefined while loading. */
  orders?: WaterOrder[];
  memberTotal?: number;
  containers?: ContainerSummaryItem[];
  overview?: OverviewReport | null;
}

const num = (value: number | undefined) => (value === undefined ? '—' : value);

/**
 * The workbench home: greeting, the numbers that matter to the role, today's figures, shortcuts in the configured
 * order, open orders and low stock. What shows follows the role's features through `mobileLayout`.
 */
export function WorkbenchHome({ features, data, onOpen, renderOrder, highlight, ordersFallback }: {
  features: readonly string[];
  data: WorkbenchData;
  onOpen: (feature: MobileFeature) => void;
  renderOrder?: (order: WaterOrder) => ReactNode;
  /** Briefly marks a feature, e.g. the one just added in the console. */
  highlight?: string | null;
  /** Shown instead of the open orders while they load or failed to load. */
  ordersFallback?: ReactNode;
}) {
  const layout = mobileLayout(features);
  const feature = (key: MobileFeatureKey) => layout.features.find(f => f.key === key);
  const orders = data.orders;
  const active = orders?.filter(isActiveOrder);
  const delivering = active?.filter(o => o.fulfillMode === 'DELIVERY').length;
  const picking = active?.filter(o => o.fulfillMode === 'PICKUP').length;
  const low = data.containers?.filter(c => c.lowStockWarning).length;

  const stats: Array<[string, number | undefined]> = [];
  if (layout.has('orders')) stats.push(['待配送', delivering]);
  if (layout.has('orders') || layout.has('pickup')) stats.push(['待自提', picking]);
  if (layout.has('members')) stats.push(['会员', data.memberTotal]);
  if (layout.has('inventory')) stats.push(['桶袋偏少', low]);

  const ordersFeature = feature('orders');
  const stockFeature = feature('inventory');
  const flash = (key: string) => (highlight === key ? ' wb-flash' : '');
  const showOrder = renderOrder ?? ((o: WaterOrder) => <OrderCard key={o.id} order={o} title={o.addressSnapshot?.contactName || '会员'} showContact />);

  return <>
    <div className="h5-hero">
      <div className="h5-status">
        <div className="h5-greeting"><small>{KUNLUN_BRAND.signage}</small><h2>{data.name}，你好</h2></div>
        {ordersFeature && (
          <button type="button" className="hero-bell" aria-label="待办水单" onClick={() => onOpen(ordersFeature)}>
            <Icon name="bell" />{!!active?.length && <i className="dot" />}
          </button>
        )}
      </div>
      <div className="shift-card"><span>当前账号：{data.account}</span><em>{KUNLUN_BRAND.slogan}</em></div>
    </div>
    <div className="h5-body overlap">
      {layout.features.length === 0 && (
        <div className="h5-card wb-empty">
          <span className="quick-icon"><Icon name="mobile" size="lg" /></span>
          <b>还没有开通手机端功能</b>
          <p>请联系管理员在「系统设置 → 移动端配置」为你的角色开通。</p>
        </div>
      )}
      {stats.length > 0 && (
        <div className="h5-card">
          <div className="work-numbers" style={{ gridTemplateColumns: `repeat(${Math.min(stats.length, 3)}, 1fr)` }}>
            {stats.slice(0, 3).map(([label, value]) => <div key={label} className="work-number"><b>{num(value)}</b><small>{label}</small></div>)}
          </div>
        </div>
      )}
      {layout.has('overview') && <OverviewCard overview={data.overview} className={flash('overview')} />}
      {layout.shortcuts.length > 0 && <>
        <div className="h5-section-head"><h3>快捷办理</h3><span>先选会员 · 独立记账</span></div>
        <div className="h5-card">
          <div className="quick-grid">
            {layout.shortcuts.map(f => (
              <button key={f.key} type="button" className={`quick-item${flash(f.key)}`} onClick={() => onOpen(f)}>
                <span className={`quick-icon ${f.tone}`.trim()}><Icon name={f.icon as IconName} size="lg" /></span>{f.label}
              </button>
            ))}
          </div>
        </div>
      </>}
      {ordersFeature && <div className={`wb-section${flash('orders')}`}>
        <div className="h5-section-head"><h3>待办水单</h3><button type="button" className="link" onClick={() => onOpen(ordersFeature)}>全部 {orders?.length ?? 0} 单 ›</button></div>
        {!active ? ordersFallback ?? <p className="membership-note">正在加载…</p>
          : active.length ? active.slice(0, 3).map(showOrder)
          : <p className="membership-note">暂无待办水单</p>}
      </div>}
      {stockFeature && <div className={`wb-section${flash('inventory')}`}>
        <div className="h5-section-head"><h3>店里桶袋</h3><button type="button" className="link" onClick={() => onOpen(stockFeature)}>库存明细 ›</button></div>
        <div className="h5-card wb-stock">
          {!data.containers ? <p className="membership-note">正在加载…</p>
            : data.containers.length === 0 ? <p className="membership-note">还没有水品和配套桶袋</p>
            : data.containers.map(c => (
              <div key={c.containerType} className="wb-stock-row">
                <span>{containerLabel(c.containerType)}</span>
                {c.lowStockWarning && <span className="tag orange">偏少</span>}
                <b>{c.inStationQty}</b><small>个在店</small>
              </div>
            ))}
        </div>
      </div>}
    </div>
  </>;
}

/** 今日经营: today's recharges and water out, open orders, and the last seven days of recharges as bars. */
function OverviewCard({ overview, className = '' }: { overview?: OverviewReport | null; className?: string }) {
  const trend = overview?.trend ?? [];
  const today = trend[trend.length - 1];
  const peak = Math.max(1, ...trend.map(d => Number(d.rechargeAmount)));
  return (
    <div className={`h5-card wb-overview${className}`}>
      <div className="wb-card-head"><b>今日经营</b><small>全站实时</small></div>
      <div className="wb-overview-grid">
        <div><small>今日充值</small><b>{overview ? `¥${money(today?.rechargeAmount ?? 0)}` : '—'}</b></div>
        <div><small>今日用水</small><b>{overview ? today?.waterQty ?? 0 : '—'}</b></div>
        <div><small>待配送</small><b>{overview ? overview.pendingDelivery + overview.dispatched : '—'}</b></div>
        <div><small>待自提</small><b>{overview ? overview.pendingPickup : '—'}</b></div>
      </div>
      {trend.length > 0 && (
        <div className="wb-trend" role="img" aria-label={`近 7 天充值：${trend.map(d => `${d.date.slice(5)} ¥${money(d.rechargeAmount)}`).join('，')}`}>
          {trend.map(d => <i key={d.date} style={{ height: `${Math.max(6, (Number(d.rechargeAmount) / peak) * 100)}%` }} title={`${d.date.slice(5)} ¥${money(d.rechargeAmount)}`} />)}
        </div>
      )}
    </div>
  );
}
