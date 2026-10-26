import { useState } from 'react';
import {
  dateFilterFrom, isActiveOrder, orderStatusLabel, shortDateTime, unitOf, waterFallbackLabel,
  type DateFilter, type FulfillMode, type OrderQuery, type WaterOrder,
} from '@kunlun/shared';
import { ConfirmDialog, Dialog, Icon, useApi, useDialogs, useRun, useToast } from '@kunlun/ui';
import { DateFilterSelect, EmptyRow, PAGE_SIZE, Pager, emptyPage, useDebounced, useExport, useOperations, usePagedTable } from '../common';
import { useAdminData } from '../data';

const TAG_CLASS: Record<string, string> = { 待自提: 'aqua dot', 待接单: 'orange dot', 配送中: 'green dot', 已完成: 'gray', 已取消: 'red' };
/** Each tab is the server filter matching its orderStatusLabel. */
const TABS: Array<[string, Pick<OrderQuery, 'status' | 'mode'>]> = [
  ['全部水单', {}],
  ['待接单', { status: 'PENDING', mode: 'DELIVERY' }],
  ['配送中', { status: 'DISPATCHED' }],
  ['待自提', { status: 'PENDING', mode: 'PICKUP' }],
  ['已完成', { status: 'COMPLETED' }],
  ['已取消', { status: 'CANCELLED' }],
];
const waterLabel = (o: WaterOrder) => o.productSnapshot?.waterLabel || waterFallbackLabel(o.waterType);

export function Orders() {
  const { orders, orderTotal, overview, refresh } = useAdminData();
  const api = useApi();
  const dialogs = useDialogs();
  const toast = useToast();
  const run = useRun();
  const ops = useOperations();
  const exportCsv = useExport();
  const [tab, setTab] = useState('全部水单');
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<FulfillMode | ''>('');
  const [date, setDate] = useState<DateFilter>('ALL');
  const q = useDebounced(query.trim());
  const tabFilter = TABS.find(([t]) => t === tab)![1];
  // 待接单 / 待自提 already fix the fulfil mode; combined with the other mode nothing can match.
  const conflict = !!(mode && tabFilter.mode && tabFilter.mode !== mode);
  const table = usePagedTable(page => conflict ? Promise.resolve(emptyPage<WaterOrder>())
    : api.ordersPage({ ...tabFilter, mode: tabFilter.mode ?? (mode || undefined), q, from: dateFilterFrom(date), page, pageSize: PAGE_SIZE }), [tab, mode, q, date]);
  const rows = table.data?.rows ?? [];

  const pendingDelivery = overview?.pendingDelivery ?? orders.filter(o => o.status === 'PENDING' && o.fulfillMode === 'DELIVERY').length;
  const pendingPickup = overview?.pendingPickup ?? orders.filter(o => o.status === 'PENDING' && o.fulfillMode === 'PICKUP').length;
  const dispatched = overview?.dispatched ?? orders.filter(o => o.status === 'DISPATCHED').length;

  const cancel = (o: WaterOrder) => run(async () => {
    const confirmed = await dialogs.open<boolean>(close => <ConfirmDialog title="取消水单" confirmLabel="确认取消" onClose={close}
      message={`确定取消水单 ${o.orderNo} 吗？取消后预占水票将释放回可用余额。`}
      onConfirm={() => api.cancelOrder(o.id, '管理员取消水单并释放预占水票').then(() => undefined)} />);
    if (confirmed) { toast(`水单 ${o.orderNo} 已取消，预占水票已释放回可用余额`); await refresh(); }
  })();

  return <>
    <div className="page-head">
      <div><h2>水单管理</h2><p>下单预占水票与地址快照，交付时同步登记满桶领出与空桶收回</p></div>
      <div className="head-actions">
        <button type="button" className="btn" onClick={() => exportCsv('orders')}><Icon name="export" />导出汇总</button>
        <button type="button" className="btn primary" onClick={() => ops.order()}><Icon name="plus" />门店点单</button>
      </div>
    </div>
    <div className="summary-strip">
      <div className="summary-item"><small>水单总数</small><b>{orderTotal}</b></div>
      <div className="summary-item"><small>待接单</small><b style={{ color: 'var(--orange-500)' }}>{pendingDelivery}</b></div>
      <div className="summary-item"><small>配送中 / 待自提</small><b>{dispatched + pendingPickup}</b></div>
      <div className="summary-item"><small>已完成</small><b>{overview?.completedOrders ?? orders.filter(o => o.status === 'COMPLETED').length}</b></div>
    </div>
    <div className="tabs" role="tablist">
      {TABS.map(([t]) => (
        <button key={t} type="button" role="tab" aria-selected={tab === t} className={`tab${tab === t ? ' active' : ''}`} onClick={() => setTab(t)}>
          {t}{t === '待接单' && pendingDelivery > 0 && <> <span className="tag orange">{pendingDelivery}</span></>}
        </button>
      ))}
    </div>
    <div className="filter-card">
      <label className="field-search"><Icon name="search" /><input placeholder="搜索水单号、会员姓名、手机号或地址" aria-label="搜索水单" value={query} onChange={e => setQuery(e.target.value)} /></label>
      <select className="select" aria-label="领取方式" value={mode} onChange={e => setMode(e.target.value as typeof mode)}>
        <option value="">全部领取方式</option><option value="DELIVERY">配送</option><option value="PICKUP">自提</option>
      </select>
      <DateFilterSelect label="下单时间" value={date} onChange={setDate} />
      <div className="filter-spacer" />
      <button type="button" className="btn" onClick={run(refresh)}><Icon name="refresh" />刷新</button>
    </div>
    <div className="table-card">
      <div style={{ overflowX: 'auto' }}>
        <table>
          <thead><tr><th>水单号 / 创建时间</th><th>收货联系人</th><th>方式 / 地址快照</th><th>水品与数量</th><th>水票预占</th><th>交付</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>
            {rows.length === 0 ? <EmptyRow colSpan={8}>{table.error || (!table.data ? '正在加载水单…' : orderTotal ? '没有符合条件的水单' : '暂无水单，可门店点单或由会员自助下单')}</EmptyRow> : rows.map(o => {
              const pickup = o.fulfillMode === 'PICKUP';
              const state = orderStatusLabel(o);
              return (
                <tr key={o.id}>
                  <td><span className="order-no">{o.orderNo}</span><br /><small style={{ color: 'var(--muted)' }}>{shortDateTime(o.createdAt)}</small></td>
                  <td><b>{o.addressSnapshot?.contactName || '会员'}</b><br /><small style={{ color: 'var(--muted)' }}>{o.addressSnapshot?.contactPhone}</small></td>
                  <td style={{ whiteSpace: 'normal', minWidth: 200 }}>
                    <span className={`tag ${pickup ? 'aqua' : 'green'}`}>{pickup ? '自提' : '配送'}</span>{' '}
                    {pickup ? <>绿麒麟水站到店{o.pickupCode && <> (取水码: <b>{o.pickupCode}</b>)</>}</> : o.addressSnapshot?.address || '未设置配送地址'}
                    {o.remark && <><br /><small style={{ color: 'var(--orange-500)' }}>备注：{o.remark}</small></>}
                  </td>
                  <td>{waterLabel(o)} × <b>{o.orderQty}</b></td>
                  <td>{o.status === 'COMPLETED' ? `已核销 ${o.actualQty ?? o.orderQty}` : o.status === 'CANCELLED' ? '已释放预占' : `预占 ${o.reservedQty} ${unitOf(o.waterType)}`}</td>
                  <td>{o.status === 'COMPLETED' ? '已交付' : o.status === 'CANCELLED' ? '—' : '待交付'}</td>
                  <td><span className={`tag ${TAG_CLASS[state] ?? 'gray'}`}>{state}</span></td>
                  <td>{isActiveOrder(o) ? <>
                    <button type="button" className="link" onClick={() => ops.fulfill(o)}>{pickup ? '核验自提' : '接单并交付'}</button>
                    <button type="button" className="link" style={{ color: 'var(--red-500)', marginLeft: 8 }} onClick={() => cancel(o)}>取消</button>
                  </> : <button type="button" className="link" onClick={() => dialogs.open(close => <OrderDetailDialog order={o} onClose={close} />)}>查看详情</button>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="table-footer"><span>共 {table.total} 张水单 · 交付完成后预占转核销；接单前取消自动释放预占水票</span><Pager page={table.page} total={table.total} onChange={table.setPage} /></div>
    </div>
  </>;
}

function OrderDetailDialog({ order: o, onClose }: { order: WaterOrder; onClose: () => void }) {
  const s = o.addressSnapshot;
  return (
    <Dialog title="水单详情" onClose={onClose}>
      <div className="membership-summary">
        <b>{o.orderNo} · {orderStatusLabel(o)}</b>
        <p>{waterLabel(o)} × {o.orderQty} · {o.fulfillMode === 'PICKUP' ? '到店自提' : '配送上门'}</p>
        <p>收货联系人：{s?.contactName || '—'} {s?.contactPhone}</p>
        {o.fulfillMode === 'DELIVERY' && <p>收货地址：{s?.address || '未设置配送地址'}</p>}
        {o.pickupCode && <p>取水码：{o.pickupCode}</p>}
        {o.remark && <p>备注：{o.remark}</p>}
        <p>实际交付 {o.actualQty ?? '—'} · 满桶领出 {o.fullOutQty ?? '—'} · 空桶收回 {o.emptyInQty ?? '—'}</p>
        {(o.diffReason || o.cancelReason) && <p>{o.diffReason || o.cancelReason}</p>}
        <small>{new Date(o.createdAt).toLocaleString('zh-CN')}</small>
      </div>
    </Dialog>
  );
}
