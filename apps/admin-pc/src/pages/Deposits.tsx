import { useState } from 'react';
import {
  containerLabel, dateFilterFrom, money, payMethodLabel, shortDateTime,
  type ContainerType, type DateFilter, type DepositFlowType, type DepositLedgerQuery, type DepositLedgerRow,
} from '@kunlun/shared';
import { Icon, useAuth } from '@kunlun/ui';
import { DateFilterSelect, EmptyRow, Pager, StatCard, ledgerEmptyText, useDebounced, useExport, useGo, useLedger, useOperations } from '../common';
import { useAdminData } from '../data';

const FLOWS: Array<[DepositFlowType | '', string]> = [['', '全部流水'], ['COLLECT', '收押金'], ['REFUND', '退押金'], ['DEDUCT', '报废扣押']];
const FLOW_TAGS: Record<DepositFlowType, [string, string]> = { COLLECT: ['收押金', 'green'], REFUND: ['退押金', 'blue'], DEDUCT: ['报废扣押', 'orange'] };
const NO_REPORTS = '需要报表权限';

/** 押金管理：桶、袋押金单独收退和对账，与水费充值分开。 */
export function Deposits() {
  const { finance: f, overview, containers } = useAdminData();
  const ops = useOperations();
  const go = useGo();
  const exportCsv = useExport();
  const [flow, setFlow] = useState<DepositFlowType | ''>('');
  const [query, setQuery] = useState('');
  const [date, setDate] = useState<DateFilter>('ALL');
  const [container, setContainer] = useState<ContainerType | ''>('');
  const q = useDebounced(query.trim());
  const filter: DepositLedgerQuery = { q, from: dateFilterFrom(date), flowType: flow || undefined, containerType: container || undefined };
  const filtered = !!(q || filter.from || flow || container);
  const standards = (['BUCKET', 'BAG'] as const).flatMap(type => containers.filter(c => c.containerType === type))
    .map(c => `${containerLabel(c.containerType)} ¥${money(c.unitDeposit)}/个`).join(' · ');

  return <>
    <div className="page-head">
      <div><h2>押金管理</h2><p>桶、袋押金单独收退，退款按原收款批次单价计算；押金不计入水费实收，也不触发赠水</p></div>
      <div className="head-actions">
        <button type="button" className="btn" onClick={() => ops.deposit('refund')}>申请退押金</button>
        <button type="button" className="btn primary" onClick={() => ops.deposit('collect')}><Icon name="plus" />收押金</button>
      </div>
    </div>
    <div className="stats-grid">
      <StatCard label="在池押金" icon="deposit" value={f ? `¥ ${money(f.unrefundedDepositPoolTotal)}` : '—'}
        foot={f ? (f.reconciledZeroDiff ? '与收退流水零误差对齐' : '与收退流水不一致，请核对') : NO_REPORTS} />
      <StatCard label="当前可退押金" icon="wallet" tone="blue" value={overview ? `¥ ${money(overview.refundableDeposit)}` : '—'} foot="已扣除会员持有容器的占用" />
      <StatCard label="累计收押" icon="plus" tone="gold" value={f ? `¥ ${money(f.depositCollectedTotal)}` : '—'} foot={f ? `共 ${f.depositCollectCount} 笔` : NO_REPORTS} />
      <StatCard label="累计退押与扣押" icon="refresh" tone="orange" value={f ? `¥ ${money(Number(f.depositRefundedTotal) + Number(f.depositDeductedTotal))}` : '—'}
        foot={f ? `退押 ${f.depositRefundCount} 笔 ¥${money(f.depositRefundedTotal)} · 报废扣押 ${f.depositDeductCount} 笔 ¥${money(f.depositDeductedTotal)}` : NO_REPORTS} />
    </div>
    {standards && (
      <div className="ledger-hint">
        <Icon name="info" size="sm" />
        <span>现行押金标准：{standards}。可在「水品与押金标准」调整，只影响之后的收款，历史押金仍按原单价退还。</span>
        <button type="button" className="text-btn" onClick={() => go('products')}>调整标准 ›</button>
      </div>
    )}
    <div className="tabs" role="tablist">
      {FLOWS.map(([id, label]) => (
        <button key={id || 'all'} type="button" role="tab" aria-selected={flow === id} className={`tab${flow === id ? ' active' : ''}`} onClick={() => setFlow(id)}>{label}</button>
      ))}
    </div>
    <div className="filter-card">
      <label className="field-search"><Icon name="search" /><input placeholder="搜索会员、手机号或单号" aria-label="搜索会员、手机号或单号" value={query} onChange={e => setQuery(e.target.value)} /></label>
      <select className="select" aria-label="容器" value={container} onChange={e => setContainer(e.target.value as ContainerType | '')}>
        <option value="">全部容器</option><option value="BUCKET">{containerLabel('BUCKET')}</option><option value="BAG">{containerLabel('BAG')}</option>
      </select>
      <DateFilterSelect label="业务时间" value={date} onChange={setDate} />
      <div className="filter-spacer" />
      <button type="button" className="btn" onClick={() => exportCsv('deposit-ledgers')}><Icon name="export" />导出押金明细</button>
    </div>
    <DepositTable filter={filter} filtered={filtered} />
  </>;
}

function DepositTable({ filter, filtered }: { filter: DepositLedgerQuery; filtered: boolean }) {
  const { api } = useAuth();
  const table = useLedger((query: DepositLedgerQuery) => api.depositLedger(query), filter);
  const rows: DepositLedgerRow[] = table.data?.rows ?? [];
  return (
    <div className="table-card ledger-table">
      <div style={{ overflowX: 'auto' }}>
        <table>
          <thead><tr><th>单号 / 时间</th><th>会员</th><th>业务</th><th>容器 × 数量</th><th>批次单价</th><th>押金金额</th><th>收付方式</th><th>未退余量</th><th>操作人</th></tr></thead>
          <tbody>
            {rows.length === 0 ? <EmptyRow colSpan={9}>{ledgerEmptyText(table, filtered, '暂无押金流水，请点击右上角「收押金」办理', '押金流水')}</EmptyRow> : rows.map(d => {
              const [label, tone] = FLOW_TAGS[d.flowType] ?? [d.flowType, 'gray'];
              const collect = d.flowType === 'COLLECT';
              return (
                <tr key={d.docNo}>
                  <td><span className="order-no">{d.docNo}</span><br /><small>{shortDateTime(d.createdAt)}</small></td>
                  <td><b>{d.memberName}</b><br /><small>{d.memberNo}</small></td>
                  <td><span className={`tag ${tone}`}>{label}</span></td>
                  <td>{containerLabel(d.containerType)} × {d.qty}</td>
                  <td>¥ {money(d.unitPrice)}</td>
                  <td><b className={collect ? 'amount-in' : 'amount-out'}>{collect ? '+' : '−'}¥ {money(d.amount)}</b></td>
                  <td>{d.payMethod ? payMethodLabel(d.payMethod) : <small>{d.flowType === 'DEDUCT' ? '从押金扣抵' : '未登记'}</small>}</td>
                  <td>{collect ? `${d.remainingQty} 个` : <small>—</small>}</td>
                  <td>{d.operatorName}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="table-footer"><span>共 {table.total} 条 · 退押金严格按原收取批次单价计算，报废按原实收批次扣押金</span><Pager page={table.page} total={table.total} onChange={table.setPage} /></div>
    </div>
  );
}
