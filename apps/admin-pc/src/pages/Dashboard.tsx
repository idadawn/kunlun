import {
  KUNLUN_BRAND, KUNLUN_PERMISSIONS as P, containerKind, containerOf, dateFilterFrom, expenseCategoryLabel, money, waterFallbackLabel,
  type ContainerSummaryItem, type ContainerType, type FinanceSummaryReport, type OverviewReport, type WaterOrder,
} from '@kunlun/shared';
import { Icon, useAuth, useLoader } from '@kunlun/ui';
import { useExport, useGo, useOperations } from '../common';
import { useAdminData } from '../data';

const EMPTY_CONTAINER: ContainerSummaryItem = {
  containerType: 'BUCKET', unitDeposit: 0, totalQty: 0, inStationQty: 0, withCustomersQty: 0, memberHeldQty: 0,
  damagedQty: 0, scrappedQty: 0, warnThreshold: 0, countedAt: null, identityValid: true, lowStockWarning: false,
};

export function Dashboard() {
  const { user } = useAuth();
  const { orders, overview, finance, containers, pendingRefunds } = useAdminData();
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
  const completed = orders.filter(o => o.status === 'COMPLETED');
  const pendingDelivery = overview?.pendingDelivery ?? orders.filter(o => o.status === 'PENDING' && o.fulfillMode === 'DELIVERY').length;
  const pendingPickup = overview?.pendingPickup ?? orders.filter(o => o.status === 'PENDING' && o.fulfillMode === 'PICKUP').length;
  const dispatched = overview?.dispatched ?? orders.filter(o => o.status === 'DISPATCHED').length;
  const pending = pendingDelivery + pendingPickup + dispatched;
  const doneQty = (type: ContainerType) => completed.filter(o => containerKind(containerOf(o.waterType)) === type).reduce((s, o) => s + (o.actualQty ?? o.orderQty), 0);

  return <>
    <div className="hero-banner">
      <div>
        <span className="eyebrow"><Icon name="drop" size="sm" />{KUNLUN_BRAND.signage}</span>
        <h2>你好，{user.displayName}</h2>
        <p>{new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'full' })}</p>
      </div>
      <div className="slogan-pill">
        <b>{KUNLUN_BRAND.slogan}</b>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 8 }}>
          <button type="button" className="btn sm" onClick={() => exportCsv('ticket-ledgers')}><Icon name="export" size="sm" />导出水票流水</button>
          <button type="button" className="btn primary sm" onClick={() => ops.order()}><Icon name="plus" size="sm" />门店点单</button>
        </div>
      </div>
    </div>

    <div className="stats-grid">
      <div className="stat-card">
        <div className="stat-top"><span>水费净收（元）</span><span className="stat-icon"><Icon name="wallet" /></span></div>
        <div className="stat-value">{finance ? `¥ ${money(finance.rechargeNetReceived)}` : '—'}</div>
        <div className="stat-foot">{finance ? `不含押金 · 其中 ¥${money(finance.unusedRechargeValue)} 会员还没用完` : '需要报表权限'}</div>
      </div>
      <div className="stat-card">
        <div className="stat-top"><span>已核销用水</span><span className="stat-icon blue"><Icon name="drop" /></span></div>
        <div className="stat-value">{overview?.completedBuckets ?? doneQty('BUCKET')}<small>桶</small> · {overview?.completedBags ?? doneQty('BAG')}<small>袋</small></div>
        <div className="stat-foot">累计完结水单 <b>{overview?.completedOrders ?? completed.length}</b> 笔</div>
      </div>
      <div className="stat-card">
        <div className="stat-top"><span>待履约水单</span><span className="stat-icon orange"><Icon name="truck" /></span></div>
        <div className="stat-value">{pending}<small>单</small></div>
        <div className="stat-foot"><span style={{ color: 'var(--orange-500)' }}>待接单配送 {pendingDelivery}</span> · 配送中 {dispatched} · 待自提 {pendingPickup}</div>
      </div>
      <div className="stat-card">
        <div className="stat-top"><span>客户手里的桶袋</span><span className="stat-icon gold"><Icon name="box" /></span></div>
        <div className="stat-value">{bucket.withCustomersQty}<small>桶</small> / {bag.withCustomersQty}<small>袋</small></div>
        <div className="stat-foot">店里能用：桶 {bucket.inStationQty} · 袋 {bag.inStationQty}</div>
      </div>
    </div>

    <MonthCashflow />
    {finance && <Liabilities finance={finance} overview={overview} />}

    <div className="dashboard-grid">
      <div className="card">
        <div className="card-head"><div className="card-title">近 7 日经营趋势 <small>水费实收 / 核销用水量</small></div><span className="tag green">自然日口径</span></div>
        <div className="chart-wrap">
          <div className="chart-legend"><span><i className="legend-dot" />水费收款（左轴：元）</span><span><i className="legend-dot light" />核销水量（右轴：桶/袋）</span></div>
          <TrendChart overview={overview} />
        </div>
      </div>
      <div className="card">
        <div className="card-head"><div className="card-title">今日待办</div><button type="button" className="text-btn" onClick={() => go('orders')}>查看全部 ›</button></div>
        <div className="todo-list">
          <div className="todo-item"><div className="todo-symbol"><Icon name="truck" /></div><div className="todo-text"><b>待接单配送</b><small>请及时指派或提醒送水员接单</small></div><span className="todo-num">{pendingDelivery}</span><button type="button" className="text-btn" onClick={() => go('orders')}>处理</button></div>
          <div className="todo-item"><div className="todo-symbol green"><Icon name="store" /></div><div className="todo-text"><b>待确认自提</b><small>会员到店出示取水码后核销</small></div><span className="todo-num">{pendingPickup}</span><button type="button" className="text-btn" onClick={() => go('orders')}>处理</button></div>
          <div className="todo-item"><div className="todo-symbol blue"><Icon name="check" /></div><div className="todo-text"><b>待审核</b><small>手动赠送和店员的退款，按审核开关等管理员处理</small></div><span className="todo-num">{pendingRefunds ?? '—'}</span><button type="button" className="text-btn" onClick={() => go('refunds')}>审核</button></div>
          <div className="todo-item"><div className="todo-symbol"><Icon name="box" /></div><div className="todo-text"><b>店里的桶{bucket.lowStockWarning ? '偏少' : ''}</b><small>{`店里能用 ${bucket.inStationQty} 个${bucket.warnThreshold > 0 ? `，少于 ${bucket.warnThreshold} 个时提醒` : ''}`}</small></div><button type="button" className="text-btn" onClick={() => go('inventory')}>看库存</button></div>
        </div>
      </div>
    </div>

    <div className="bottom-grid">
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
      <div className="card">
        <div className="card-head"><div className="card-title">桶袋在哪 <small>桶、袋分开算</small></div><button type="button" className="text-btn" onClick={() => go('inventory')}>看库存 ›</button></div>
        <div className="asset-content">
          <AssetLine label="周转桶" c={bucket} />
          <div style={{ marginTop: 18 }}><AssetLine label="周转水袋" c={bag} aqua /></div>
          <div className={`identity-formula${balanced ? '' : ' warn'}`}><span>{balanced ? '✓ 数量对得上' : '数量对不上，请核对'}</span><b>合计 = 店里 + 客户手里 + 待确认报废</b></div>
        </div>
      </div>
    </div>
  </>;
}

/**
 * 本月收支：本月水费净收（实收 − 退款）减去本月费用支出（买桶袋、配件耗材、维修等，作废的不算）就是结余。
 * 押金是会员的钱，不算收入也不算支出；明细和按时间筛选在「费用支出」页。
 */
function MonthCashflow() {
  const { api, can } = useAuth();
  const { version } = useAdminData();
  const go = useGo();
  const readable = can(P.ExpenseManage) || can(P.ReportExport);
  const month = useLoader(() => readable ? api.expenseSummary({ from: dateFilterFrom('MONTH') }) : Promise.resolve(null), [api, readable, version]);
  if (!readable) return null;
  const s = month.data;
  const top = s?.categories.slice(0, 3).map(c => `${expenseCategoryLabel(c.category)} ¥${money(c.total)}`).join(' · ');
  return (
    <div className="card liability-card">
      <div className="card-head">
        <div className="card-title">本月收支 <small>水费净收减去买桶袋、配件等费用支出；押金是会员的钱，不算收入也不算支出</small></div>
        <div className="liability-links"><button type="button" className="text-btn" onClick={() => go('expenses')}>费用明细 ›</button></div>
      </div>
      <div className="liability-body">
        {month.error ? <p className="account-error" role="alert">{month.error}</p> : (
          <div className="liability-sum">
            <div className="liability-item">
              <span><Icon name="wallet" size="sm" />本月水费净收</span>
              <b>{s ? `¥ ${money(s.rechargeNet)}` : '—'}</b>
              <small>{s ? `实收 ¥${money(s.rechargeRevenue)} − 退款 ¥${money(s.rechargeRefunded)}` : '正在统计…'}</small>
            </div>
            <i className="liability-op" aria-hidden="true">−</i>
            <div className="liability-item">
              <span><Icon name="chart" size="sm" />本月费用支出</span>
              <b className={s?.expenseTotal ? 'amount-out' : undefined}>{s ? `¥ ${money(s.expenseTotal)}` : '—'}</b>
              <small>{!s ? '正在统计…' : s.expenseCount ? `${s.expenseCount} 笔：${top}` : '本月还没有登记支出'}</small>
            </div>
            <i className="liability-op" aria-hidden="true">=</i>
            <div className="liability-item total">
              <span><Icon name="refund" size="sm" />本月结余</span>
              <b>{s ? `¥ ${money(s.balance)}` : '—'}</b>
              <small>其中有会员还没用完的水费，会员退水费时要退回去</small>
            </div>
          </div>
        )}
      </div>
    </div>
  );
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
  const openingRefunded = Number(f.openingRefundedTotal ?? 0);
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
            <small>{f.unrefundedDepositQty} 个桶袋的押金，会员还桶就要退{overview ? `；已还桶、现在就能退 ¥${money(overview.refundableDeposit)}` : ''}</small>
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
            <span>+ 还没用完的（可能要退）<b className="unused">¥{money(f.unusedRechargeValue)}</b></span>
            {openingRefunded > 0 && <span>− 退给上系统前买的套餐<b className="unused">¥{money(openingRefunded)}</b></span>}
          </div>
          {net > 0 && <div className="liability-bar" role="img" aria-label={`水费净收中会员已用掉 ${Math.round(used)}%`}><i style={{ width: `${used}%` }} /></div>}
          {openingUnused > 0 && <small className="liability-note">上系统前买的套餐还没用完 ¥{money(openingUnused)}：当时收的钱没进系统，不在水费净收里，会员要退时一样得退。</small>}
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
    <div className="progress"><i style={{ width: `${Math.max(4, pct)}%`, ...(aqua ? { background: 'var(--grad-aqua)' } : {}) }} /></div>
    <div className="asset-meta"><span>店里能用 {c.inStationQty}</span><span>待确认报废 {c.damagedQty}</span><span>累计报废 {c.scrappedQty}</span></div>
  </>;
}

/** Rounds an axis top up so the three gridlines land on whole, round steps (1, 2 or 5 × 10ⁿ apart). */
function axisMax(values: number[]) {
  const step = Math.max(0, ...values) / 3;
  if (step <= 1) return 3;
  const power = 10 ** Math.floor(Math.log10(step));
  return [1, 2, 5, 10].map(n => n * power).find(n => n >= step)! * 3;
}

function TrendChart({ overview }: { overview: OverviewReport | null }) {
  if (!overview) return <svg className="chart" viewBox="0 0 700 210" preserveAspectRatio="none"><text x="300" y="100">需要报表权限查看趋势</text></svg>;
  const points = overview.trend;
  const cashMax = axisMax(points.map(p => Number(p.rechargeAmount)));
  const qtyMax = axisMax(points.map(p => Number(p.waterQty)));
  return (
    <svg className="chart" viewBox="0 0 700 210" preserveAspectRatio="none" role="img" aria-label="近七日实际水费收款与核销水量">
      {Array.from({ length: 4 }, (_, i) => (
        <g key={i}>
          <line className="gridline" x1="45" x2="650" y1={20 + i * 45} y2={20 + i * 45} />
          <text x="2" y={24 + i * 45}>{cashMax * (3 - i) / 3}</text>
          <text x="658" y={24 + i * 45}>{qtyMax * (3 - i) / 3}</text>
        </g>
      ))}
      {points.map((p, i) => {
        const h = Number(p.waterQty) / qtyMax * 135;
        return (
          <g key={p.date}>
            <rect className="bar" x={45 + i * 95} y={155 - h} width="22" height={h} />
            <text x={55 + i * 95} y="185" textAnchor="middle">{p.date.slice(5).replace('-', '/')}</text>
          </g>
        );
      })}
      <polyline points={points.map((p, i) => `${55 + i * 95},${155 - Number(p.rechargeAmount) / cashMax * 135}`).join(' ')} className="line" />
    </svg>
  );
}
