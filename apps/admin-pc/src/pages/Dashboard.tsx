import { KUNLUN_BRAND, money, waterFallbackLabel, type ContainerSummaryItem, type OverviewReport, type WaterOrder } from '@kunlun/shared';
import { Icon, useAuth } from '@kunlun/ui';
import { useExport, useGo, useOperations } from '../common';
import { useAdminData } from '../data';

const EMPTY_CONTAINER: ContainerSummaryItem = {
  containerType: 'BUCKET', unitDeposit: 0, totalQty: 0, inStationQty: 0, memberHeldQty: 0,
  damagedQty: 0, scrappedQty: 0, warnThreshold: 0, identityValid: true, lowStockWarning: false,
};

export function Dashboard() {
  const { user } = useAuth();
  const { orders, overview, finance, containers, pendingRefunds } = useAdminData();
  const go = useGo();
  const exportCsv = useExport();
  const ops = useOperations();
  const bucket = containers.find(c => c.containerType === 'BUCKET') ?? EMPTY_CONTAINER;
  const bag = containers.find(c => c.containerType === 'BAG') ?? { ...EMPTY_CONTAINER, containerType: 'BAG' };
  const balanced = bucket.identityValid && bag.identityValid;
  const completed = orders.filter(o => o.status === 'COMPLETED');
  const pendingDelivery = overview?.pendingDelivery ?? orders.filter(o => o.status === 'PENDING' && o.fulfillMode === 'DELIVERY').length;
  const pendingPickup = overview?.pendingPickup ?? orders.filter(o => o.status === 'PENDING' && o.fulfillMode === 'PICKUP').length;
  const dispatched = overview?.dispatched ?? orders.filter(o => o.status === 'DISPATCHED').length;
  const pending = pendingDelivery + pendingPickup + dispatched;
  const doneQty = (water: WaterOrder['waterType']) => completed.filter(o => o.waterType === water).reduce((s, o) => s + (o.actualQty ?? o.orderQty), 0);

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
        <div className="stat-foot">{finance ? `不含押金 · 在池押金 ¥${money(finance.unrefundedDepositPoolTotal)} 另行核算` : '需要报表权限'}</div>
      </div>
      <div className="stat-card">
        <div className="stat-top"><span>已核销用水</span><span className="stat-icon blue"><Icon name="drop" /></span></div>
        <div className="stat-value">{overview?.completedBuckets ?? doneQty('BUCKET_18_9L')}<small>桶</small> · {overview?.completedBags ?? doneQty('BAG_7_5L')}<small>袋</small></div>
        <div className="stat-foot">累计完结水单 <b>{overview?.completedOrders ?? completed.length}</b> 笔</div>
      </div>
      <div className="stat-card">
        <div className="stat-top"><span>待履约水单</span><span className="stat-icon orange"><Icon name="truck" /></span></div>
        <div className="stat-value">{pending}<small>单</small></div>
        <div className="stat-foot"><span style={{ color: 'var(--orange-500)' }}>待接单配送 {pendingDelivery}</span> · 配送中 {dispatched} · 待自提 {pendingPickup}</div>
      </div>
      <div className="stat-card">
        <div className="stat-top"><span>会员持有容器</span><span className="stat-icon gold"><Icon name="box" /></span></div>
        <div className="stat-value">{bucket.memberHeldQty}<small>桶</small> / {bag.memberHeldQty}<small>袋</small></div>
        <div className="stat-foot">站内可用：桶 {bucket.inStationQty} · 袋 {bag.inStationQty}</div>
      </div>
    </div>

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
          <div className="todo-item"><div className="todo-symbol blue"><Icon name="check" /></div><div className="todo-text"><b>待审核退款</b><small>押金与水费退款须管理员审核后才退</small></div><span className="todo-num">{pendingRefunds ?? '—'}</span><button type="button" className="text-btn" onClick={() => go('refunds')}>审核</button></div>
          <div className="todo-item"><div className="todo-symbol"><Icon name="box" /></div><div className="todo-text"><b>15L 周转桶库存{bucket.lowStockWarning ? '偏低' : ''}</b><small>当前门店可用 {bucket.inStationQty} 个，预警值 {bucket.warnThreshold}</small></div><button type="button" className="text-btn" onClick={() => go('assets')}>查看</button></div>
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
        <div className="card-head"><div className="card-title">容器资产恒等概览 <small>桶、袋独立核算</small></div><button type="button" className="text-btn" onClick={() => go('assets')}>查看台账 ›</button></div>
        <div className="asset-content">
          <AssetLine label="15L 周转桶" c={bucket} />
          <div style={{ marginTop: 18 }}><AssetLine label="5L 周转水袋" c={bag} aqua /></div>
          <div className={`identity-formula${balanced ? '' : ' warn'}`}><span>{balanced ? '✓ 库存平衡' : '库存不平衡，请核对'}</span><b>现存总量 = 门店可用 + 会员持有 + 待报废</b></div>
        </div>
      </div>
    </div>
  </>;
}

function OrderTag({ order: o }: { order: WaterOrder }) {
  if (o.status === 'COMPLETED') return <span className="tag gray">已完成</span>;
  if (o.status === 'CANCELLED') return <span className="tag red">已取消</span>;
  if (o.fulfillMode === 'PICKUP') return <span className="tag aqua dot">待自提({o.pickupCode})</span>;
  return <span className="tag orange dot">{o.status === 'DISPATCHED' ? '配送中' : '待接单'}</span>;
}

function AssetLine({ label, c, aqua = false }: { label: string; c: ContainerSummaryItem; aqua?: boolean }) {
  const pct = Math.min(100, Math.round(c.memberHeldQty / Math.max(1, c.totalQty) * 100));
  return <>
    <div className="asset-line"><span>{label}</span><span>会员持有 <b>{c.memberHeldQty}</b> / 总量 <b>{c.totalQty}</b></span></div>
    <div className="progress"><i style={{ width: `${Math.max(4, pct)}%`, ...(aqua ? { background: 'var(--grad-aqua)' } : {}) }} /></div>
    <div className="asset-meta"><span>门店可用 {c.inStationQty}</span><span>待报废 {c.damagedQty}</span><span>累计报废 {c.scrappedQty}</span></div>
  </>;
}

function TrendChart({ overview }: { overview: OverviewReport | null }) {
  if (!overview) return <svg className="chart" viewBox="0 0 700 210" preserveAspectRatio="none"><text x="300" y="100">需要报表权限查看趋势</text></svg>;
  const points = overview.trend;
  const cashMax = Math.max(1, ...points.map(p => Number(p.rechargeAmount)));
  const qtyMax = Math.max(1, ...points.map(p => Number(p.waterQty)));
  return (
    <svg className="chart" viewBox="0 0 700 210" preserveAspectRatio="none" role="img" aria-label="近七日实际水费收款与核销水量">
      {Array.from({ length: 4 }, (_, i) => (
        <g key={i}>
          <line className="gridline" x1="45" x2="650" y1={20 + i * 45} y2={20 + i * 45} />
          <text x="2" y={24 + i * 45}>{Math.round(cashMax * (3 - i) / 3)}</text>
          <text x="658" y={24 + i * 45}>{Math.round(qtyMax * (3 - i) / 3)}</text>
        </g>
      ))}
      {points.map((p, i) => {
        const h = Number(p.waterQty) / qtyMax * 135;
        return (
          <g key={p.date}>
            <rect x={45 + i * 95} y={155 - h} width="22" height={h} fill="#7fd3a8" opacity=".4" />
            <text x={55 + i * 95} y="185" textAnchor="middle">{p.date.slice(5).replace('-', '/')}</text>
          </g>
        );
      })}
      <polyline points={points.map((p, i) => `${55 + i * 95},${155 - Number(p.rechargeAmount) / cashMax * 135}`).join(' ')} fill="none" stroke="#12925f" strokeWidth="3" />
    </svg>
  );
}
