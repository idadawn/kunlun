import {
  KUNLUN_PERMISSIONS as P, containerKind, money, waterFallbackLabel,
  type ContainerSummaryItem, type ContainerType, type FinanceSummaryReport, type OverviewReport, type WaterOrder,
} from '@kunlun/shared';
import { Icon, useAuth } from '@kunlun/ui';
import { useExport, useGo, useOperations } from '../common';
import { PeriodOverview } from './PeriodOverview';
import { useAdminData } from '../data';

const EMPTY_CONTAINER: ContainerSummaryItem = {
  containerType: 'BUCKET', unitDeposit: 0, totalQty: 0, inStationQty: 0, withCustomersQty: 0, memberHeldQty: 0,
  damagedQty: 0, scrappedQty: 0, warnThreshold: 0, countedAt: null, identityValid: true, lowStockWarning: false,
};

export function Dashboard() {
  const { can } = useAuth();
  const { orders, orderTotal, overview, finance, containers, pendingRefunds, loaded } = useAdminData();
  const go = useGo();
  const exportCsv = useExport();
  const ops = useOperations();
  const aggregate = (kind: ContainerType) => containers.filter(c => containerKind(c.containerType) === kind).reduce((sum, c) => ({
    ...sum, inStationQty: sum.inStationQty + c.inStationQty, withCustomersQty: sum.withCustomersQty + c.withCustomersQty,
    memberHeldQty: sum.memberHeldQty + c.memberHeldQty, damagedQty: sum.damagedQty + c.damagedQty, scrappedQty: sum.scrappedQty + c.scrappedQty,
    totalQty: sum.totalQty + c.totalQty, warnThreshold: sum.warnThreshold + c.warnThreshold,
    identityValid: sum.identityValid && c.identityValid, lowStockWarning: sum.lowStockWarning || c.lowStockWarning,
  }), { ...EMPTY_CONTAINER, containerType: kind });
  const bucket = aggregate('BUCKET');
  const bag = aggregate('BAG');
  const balanced = bucket.identityValid && bag.identityValid;
  const allOrdersLoaded = loaded && orders.length === orderTotal;
  const pendingCount = (mode: 'DELIVERY' | 'PICKUP') => allOrdersLoaded
    ? orders.filter(o => o.status === 'PENDING' && o.fulfillMode === mode).length : '—';
  const pendingDelivery = overview?.pendingDelivery ?? pendingCount('DELIVERY');
  const pendingPickup = overview?.pendingPickup ?? pendingCount('PICKUP');
  const dispatched = overview?.dispatched ?? (allOrdersLoaded ? orders.filter(o => o.status === 'DISPATCHED').length : '—');

  return <>
    <div className="page-head operating-heading">
      <h2>经营总览</h2>
      <div className="head-actions">
        {can(P.ReportExport) && <button type="button" className="btn sm" onClick={() => exportCsv('ticket-ledgers')}><Icon name="export" size="sm" />导出水票流水</button>}
        {can(P.OrderCreate) && <button type="button" className="btn primary sm" onClick={() => ops.order()}><Icon name="plus" size="sm" />门店点单</button>}
      </div>
    </div>
    {can(P.ExpenseManage) || can(P.ReportExport) ? <PeriodOverview /> : <p className="period-status">查看经营统计需要费用支出或报表权限。</p>}

    <h3 className="station-section">门店当前情况</h3>
    {loaded ? <>
      <div className="bottom-grid">
        <div className="card">
          <div className="card-head"><div className="card-title">待处理事项</div><button type="button" className="text-btn" onClick={() => go('orders')}>查看水单 ›</button></div>
          <div className="todo-list">
            <div className="todo-item"><div className="todo-symbol"><Icon name="truck" /></div><div className="todo-text"><b>待接单配送</b><small>请及时指派或提醒送水员接单</small></div><span className="todo-num">{pendingDelivery}</span><button type="button" className="text-btn" onClick={() => go('orders')}>处理</button></div>
            <div className="todo-item"><div className="todo-symbol green"><Icon name="store" /></div><div className="todo-text"><b>待确认自提</b><small>会员到店出示取水码后核销</small></div><span className="todo-num">{pendingPickup}</span><button type="button" className="text-btn" onClick={() => go('orders')}>处理</button></div>
            <div className="todo-item"><div className="todo-symbol"><Icon name="truck" /></div><div className="todo-text"><b>配送中</b><small>送达后确认实际交付数量</small></div><span className="todo-num">{dispatched}</span><button type="button" className="text-btn" onClick={() => go('orders')}>查看</button></div>
            <div className="todo-item"><div className="todo-symbol blue"><Icon name="check" /></div><div className="todo-text"><b>待审核</b><small>手动赠送、收押金、损坏不赔付和店员的退款，按审核开关等管理员处理</small></div><span className="todo-num">{pendingRefunds ?? '—'}</span><button type="button" className="text-btn" onClick={() => go('refunds')}>审核</button></div>
            <div className="todo-item"><div className="todo-symbol"><Icon name="box" /></div><div className="todo-text"><b>店里的桶{bucket.lowStockWarning ? '偏少' : ''}</b><small>{`店里能用 ${bucket.inStationQty} 个${bucket.warnThreshold > 0 ? `，少于 ${bucket.warnThreshold} 个时提醒` : ''}`}</small></div><button type="button" className="text-btn" onClick={() => go('inventory')}>看库存</button></div>
          </div>
        </div>
        <div className="card">
          <div className="card-head"><div className="card-title">最新水单</div><button type="button" className="text-btn" onClick={() => go('orders')}>全部水单 ›</button></div>
          <div className="order-mini">
            <div className="order-row head"><span>会员 / 单号</span><span>方式</span><span>水品与数量</span><span>状态</span></div>
            {orders.length === 0 ? <div style={{ padding: '18px 0', color: 'var(--muted)', textAlign: 'center', fontSize: 12.5 }}>暂无水单，可通过「门店点单」创建</div>
              : orders.slice(0, 4).map(o => (
                <div key={o.id} className="order-row">
                  <span><b>{o.addressSnapshot?.contactName || '会员'}</b><br /><small style={{ color: 'var(--muted)' }}>{o.orderNo}</small></span>
                  <span>{o.fulfillMode === 'PICKUP' ? '自提' : '配送'}</span>
                  <span>{o.productSnapshot?.waterLabel || waterFallbackLabel(o.waterType)} × {o.orderQty}</span>
                  <OrderTag order={o} />
                </div>
              ))}
          </div>
        </div>
      </div>
      {finance && <Liabilities finance={finance} overview={overview} />}
      <div className="card">
        <div className="card-head"><div className="card-title">桶袋在哪 <small>桶、袋分开算</small></div><button type="button" className="text-btn" onClick={() => go('inventory')}>看库存 ›</button></div>
        <div className="asset-content">
          <AssetLine label="周转桶" c={bucket} />
          <div style={{ marginTop: 18 }}><AssetLine label="周转水袋" c={bag} aqua /></div>
          <div className={`identity-formula${balanced ? '' : ' warn'}`}><span>{balanced ? '✓ 数量对得上' : '数量对不上，请核对'}</span><b>合计 = 店里 + 客户手里 + 待确认报废</b></div>
        </div>
      </div>
    </> : <p className="period-status" role="status">正在读取门店情况…</p>}
  </>;
}

/**
 * 可能要退给会员的钱：押金和会员还没用完的水费都收在账上，但会员退桶、退水费时要还回去，不是赚的钱。
 * 水费净收拆成「已经用掉」（真正的收入）和「还没用完」两段，让人一眼分清哪些钱是自己的。
 */
function Liabilities({ finance: f, overview }: { finance: FinanceSummaryReport; overview: OverviewReport | null }) {
  const go = useGo();
  const net = Number(f.rechargeNetReceived);
  const earned = Number(f.rechargeEarnedTotal);
  const used = net > 0 ? Math.min(100, Math.max(0, earned / net * 100)) : 0;
  // Packages members bought before the system: owed back like recharges, but that money never came in as 水费实收.
  const openingUnused = Number(f.openingUnusedValue ?? 0);
  const openingRefunded = Number(f.undatedOpeningOut ?? 0);
  const unused = Number(f.unusedRechargeValue) + openingUnused;
  return (
    <div className="card liability-card">
      <div className="card-head">
        <div className="card-title">可能要退给会员的钱 <small>押金和没用完的水费都在账上，会员要回去时得退，不是赚的钱</small></div>
        <div className="liability-links">
          <button type="button" className="text-btn" onClick={() => go('deposits')}>押金明细 ›</button>
          <button type="button" className="text-btn" onClick={() => go('recharges')}>水费明细 ›</button>
        </div>
      </div>
      <div className="liability-body">
        <div className="liability-sum">
          <div className="liability-item">
            <span><Icon name="deposit" size="sm" />押金在池</span>
            <b>¥ {money(f.unrefundedDepositPoolTotal)}</b>
            <small>会员在池押金总额{overview ? ` · 当前可退 ¥${money(overview.refundableDeposit)}` : ''}</small>
          </div>
          <i className="liability-op" aria-hidden="true">+</i>
          <div className="liability-item">
            <span><Icon name="wallet" size="sm" />没用完的水费</span>
            <b>¥ {money(unused)}</b>
            <small>
              剩余付费水票 {Number(f.unusedPaidTicketQty) + Number(f.openingPaidTicketQty ?? 0)} 张，按原实付单价折算
              {openingUnused > 0 && `；其中上系统前买的 ${f.openingPaidTicketQty} 张 ¥${money(openingUnused)}`}
              {f.unusedGiftTicketQty ? `；赠票 ${f.unusedGiftTicketQty} 张退款时收回、不退钱` : ''}
            </small>
          </div>
          <i className="liability-op" aria-hidden="true">=</i>
          <div className="liability-item total">
            <span><Icon name="refund" size="sm" />合计可能要退</span>
            <b>¥ {money(f.potentialRefundTotal)}</b>
            <small>{f.legacyTicketQty ? `另有 ${f.legacyTicketQty} 张水票没有原价（历史余额、套餐不清楚），未计入` : '会员全部退桶、退清水费时要还回去的钱'}</small>
          </div>
        </div>
        <div className="liability-split">
          <div className="liability-split-text">
            <span>水费净收<b>¥{money(net)}</b></span>
            <span>= 会员已经用掉的（真正的收入）<b className="earned">¥{money(earned)}</b></span>
            <span>+ 还没用完的（可能要退）<b className="unused">¥{money(Number(f.unusedRechargeValue) + Number(f.datedOpeningUnused ?? 0))}</b></span>
            {openingRefunded > 0 && <span>− 未归期开卡水费的退款及转押金<b className="unused">¥{money(openingRefunded)}</b></span>}
          </div>
          {net > 0 && <div className="liability-bar" role="img" aria-label={`水费净收中会员已用掉 ${Math.round(used)}%`}><i style={{ width: `${used}%` }} /></div>}
          {openingUnused > 0 && <small className="liability-note">上系统前买的套餐还没用完 ¥{money(openingUnused)}：其中已填开卡日期的套餐按开卡日计入实收。</small>}
        </div>
      </div>
    </div>
  );
}

function OrderTag({ order: o }: { order: WaterOrder }) {
  if (o.status === 'COMPLETED') return <span className="tag gray">已完成</span>;
  if (o.status === 'CANCELLED') return <span className="tag red">已取消</span>;
  if (o.fulfillMode === 'PICKUP') return <span className="tag aqua dot">待自提({o.pickupCode})</span>;
  return <span className="tag orange dot">{o.status === 'DISPATCHED' ? '配送中' : '待接单'}</span>;
}

function AssetLine({ label, c, aqua = false }: { label: string; c: ContainerSummaryItem; aqua?: boolean }) {
  const pct = Math.min(100, Math.round(c.withCustomersQty / Math.max(1, c.totalQty) * 100));
  return <>
    <div className="asset-line"><span>{label}</span><span>客户手里 <b>{c.withCustomersQty}</b> / 合计 <b>{c.totalQty}</b></span></div>
    <div className="progress"><i style={{ width: `${pct}%`, ...(aqua ? { background: 'var(--grad-aqua)' } : {}) }} /></div>
    <div className="asset-meta"><span>店里能用 {c.inStationQty}</span><span>待确认报废 {c.damagedQty}</span><span>累计报废 {c.scrappedQty}</span></div>
  </>;
}
