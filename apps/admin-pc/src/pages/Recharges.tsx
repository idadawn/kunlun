import { useState } from 'react';
import {
  PAY_METHODS, dateFilterFrom, modeLabel, money, payMethodLabel, shortDateTime, unitOf, waterFallbackLabel,
  type DateFilter, type PayMethod, type RechargeLedgerQuery, type RechargeLedgerRow, type RechargeRefundLedgerRow,
} from '@kunlun/shared';
import { Dialog, Icon, useAuth, useDialogs } from '@kunlun/ui';
import { DateFilterSelect, EmptyRow, Pager, StatCard, ledgerEmptyText, useDebounced, useExport, useLedger, useOperations } from '../common';
import { useAdminData } from '../data';

type Tab = 'recharges' | 'refunds';
const TABS: Array<[Tab, string]> = [['recharges', '充值记录'], ['refunds', '退款记录']];
const NO_REPORTS = '需要报表权限';

/** 水费充值：只管水费实收、水票到账和退清退款；押金在「押金管理」单独办理。 */
export function Recharges() {
  const { finance: f } = useAdminData();
  const ops = useOperations();
  const exportCsv = useExport();
  const [tab, setTab] = useState<Tab>('recharges');
  const [query, setQuery] = useState('');
  const [date, setDate] = useState<DateFilter>('ALL');
  const [pay, setPay] = useState<PayMethod | ''>('');
  const q = useDebounced(query.trim());
  const filter: RechargeLedgerQuery = { q, from: dateFilterFrom(date), payMethod: pay || undefined };
  const filtered = !!(q || filter.from || pay);
  const refunds = tab === 'refunds';

  return <>
    <div className="page-head">
      <div><h2>水费充值</h2><p>登记线下收取的水费并按套餐发放水票；押金在「押金管理」单独收退，不计入水费、不触发赠水</p></div>
      <div className="head-actions">
        <button type="button" className="btn" onClick={() => ops.issueCoupon()}>发放优惠券</button>
        <button type="button" className="btn primary" onClick={() => ops.recharge()}><Icon name="plus" />水费充值登记</button>
      </div>
    </div>
    <div className="stats-grid">
      <StatCard label="水费实收" icon="wallet" value={f ? `¥ ${money(f.rechargeRevenueTotal)}` : '—'} foot={f ? `累计充值 ${f.rechargeOrderCount} 笔` : NO_REPORTS} />
      <StatCard label="水费退款" icon="refresh" tone="orange" value={f ? `¥ ${money(f.rechargeRefundedTotal)}` : '—'} foot={f ? `退清剩余权益 ${f.rechargeRefundCount} 笔` : NO_REPORTS} />
      <StatCard label="水费净收" icon="chart" tone="blue" value={f ? `¥ ${money(f.rechargeNetReceived)}` : '—'} foot="实收 − 退款，不含押金" />
      <StatCard label="累计到账水票" icon="drop" tone="gold" value={f ? <>{f.ticketsSoldBuyQty + f.ticketsGiftedQty}<small>张</small></> : '—'}
        foot={f ? `付费 ${f.ticketsSoldBuyQty} · 赠送 ${f.ticketsGiftedQty}` : NO_REPORTS} />
    </div>
    <div className="tabs" role="tablist">
      {TABS.map(([id, label]) => (
        <button key={id} type="button" role="tab" aria-selected={tab === id} className={`tab${tab === id ? ' active' : ''}`} onClick={() => setTab(id)}>{label}</button>
      ))}
    </div>
    <div className="filter-card">
      <label className="field-search"><Icon name="search" /><input placeholder="搜索会员、手机号或单号" aria-label="搜索会员、手机号或单号" value={query} onChange={e => setQuery(e.target.value)} /></label>
      <select className="select" aria-label={refunds ? '退款方式' : '收款方式'} value={pay} onChange={e => setPay(e.target.value as PayMethod | '')}>
        <option value="">{refunds ? '全部退款方式' : '全部收款方式'}</option>
        {PAY_METHODS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
      </select>
      <DateFilterSelect label="业务时间" value={date} onChange={setDate} />
      <div className="filter-spacer" />
      <button type="button" className="btn" onClick={() => exportCsv(refunds ? 'recharge-refunds' : 'recharges')}><Icon name="export" />导出{refunds ? '退款' : '充值'}明细</button>
    </div>
    {refunds ? <RefundTable filter={filter} filtered={filtered} /> : <RechargeTable filter={filter} filtered={filtered} />}
  </>;
}

function RechargeTable({ filter, filtered }: { filter: RechargeLedgerQuery; filtered: boolean }) {
  const { api } = useAuth();
  const dialogs = useDialogs();
  const table = useLedger((query: RechargeLedgerQuery) => api.rechargeLedger(query), filter);
  const rows = table.data?.rows ?? [];
  return (
    <div className="table-card ledger-table">
      <div style={{ overflowX: 'auto' }}>
        <table>
          <thead><tr><th>充值单号 / 时间</th><th>会员</th><th>充值套餐</th><th>水费实收</th><th>到账水票</th><th>收款方式</th><th>状态</th><th>操作人</th><th>操作</th></tr></thead>
          <tbody>
            {rows.length === 0 ? <EmptyRow colSpan={9}>{ledgerEmptyText(table, filtered, '暂无水费充值记录，请点击右上角「水费充值登记」办理', '充值记录')}</EmptyRow> : rows.map(r => {
              const unit = unitOf(r.planSnapshot.waterType);
              return (
                <tr key={r.rechargeNo}>
                  <td><span className="order-no">{r.rechargeNo}</span><br /><small>{shortDateTime(r.createdAt)}</small></td>
                  <td><b>{r.memberName}</b><br /><small>{r.memberNo}</small></td>
                  <td>{r.planName}{r.couponName && <><br /><small>用券：{r.couponName}</small></>}</td>
                  <td><b>¥ {money(r.paidAmount)}</b></td>
                  <td>付费 {r.buyQty}{r.giftQty > 0 && <> + 赠 {r.giftQty}</>} {unit}</td>
                  <td>{payMethodLabel(r.payMethod)}</td>
                  <td>{r.refundNo ? <span className="tag orange">已退 ¥{money(r.refundAmount ?? 0)}</span> : <span className="tag green">已到账</span>}</td>
                  <td>{r.operatorName}</td>
                  <td><button type="button" className="link" onClick={() => dialogs.open(close => <RechargeDetailDialog row={r} onClose={close} />)}>详情</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="table-footer"><span>共 {table.total} 条 · 按办理时套餐快照计价，之后修改套餐不影响历史记录</span><Pager page={table.page} total={table.total} onChange={table.setPage} /></div>
    </div>
  );
}

function RefundTable({ filter, filtered }: { filter: RechargeLedgerQuery; filtered: boolean }) {
  const { api } = useAuth();
  const table = useLedger((query: RechargeLedgerQuery) => api.rechargeRefundLedger(query), filter);
  const rows: RechargeRefundLedgerRow[] = table.data?.rows ?? [];
  return (
    <div className="table-card ledger-table">
      <div style={{ overflowX: 'auto' }}>
        <table>
          <thead><tr><th>退款单号 / 时间</th><th>会员</th><th>原充值</th><th>退款金额</th><th>退回水票</th><th>退款方式</th><th>退款原因</th><th>操作人</th></tr></thead>
          <tbody>
            {rows.length === 0 ? <EmptyRow colSpan={8}>{ledgerEmptyText(table, filtered, '暂无水费退款；在会员的水票批次中可退清剩余权益', '退款记录')}</EmptyRow> : rows.map(r => (
              <tr key={r.refundNo}>
                <td><span className="order-no">{r.refundNo}</span><br /><small>{shortDateTime(r.createdAt)}</small></td>
                <td><b>{r.memberName}</b><br /><small>{r.memberNo}</small></td>
                <td>{r.planName}<br /><small>{r.rechargeNo || '历史余额'}</small></td>
                <td><b className="amount-out">−¥ {money(r.amount)}</b></td>
                <td>退付费 {r.refundBuyQty} · 收回赠 {r.revokedGiftQty} {unitOf(r.waterType)}</td>
                <td>{payMethodLabel(r.payMethod)}</td>
                <td className="ledger-reason">{r.reason}</td>
                <td>{r.operatorName}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="table-footer"><span>共 {table.total} 条 · 按原实付单价退还剩余付费票，赠票同时收回</span><Pager page={table.page} total={table.total} onChange={table.setPage} /></div>
    </div>
  );
}

function RechargeDetailDialog({ row: r, onClose }: { row: RechargeLedgerRow; onClose: () => void }) {
  const unit = unitOf(r.planSnapshot.waterType);
  return (
    <Dialog title="充值记录详情" description={`${r.rechargeNo} · ${new Date(r.createdAt).toLocaleString('zh-CN')}`} onClose={onClose}>
      <div className="detail-card">
        <div className="detail-row"><span>会员</span><b>{r.memberName} · {r.memberNo}</b></div>
        <div className="detail-row"><span>充值套餐</span><b>{r.planName}</b></div>
        <div className="detail-row"><span>水品与方式</span><b>{r.planSnapshot.waterLabel || waterFallbackLabel(r.planSnapshot.waterType)} · {modeLabel(r.planSnapshot.fulfillMode)}</b></div>
        <div className="detail-row"><span>水费实收</span><b>¥ {money(r.paidAmount)} · {payMethodLabel(r.payMethod)}</b></div>
        <div className="detail-row"><span>到账水票</span><b>付费 {r.buyQty} + 赠送 {r.giftQty} = 共 {r.buyQty + r.giftQty} {unit}</b></div>
        <div className="detail-row"><span>优惠券</span><b>{r.couponName ?? '未使用'}</b></div>
        <div className="detail-row"><span>经办人</span><b>{r.operatorName}</b></div>
        {r.refundNo && <div className="detail-row"><span>退清剩余权益</span><b>{r.refundNo} · 退 ¥{money(r.refundAmount ?? 0)}{r.refundedAt ? ` · ${shortDateTime(r.refundedAt)}` : ''}</b></div>}
      </div>
      <p className="membership-note">套餐信息为办理时快照；押金不在充值中收取，另在「押金管理」办理。</p>
    </Dialog>
  );
}
