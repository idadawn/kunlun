import { useState } from 'react';
import {
  EXPENSE_CATEGORIES, KUNLUN_PERMISSIONS as P, containerLabel, dateFilterFrom, expenseCategoryLabel, money, payMethodLabel, shortDateTime, stationDay,
  type DateFilter, type Expense, type ExpenseCategory, type ExpenseQuery, type ExpenseStatus, type PayMethod,
} from '@kunlun/shared';
import { Field, FormDialog, Icon, PayButtons, ReasonChips, Stepper, useAuth, useDialogs, useIdempotencyKey, useLoader, useRun, useToast } from '@kunlun/ui';
import { DateFilterSelect, EmptyRow, Pager, StatCard, emptyPage, ledgerEmptyText, useDebounced, useExport, useGo, usePagedTable, PAGE_SIZE } from '../common';
import { useAdminData } from '../data';

const PERIOD_TEXT: Record<DateFilter, string> = { ALL: '全部时间', TODAY: '今天', WEEK: '近 7 天', MONTH: '本月' };

/**
 * 费用支出：买桶袋、配件耗材、维修和其他杂费一笔一条，和水费、押金分开记。上面四个数跟着所选时间走：
 * 花了多少、按类别分、同期水费净收和结余（水费净收 − 费用支出）。押金是会员的钱，不算收入也不算支出。
 */
export function Expenses() {
  const { api, can } = useAuth();
  const { version, refresh } = useAdminData();
  const dialogs = useDialogs();
  const run = useRun();
  const exportCsv = useExport();
  const go = useGo();
  const manage = can(P.ExpenseManage);
  const readable = manage || can(P.ReportExport);
  const [query, setQuery] = useState('');
  const [date, setDate] = useState<DateFilter>('MONTH');
  const [category, setCategory] = useState<ExpenseCategory | ''>('');
  const [status, setStatus] = useState<ExpenseStatus | ''>('');
  const q = useDebounced(query.trim());
  const from = dateFilterFrom(date);
  const filter: ExpenseQuery = { q, from, category: category || undefined, status: status || undefined };
  const filtered = !!(q || category || status);
  const summary = useLoader(() => readable ? api.expenseSummary({ from }) : Promise.resolve(null), [api, readable, from, version]);
  const table = usePagedTable(page => readable ? api.expenses({ ...filter, page, pageSize: PAGE_SIZE }) : Promise.resolve(emptyPage<Expense>()), [filter, readable]);
  const rows = table.data?.rows ?? [];
  const s = summary.data;
  const period = PERIOD_TEXT[date];
  const byCategory = (value: ExpenseCategory) => s?.categories.find(c => c.category === value)?.total ?? 0;
  const record = run(() => dialogs.open(close => <ExpenseDialog onClose={close} onDone={refresh} />));

  if (!readable) return <>
    <div className="page-head"><div><h2>费用支出</h2><p>需要费用支出或报表权限才能查看</p></div></div>
  </>;

  return <>
    <div className="page-head">
      <div><h2>费用支出</h2><p>买桶袋、配件耗材、维修等花出去的钱一笔一条记下来，记错了作废、不删除；押金是会员的钱，不算支出</p></div>
      {manage && <div className="head-actions"><button type="button" className="btn primary" onClick={record}><Icon name="plus" />登记支出</button></div>}
    </div>
    <div className="stats-grid">
      <StatCard label={`费用支出 · ${period}`} icon="chart" tone="orange" value={s ? `¥ ${money(s.expenseTotal)}` : '—'}
        foot={s ? `共 ${s.expenseCount} 笔${s.voidedCount ? `，另有 ${s.voidedCount} 笔已作废不计` : ''}` : summary.error || '正在统计…'} />
      <StatCard label={`买桶袋 · ${period}`} icon="box" tone="gold" value={s ? `¥ ${money(byCategory('CONTAINER'))}` : '—'}
        foot={s ? EXPENSE_CATEGORIES.filter(c => c.value !== 'CONTAINER').map(c => `${c.label} ¥${money(byCategory(c.value))}`).join(' · ') : '按类别合计'} />
      <StatCard label={`水费净收 · ${period}`} icon="wallet" tone="blue" value={s ? `¥ ${money(s.rechargeNet)}` : '—'}
        foot={s ? `实收 ¥${money(s.rechargeRevenue)} − 退款 ¥${money(s.rechargeRefunded)}，不含押金` : '同期水费实收 − 退款'} />
      <StatCard label={`结余 · ${period}`} icon="refund" value={s ? <span className={s.balance < 0 ? 'amount-out' : undefined}>¥ {money(s.balance)}</span> : '—'}
        foot="水费净收 − 费用支出；其中还有会员没用完的水费，可能要退" />
    </div>
    <div className="filter-card">
      <label className="field-search"><Icon name="search" /><input placeholder="搜索单号、买了什么、备注或经办人" aria-label="搜索支出" value={query} onChange={e => setQuery(e.target.value)} /></label>
      <select className="select" aria-label="支出类别" value={category} onChange={e => setCategory(e.target.value as ExpenseCategory | '')}>
        <option value="">全部类别</option>
        {EXPENSE_CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
      </select>
      <select className="select" aria-label="状态" value={status} onChange={e => setStatus(e.target.value as ExpenseStatus | '')}>
        <option value="">有效和已作废</option><option value="ACTIVE">只看有效</option><option value="VOIDED">只看已作废</option>
      </select>
      <DateFilterSelect label="购买日期" value={date} onChange={setDate} />
      <div className="filter-spacer" />
      {can(P.ReportExport) && <button type="button" className="btn" onClick={() => exportCsv('expenses')}><Icon name="export" />导出支出明细</button>}
    </div>
    <div className="table-card ledger-table">
      <div style={{ overflowX: 'auto' }}>
        <table>
          <thead><tr><th>支出单号 / 购买日期</th><th>类别</th><th>买了什么</th><th>金额</th><th>付款方式</th><th>备注</th><th>经办人</th><th>状态</th>{manage && <th>操作</th>}</tr></thead>
          <tbody>
            {rows.length === 0
              ? <EmptyRow colSpan={manage ? 9 : 8}>{ledgerEmptyText(table, filtered || date !== 'ALL', manage ? '还没有支出记录，点右上角「登记支出」；在袋桶库存「新购」时填花费也会记在这里' : '还没有支出记录', '支出记录')}</EmptyRow>
              : rows.map(e => <ExpenseRow key={e.id} row={e} manage={manage} onInventory={() => go('inventory')} />)}
          </tbody>
        </table>
      </div>
      <div className="table-footer"><span>共 {table.total} 条 · 按购买日期统计，作废的不计入合计</span><Pager page={table.page} total={table.total} onChange={table.setPage} /></div>
    </div>
  </>;
}

function ExpenseRow({ row: e, manage, onInventory }: { row: Expense; manage: boolean; onInventory: () => void }) {
  const { refresh } = useAdminData();
  const dialogs = useDialogs();
  const run = useRun();
  const voided = e.status === 'VOIDED';
  return (
    <tr className={voided ? 'row-voided' : undefined}>
      <td><span className="order-no">{e.expenseNo}</span><br /><small>{e.spentOn}{e.spentOn !== stationDay(new Date(e.createdAt)) ? ` · ${shortDateTime(e.createdAt)} 登记` : ''}</small></td>
      <td><span className="tag">{expenseCategoryLabel(e.category)}</span></td>
      <td><b>{e.item}</b>{e.quantity > 1 && <small> × {e.quantity}</small>}
        {e.containerType && <><br /><button type="button" className="link" onClick={onInventory} title={e.inventoryOperationNo ?? undefined}>随「新购」入库 · {containerLabel(e.containerType)}</button></>}</td>
      <td>{voided ? <s>¥ {money(e.amount)}</s> : <b className="amount-out">¥ {money(e.amount)}</b>}{e.quantity > 1 && <><br /><small>单价约 ¥{money(e.amount / e.quantity)}</small></>}</td>
      <td>{payMethodLabel(e.payMethod)}</td>
      <td className="ledger-reason">{e.remark || '—'}</td>
      <td>{e.operatorName}</td>
      <td>{voided
        ? <><span className="tag gray">已作废</span><br /><small title={e.voidReason ?? undefined}>{e.voidedBy} · {e.voidReason}</small></>
        : <span className="tag green">有效</span>}</td>
      {manage && <td>{!voided && <button type="button" className="link danger" onClick={run(() => dialogs.open(close => <VoidDialog row={e} onClose={close} onDone={refresh} />))}>作废</button>}</td>}
    </tr>
  );
}

/** Common things bought in each category: a tap fills 买了什么, which can still be edited. */
const ITEM_CHIPS: Record<ExpenseCategory, readonly string[]> = {
  CONTAINER: ['15L 空桶', '5L 水袋'],
  PARTS: ['桶盖', '压水器', '饮水机配件', '滤芯', '清洁用品'],
  REPAIR: ['送水车维修', '设备维修'],
  OTHER: ['水电费', '杂费'],
};

/** 登记一笔支出：选类别、填买了什么、花了多少钱和付款方式；购买日期默认今天，可以补登以前的。 */
function ExpenseDialog({ onClose, onDone }: { onClose: () => void; onDone: () => Promise<void> }) {
  const { api } = useAuth();
  const toast = useToast();
  const go = useGo();
  const key = useIdempotencyKey();
  const today = stationDay();
  const [category, setCategory] = useState<ExpenseCategory>('PARTS');
  const [item, setItem] = useState('');
  const [quantity, setQuantity] = useState(1);
  const [amount, setAmount] = useState('');
  const [pay, setPay] = useState<PayMethod>('WECHAT');
  const [spentOn, setSpentOn] = useState(today);
  const [remark, setRemark] = useState('');
  const value = Number(amount);
  const valid = amount !== '' && value > 0;
  const submit = async () => {
    if (!item.trim()) throw new Error('请填写买了什么');
    if (!valid || Math.round(value * 100) !== value * 100) throw new Error('请填写花了多少钱，精确到分');
    if (spentOn > today) throw new Error('购买日期不能晚于今天');
    const saved = await api.createExpense({ category, item: item.trim(), quantity, amount: value, payMethod: pay, spentOn, remark: remark.trim() || undefined, idempotencyKey: key });
    await onDone();
    toast(`已登记支出 ¥${money(saved.amount)}（${saved.expenseNo}）`);
  };
  return (
    <FormDialog title="登记支出" description="平时买桶袋、配件，修东西花的钱都记在这里，进费用统计" submitLabel={valid ? `确认登记 ¥${money(value)}` : '确认登记'} onClose={onClose} onSubmit={submit}>
      <label id="expenseCategoryLabel">花在哪类</label>
      <div className="mode-switch" role="group" aria-labelledby="expenseCategoryLabel">
        {EXPENSE_CATEGORIES.map(c => (
          <button key={c.value} type="button" className={category === c.value ? 'active' : ''} aria-pressed={category === c.value} aria-label={c.label} title={c.hint} onClick={() => setCategory(c.value)}>
            <span><b>{c.label}</b><small>{c.hint}</small></span>
          </button>
        ))}
      </div>
      {category === 'CONTAINER' && (
        <p className="membership-note">买回来的桶袋要加到库存的，请到 <button type="button" className="link" onClick={() => { onClose(); go('inventory'); }}>袋桶库存</button> 点「新购」并填花费，会自动记一笔，这里就不用再登记了。</p>
      )}
      <Field label="买了什么" htmlFor="expenseItem"><input id="expenseItem" className="input" required maxLength={80} placeholder="如：桶盖" value={item} onChange={e => setItem(e.target.value)} /></Field>
      <ReasonChips label="常买的" options={ITEM_CHIPS[category]} value={item} onPick={setItem} />
      <div className="movement-counts">
        <div><Field label="数量" htmlFor="expenseQty"><Stepper id="expenseQty" label="数量" value={quantity} onChange={setQuantity} min={1} max={1000000} /></Field></div>
        <div><Field label="一共花了多少钱（元）" htmlFor="expenseAmount">
          <input id="expenseAmount" className="input" type="number" inputMode="decimal" required min={0.01} max={10000000} step={0.01} placeholder="0.00" value={amount} onChange={e => setAmount(e.target.value)} />
        </Field></div>
      </div>
      <label id="expensePayLabel">付款方式</label>
      <PayButtons labelledBy="expensePayLabel" value={pay} onChange={setPay} />
      <Field label="购买日期" htmlFor="expenseDate"><input id="expenseDate" className="input" type="date" required max={today} value={spentOn} onChange={e => setSpentOn(e.target.value)} /></Field>
      <Field label="备注（选填）" htmlFor="expenseRemark"><input id="expenseRemark" className="input" maxLength={500} placeholder="如：在哪家买的、给谁修的" value={remark} onChange={e => setRemark(e.target.value)} /></Field>
      <div className="deposit-total">
        <span>这笔支出</span>
        <b>{valid ? `¥ ${money(value)}` : '—'}</b>
        <small>{expenseCategoryLabel(category)}{item.trim() ? ` · ${item.trim()}` : ''}{quantity > 1 && valid ? ` · ${quantity} 个，单价约 ¥${money(value / quantity)}` : ''} · {spentOn === today ? '今天' : spentOn} · {payMethodLabel(pay)}</small>
      </div>
    </FormDialog>
  );
}

const VOID_REASONS = ['记错了', '重复登记', '退货退款了'] as const;

/** 作废：记错的支出不删除，写明原因后不再计入合计；随「新购」记的支出作废后，库存不跟着改。 */
function VoidDialog({ row: e, onClose, onDone }: { row: Expense; onClose: () => void; onDone: () => Promise<void> }) {
  const { api } = useAuth();
  const toast = useToast();
  const [reason, setReason] = useState('');
  return (
    <FormDialog title="作废支出" description={`${e.expenseNo} · ${expenseCategoryLabel(e.category)} · ${e.item} · ¥${money(e.amount)}`} submitLabel="确认作废" onClose={onClose} onSubmit={async () => {
      if (!reason.trim()) throw new Error('请填写作废原因');
      await api.voidExpense(e.id, reason.trim());
      await onDone();
      toast(`已作废 ${e.expenseNo}，不再计入费用统计`);
    }}>
      <Field label="作废原因" htmlFor="voidReason"><input id="voidReason" className="input" required maxLength={500} value={reason} onChange={ev => setReason(ev.target.value)} /></Field>
      <ReasonChips options={VOID_REASONS} value={reason} onPick={setReason} />
      <p className="membership-note">作废后这笔记录还在，只是不再计入合计。{e.inventoryOperationNo ? '这笔是随「新购」记的，库存不会跟着减，买的数量不对请到袋桶库存改。' : ''}</p>
    </FormDialog>
  );
}
