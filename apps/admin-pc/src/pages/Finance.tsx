import { useState } from 'react';
import {
  KUNLUN_PERMISSIONS as P, containerLabel, dateFilterFrom, modeLabel, money, payMethodLabel, shortDateTime, waterFallbackLabel,
  type DateFilter, type DepositLedgerRow, type LedgerQuery, type Paged, type RechargeLedgerRow,
} from '@kunlun/shared';
import { Dialog, Icon, useAuth, useDialogs } from '@kunlun/ui';
import { DateFilterSelect, EmptyRow, PAGE_SIZE, Pager, emptyPage, useDebounced, useExport, useOperations, usePagedTable } from '../common';
import { useAdminData } from '../data';

const FLOW_LABELS: Record<string, string> = { COLLECT: '交押金', REFUND: '退押金', DEDUCT: '报废扣押金' };
const FOOTNOTE = '押金不计入水费实收；退押金严格按原收取批次单价计算';

export function Finance() {
  const { finance, overview } = useAdminData();
  const ops = useOperations();
  const exportCsv = useExport();
  const [tab, setTab] = useState<'recharges' | 'deposits'>('recharges');
  const [query, setQuery] = useState('');
  const [date, setDate] = useState<DateFilter>('ALL');
  const q = useDebounced(query.trim());
  const filter: LedgerQuery = { q, from: dateFilterFrom(date) };
  const revenue = Number(finance?.rechargeRevenueTotal ?? 0);
  const depositIn = Number(finance?.depositCollectedTotal ?? 0), depositOut = Number(finance?.depositRefundedTotal ?? 0);

  return <>
    <div className="page-head">
      <div><h2>充值与押金</h2><p>水费实收、水票到账与押金收支严格分账；押金不触发赠水</p></div>
      <div className="head-actions">
        <button type="button" className="btn" onClick={() => ops.deposit()}><Icon name="deposit" />押金收款 / 退款</button>
        <button type="button" className="btn primary" onClick={() => ops.recharge()}><Icon name="plus" />水费充值登记</button>
      </div>
    </div>
    <div className="stats-grid">
      <div className="stat-card"><div className="stat-top">水费充值累计</div><div className="stat-value">¥ {money(revenue)}</div><div className="stat-foot">退款 ¥{money(finance?.rechargeRefundedTotal ?? 0)} · 水费净收 ¥{money(finance?.rechargeNetReceived ?? 0)}</div></div>
      <div className="stat-card"><div className="stat-top">押金收支净额</div><div className="stat-value">¥ {money(depositIn - depositOut)}</div><div className="stat-foot">收押 {finance?.depositCollectCount ?? 0} 笔 (¥{depositIn.toFixed(0)}) · 退押 {finance?.depositRefundCount ?? 0} 笔 (¥{depositOut.toFixed(0)}) · 报废扣押 ¥{money(finance?.depositDeductedTotal ?? 0)}</div></div>
      <div className="stat-card"><div className="stat-top">在池未退押金总额</div><div className="stat-value">¥ {money(finance?.unrefundedDepositPoolTotal ?? 0)}</div><div className="stat-foot">{finance?.reconciledZeroDiff ? '与收退流水零误差对齐' : '对账校验中'}</div></div>
      <div className="stat-card"><div className="stat-top">当前可退押金</div><div className="stat-value">¥ {money(overview?.refundableDeposit ?? 0)}</div><div className="stat-foot">已扣除会员实际持有容器占用押金</div></div>
    </div>
    <div className="tabs" role="tablist">
      <button type="button" role="tab" aria-selected={tab === 'recharges'} className={`tab${tab === 'recharges' ? ' active' : ''}`} onClick={() => setTab('recharges')}>水费实收记录</button>
      <button type="button" role="tab" aria-selected={tab === 'deposits'} className={`tab${tab === 'deposits' ? ' active' : ''}`} onClick={() => setTab('deposits')}>押金收支记录</button>
    </div>
    <div className="filter-card">
      <label className="field-search"><Icon name="search" /><input placeholder="搜索会员或业务单号" aria-label="搜索会员或业务单号" value={query} onChange={e => setQuery(e.target.value)} /></label>
      <DateFilterSelect label="业务时间" value={date} onChange={setDate} />
      <div className="filter-spacer" />
      <button type="button" className="btn" onClick={() => exportCsv(tab === 'recharges' ? 'recharges' : 'deposit-ledgers')}><Icon name="export" />导出明细</button>
    </div>
    {tab === 'recharges' ? <RechargeTable filter={filter} /> : <DepositTable filter={filter} />}
  </>;
}

/** Ledger tables need the report permission, as the summary cards above do. */
function useLedger<T>(load: (query: LedgerQuery) => Promise<Paged<T>>, filter: LedgerQuery) {
  const { can } = useAuth();
  const reports = can(P.ReportExport);
  return usePagedTable(page => reports ? load({ ...filter, page, pageSize: PAGE_SIZE }) : Promise.resolve(emptyPage<T>()), [filter, reports]);
}

function emptyText(table: { data: unknown; error: string }, filter: LedgerQuery, none: string, kind: string) {
  return table.error || (!table.data ? '正在加载…' : filter.q || filter.from ? `没有符合条件的${kind}` : none);
}

function RechargeTable({ filter }: { filter: LedgerQuery }) {
  const { api } = useAuth();
  const dialogs = useDialogs();
  const table = useLedger<RechargeLedgerRow>(query => api.rechargeLedger(query), filter);
  const rows = table.data?.rows ?? [];
  return (
    <div className="table-card">
      <div style={{ overflowX: 'auto' }}>
        <table>
          <thead><tr><th>业务单号 / 时间</th><th>会员</th><th>优惠方案快照</th><th>水费实收</th><th>购水 / 赠水</th><th>收款方式</th><th>操作人</th><th>操作</th></tr></thead>
          <tbody>
            {rows.length === 0 ? <EmptyRow colSpan={8}>{emptyText(table, filter, '暂无水费充值流水，请点击右上角「水费充值登记」办理', '充值记录')}</EmptyRow> : rows.map(r => (
              <tr key={r.rechargeNo}>
                <td><span className="order-no">{r.rechargeNo}</span><br /><small style={{ color: 'var(--muted)' }}>{shortDateTime(r.createdAt)}</small></td>
                <td><b>{r.memberName}</b> <small style={{ color: 'var(--muted)' }}>({r.memberNo})</small></td>
                <td>{r.planName}</td>
                <td><b>¥ {money(r.paidAmount)}</b></td>
                <td>购 {r.buyQty} + 赠 {r.giftQty}</td>
                <td>{payMethodLabel(r.payMethod)}</td>
                <td>{r.operatorName}</td>
                <td><button type="button" className="link" onClick={() => dialogs.open(close => <RechargeDetailDialog row={r} onClose={close} />)}>查看快照</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="table-footer"><span>共 {table.total} 条 · {FOOTNOTE}</span><Pager page={table.page} total={table.total} onChange={table.setPage} /></div>
    </div>
  );
}

function DepositTable({ filter }: { filter: LedgerQuery }) {
  const { api } = useAuth();
  const table = useLedger<DepositLedgerRow>(query => api.depositLedger(query), filter);
  const rows = table.data?.rows ?? [];
  return (
    <div className="table-card">
      <div style={{ overflowX: 'auto' }}>
        <table>
          <thead><tr><th>业务单号 / 时间</th><th>会员</th><th>业务类型</th><th>容器与数量</th><th>批次单价</th><th>押金金额</th><th>未退余量</th><th>操作人</th></tr></thead>
          <tbody>
            {rows.length === 0 ? <EmptyRow colSpan={8}>{emptyText(table, filter, '暂无押金流水', '押金记录')}</EmptyRow> : rows.map(d => (
              <tr key={d.docNo}>
                <td><span className="order-no">{d.docNo}</span><br /><small style={{ color: 'var(--muted)' }}>{shortDateTime(d.createdAt)}</small></td>
                <td><b>{d.memberName}</b></td>
                <td><span className={`tag ${d.flowType === 'COLLECT' ? 'green' : 'orange'}`}>{FLOW_LABELS[d.flowType] ?? d.flowType}</span></td>
                <td>{containerLabel(d.containerType)} × {d.qty}</td>
                <td>¥ {money(d.unitPrice)}</td>
                <td><b>{d.flowType === 'COLLECT' ? '+' : '-'}¥ {money(d.amount)}</b></td>
                <td>{d.remainingQty} 个</td>
                <td>{d.operatorName}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="table-footer"><span>共 {table.total} 条 · {FOOTNOTE}</span><Pager page={table.page} total={table.total} onChange={table.setPage} /></div>
    </div>
  );
}

function RechargeDetailDialog({ row: r, onClose }: { row: RechargeLedgerRow; onClose: () => void }) {
  return (
    <Dialog title="充值记录详情" onClose={onClose}>
      <div className="membership-summary">
        <b>{r.memberName} · {r.memberNo}</b>
        <p>{r.rechargeNo}</p>
        <p>{r.planName}</p>
        <p>实收 ¥{money(r.paidAmount)} · 付费 {r.buyQty} + 赠票 {r.giftQty} · {payMethodLabel(r.payMethod)}</p>
        <p>{modeLabel(r.planSnapshot.fulfillMode)} · {r.planSnapshot.waterLabel || waterFallbackLabel(r.planSnapshot.waterType)}</p>
        <small>{new Date(r.createdAt).toLocaleString('zh-CN')} · {r.operatorName}</small>
      </div>
    </Dialog>
  );
}
