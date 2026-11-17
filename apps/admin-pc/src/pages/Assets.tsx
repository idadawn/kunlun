import { useState, type ReactNode } from 'react';
import {
  KUNLUN_PERMISSIONS as P, containerKind, containerLabel, money,
  type CirculationBusinessType, type CirculationRow, type ContainerDamageRow, type ContainerHoldingRow, type ContainerType, type Paged,
} from '@kunlun/shared';
import { DepositDialog, Field, FormDialog, MemberPicker, ReasonChips, Stepper, useApi, useAuth, useDialogs, useIdempotencyKey, useLoader, useRun, useToast } from '@kunlun/ui';
import { EmptyRow, Pager, useExport, useOperations } from '../common';
import { useAdminData } from '../data';

/** Common ways a bucket or bag gets damaged, offered as one-tap reasons when registering damage or scrapping. */
const DAMAGE_REASONS: Record<ContainerType, readonly string[]> = {
  BUCKET: ['桶身开裂漏水', '桶口破损', '提手断裂', '磕碰变形', '污染异味无法清洗', '自然老化'],
  BAG: ['袋体破损漏水', '袋口/阀门损坏', '封口不严', '污染无法清洗', '自然老化'],
};

function ReasonField({ value, onChange, placeholder = '填写来源或处理原因' }: { value: string; onChange: (value: string) => void; placeholder?: string }) {
  return (
    <Field label="原因 / 备注" htmlFor="operationReason">
      <textarea id="operationReason" className="input" maxLength={500} rows={3} required placeholder={placeholder} value={value} onChange={e => onChange(e.target.value)} />
    </Field>
  );
}

type Tab = 'holdings' | 'movements' | 'damages';
type Member = Pick<ContainerHoldingRow, 'id' | 'name' | 'memberNo' | 'heldBags' | 'heldBuckets' | 'depositAmount'>;
type Ledger = ({ tab: 'holdings' } & Paged<ContainerHoldingRow>) | ({ tab: 'movements' } & Paged<CirculationRow>) | ({ tab: 'damages' } & Paged<ContainerDamageRow>);
const TABS: Array<[Tab, string]> = [['movements', '流转记录'], ['holdings', '会员手里'], ['damages', '破损报废']];
const BUSINESS: Record<CirculationBusinessType, [string, string]> = {
  TURNOVER: ['领还', 'green'], DAMAGE_RETURN: ['破损还回', 'orange'], SCRAP: ['报废 · 扣押金', 'orange'], SCRAP_WAIVED: ['报废 · 不扣押金', 'gray'],
  OPENING: ['上系统前', 'gold'],
};
const time = (value: string) => new Date(value).toLocaleString('zh-CN', { hour12: false });

/** One flow row in words: what was taken, brought back or scrapped. */
function happened(r: CirculationRow) {
  // Written down, not moved: containers the member already had before the system (or a correction of that figure).
  if (r.businessType === 'OPENING') return r.deltaHeld > 0 ? '补录原来就在会员手里的' : '更正补录的数量';
  const parts = [
    r.fullOutQty ? `领走 ${r.fullOutQty} 个` : '',
    r.emptyInQty ? `${r.businessType === 'DAMAGE_RETURN' ? '破损还回' : '还回'} ${r.emptyInQty} 个` : '',
    r.scrappedQty ? `报废 ${r.scrappedQty} 个` : '',
  ].filter(Boolean);
  return parts.join('，') || '—';
}

export function Assets() {
  const { version, refresh, products } = useAdminData();
  const { api, can } = useAuth();
  const dialogs = useDialogs();
  const run = useRun();
  const ops = useOperations();
  const exportCsv = useExport();
  const manage = can(P.ContainerInventoryManage);
  const canScrap = manage && can(P.DepositRefundApprove);
  const [tab, setTab] = useState<Tab>('movements');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [type, setType] = useState<ContainerType | ''>('');
  const [status, setStatus] = useState('PENDING');
  const [page, setPage] = useState(1);
  const filter = (apply: () => void) => { apply(); setPage(1); };

  const ledger = useLoader<Ledger>(async () => tab === 'holdings' ? { tab, ...await api.containerHoldings(query, page) }
    : tab === 'movements' ? { tab, ...await api.containerCirculation(query, type, page) }
    : { tab, ...await api.containerDamages(query, type, status, page) }, [api, tab, query, type, status, page, version]);
  const done = async () => { await refresh(); await ledger.reload(); };

  const reportDamage = (member?: Member) => run(async () => {
    if (!manage) throw new Error('需要袋桶维护权限');
    const reported = await dialogs.open<boolean>(close => <DamageDialog member={member} onClose={close} onDone={done} />);
    if (reported) { setTab('damages'); setStatus('PENDING'); setSearch(''); setQuery(''); setPage(1); }
  })();
  const confirmScrap = (row: ContainerDamageRow) => run(() => dialogs.open(close => <ScrapDialog row={row} onClose={close} onDone={done} />))();

  // Render from the loaded result's own tab so a tab switch never pairs new headers with old rows.
  const result = ledger.data?.tab === tab ? ledger.data : null;
  let table: ReactNode;
  if (tab === 'holdings') table = <>
    <thead><tr><th>会员</th><th>手机号</th><th>各水品配套桶袋</th><th>押金余额</th><th>待报废</th><th>操作</th></tr></thead>
    <tbody>{body(6, '暂无持有袋桶或待报废的会员', result?.tab === 'holdings' && result.rows.map(m => (
      <tr key={m.id}>
        <td><b>{m.name}</b><br /><small>{m.memberNo}</small></td>
        <td>{m.phone}</td>
        <td>{m.holdings.map(h => <div key={h.containerType}>{h.name} · {h.quantity} {h.containerKind === 'BAG' ? '袋' : '桶'}</div>)}</td>
        <td>¥{money(m.depositAmount)}</td>
        <td>{m.pendingDamageQty} 个<br /><small>占用押金 ¥{money(m.pendingDamageAmount)}</small></td>
        <td><button type="button" className="text-btn" disabled={!manage || m.heldBags + m.heldBuckets === 0} onClick={() => reportDamage(m)}>登记破损</button></td>
      </tr>
    )))}</tbody>
  </>;
  else if (tab === 'movements') table = <>
    <thead><tr><th>时间</th><th>会员</th><th>桶袋</th><th>发生了什么</th><th>会员手里</th><th>押金</th><th>来源 / 原因</th><th>经办人</th></tr></thead>
    <tbody>{body(8, '暂无流转记录', result?.tab === 'movements' && result.rows.map(r => {
      const [label, tone] = BUSINESS[r.businessType] ?? BUSINESS.TURNOVER;
      return (
        <tr key={r.ledgerNo}>
          <td>{time(r.createdAt)}<br /><small className="container-reference" title={r.ledgerNo}>{r.ledgerNo}</small></td>
          <td><b>{r.memberName}</b><br /><small>{r.memberNo}</small></td>
          <td>{containerLabel(r.containerType)}</td>
          <td><span className={`tag ${tone}`}>{label}</span><br /><b>{happened(r)}</b></td>
          <td>{r.deltaHeld === 0 ? `${r.heldAfter} 个（不变）` : <b>{r.heldAfter - r.deltaHeld} → {r.heldAfter} 个</b>}</td>
          <td>{r.depositDeductedAmount ? <b className="amount-out">扣 ¥{money(r.depositDeductedAmount)}</b> : '—'}</td>
          <td className="inventory-reason">
            {r.referenceNo && <small className="container-reference" title={r.referenceNo}>{r.referenceNo.startsWith('ORD-') ? `水单 ${r.referenceNo}` : r.referenceNo}</small>}
            {r.referenceNo && r.remark && <br />}
            {r.remark === '独立领还' ? '单独登记' : r.remark}
          </td>
          <td>{r.operatorName}</td>
        </tr>
      );
    }))}</tbody>
  </>;
  else table = <>
    <thead><tr><th>时间 / 破损单号</th><th>会员</th><th>容器 / 数量</th><th>原实收押金</th><th>状态</th><th>原因</th><th>操作</th></tr></thead>
    <tbody>{body(7, '暂无符合条件的破损记录', result?.tab === 'damages' && result.rows.map(r => (
      <tr key={r.id}>
        <td>{time(r.createdAt)}<br /><small>{r.damageNo}</small></td>
        <td><b>{r.memberName}</b><br /><small>{r.memberNo}</small></td>
        <td>{containerLabel(r.containerType)} × {r.quantity}</td>
        <td>¥{money(r.depositAmount)}<br /><small>{r.status === 'PENDING' ? '报废时决定是否扣除' : r.depositWaived ? '未扣，已退回可用押金' : '已扣除'}</small></td>
        <td><span className={`tag ${r.status === 'PENDING' ? 'orange' : 'gray'}`}>{r.status === 'PENDING' ? '待报废' : r.depositWaived ? '已报废 · 未扣押金' : '已报废 · 已扣押金'}</span></td>
        <td className="inventory-reason">
          {r.reason}
          {r.uncoveredQty > 0 && <><br /><small className="amount-out">没押金 {r.uncoveredQty} 个：{r.uncoveredNote}</small></>}
          {r.scrapReason && <><br /><small>报废：{r.scrapReason}</small></>}
        </td>
        <td>{r.status === 'PENDING'
          ? <button type="button" className="text-btn danger" disabled={!canScrap} onClick={() => confirmScrap(r)}>确认报废</button>
          : <small className="container-reference" title={r.scrapNo}>{r.scrapNo}</small>}</td>
      </tr>
    )))}</tbody>
  </>;

  function body(colSpan: number, emptyText: string, content: ReactNode[] | false | undefined) {
    if (ledger.error) return <EmptyRow colSpan={colSpan}>{ledger.error}</EmptyRow>;
    if (!content) return <EmptyRow colSpan={colSpan}>正在加载台账…</EmptyRow>;
    return content.length ? content : <tr><td colSpan={colSpan} className="inventory-empty">{emptyText}</td></tr>;
  }

  const total = result?.total ?? 0;
  return <>
    <div className="page-head">
      <div><h2>袋桶台账</h2><p>每次领走、还回、破损和报废都记一笔：谁、什么时候、几个，会员手里从几个变成几个</p></div>
      <div className="head-actions">
        <button type="button" className="btn" onClick={() => exportCsv('container-ledgers')}>导出流转记录</button>
        <button type="button" className="btn" onClick={() => reportDamage()}>登记破损</button>
        <button type="button" className="btn primary" onClick={() => ops.movement()}>登记领还桶袋</button>
      </div>
    </div>
    <div className="container-ledger-toolbar">
      <div className="container-tabs" role="tablist" aria-label="台账视图">
        {TABS.map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'active' : ''} onClick={() => filter(() => setTab(id))}>{label}</button>)}
      </div>
      <div className="container-filters">
        <input className="input" type="search" aria-label="搜索会员或单号" placeholder="姓名、手机号、会员号或单号" value={search}
          onChange={e => setSearch(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') filter(() => setQuery(search.trim())); }} />
        <button type="button" className="btn sm" onClick={() => filter(() => setQuery(search.trim()))}>查询</button>
        {tab !== 'holdings' && (
          <select className="select" aria-label="容器类型" value={type} onChange={e => filter(() => setType(e.target.value as ContainerType | ''))}>
            <option value="">全部容器</option>{products.map(p => <option key={p.containerId} value={p.containerId}>{containerLabel(p.containerId)}</option>)}
          </select>
        )}
        {tab === 'damages' && (
          <select className="select" aria-label="破损状态" value={status} onChange={e => filter(() => setStatus(e.target.value))}>
            <option value="PENDING">待报废</option><option value="SCRAPPED">已报废</option><option value="">全部状态</option>
          </select>
        )}
      </div>
    </div>
    <div className="table-card">
      <div className="inventory-table-scroll"><table>{table}</table></div>
      <div className="table-footer"><span>共 {total} 条</span><Pager page={page} total={total} onChange={setPage} /></div>
    </div>
  </>;
}

/**
 * 登记破损归还。交过的押金先用来扣破损；不够扣的（比如欠着押金）先请他补交押金，不交也能登记，
 * 但必须写清报废费用给没给、为什么没交，这几个报废时没有押金可扣。
 */
function DamageDialog({ member, onClose, onDone }: { member?: Member; onClose: (reported?: boolean) => void; onDone: () => Promise<void> }) {
  const api = useApi();
  const toast = useToast();
  const dialogs = useDialogs();
  const key = useIdempotencyKey();
  const { products, containers, refresh } = useAdminData();
  const [selected, setSelected] = useState<Member | null>(member ?? null);
  const [type, setType] = useState<ContainerType>(member && member.heldBags === 0 ? 'BUCKET' : 'BAG');
  const summary = useLoader(() => selected ? api.depositSummary(selected.id) : Promise.resolve([]), [api, selected?.id]);
  const row = summary.data?.find(r => r.containerType === type);
  const held = row?.heldQty;
  // Deposit that can still pay for damage: paid and not refunded, less what earlier damage already holds.
  const coverable = row ? Math.max(0, row.paidQty - row.pendingDamageQty) : undefined;
  const [quantity, setQuantity] = useState(1);
  const [reason, setReason] = useState('');
  const [fee, setFee] = useState<'paid' | 'unpaid' | null>(null);
  const [why, setWhy] = useState('');
  const uncovered = coverable === undefined ? 0 : Math.max(0, quantity - coverable);

  const collect = async () => {
    if (!selected) return;
    await dialogs.open(close => <DepositDialog containers={containers} memberId={selected.id} action="collect" onClose={close} onDone={refresh} />);
    await summary.reload();
  };
  const submit = async () => {
    if (!selected) throw new Error('请选择会员');
    if (uncovered > 0 && !fee) throw new Error('押金不够扣：请选报废费用给没给');
    if (uncovered > 0 && !why.trim()) throw new Error('押金不够扣：请写一句为什么没交押金');
    try {
      await api.reportDamage({
        memberId: selected.id, containerType: type, quantity, reason: reason.trim(), idempotencyKey: key,
        ...(uncovered > 0 && { acceptUncovered: true, uncoveredNote: `报废费用${fee === 'paid' ? '给了' : '没给'}；说明：${why.trim()}` }),
      });
    } catch (e) {
      // The deposit may have changed meanwhile; show the current figures with the error.
      await summary.reload();
      throw e;
    }
    await onDone();
    toast(uncovered > 0 ? `破损已登记，其中 ${uncovered} 个没押金，备注已记下` : '破损已登记，押金尚未扣除');
    onClose(true);
  };
  return (
    <FormDialog title="登记破损归还" className="inventory-dialog" submitLabel="登记破损归还" onClose={() => onClose()} onSubmit={submit}>
      <div className="membership-summary">实物收回后登记：会员手里减掉，袋桶库存里的客户手里也跟着减，记为待确认报废。此时不扣押金，对应押金暂不可退款或用于新领用。</div>
      <Field label="会员" htmlFor="damageMember"><MemberPicker id="damageMember" value={selected} onChange={setSelected} /></Field>
      <Field label="容器类型" htmlFor="damageType">
        <select id="damageType" className="select" value={type} onChange={e => setType(e.target.value as ContainerType)}>
          {products.map(p => <option key={p.containerId} value={p.containerId}>{containerLabel(p.containerId)}</option>)}
        </select>
      </Field>
      <p className="membership-note">{selected ? `${containerLabel(type)}：持有 ${held ?? '…'} 个 · 交过的押金够扣 ${coverable ?? '…'} 个 · 押金余额 ¥${money(selected.depositAmount)}` : '请选择会员'}</p>
      <Field label="已收回破损数量（个）" htmlFor="damageQuantity">
        <Stepper id="damageQuantity" label="破损数量" value={quantity} onChange={setQuantity} min={1} max={10000} />
      </Field>
      {uncovered > 0 && (
        <section className="owed-note" aria-label="押金不够扣">
          <h5>押金不够扣<em>必填</em></h5>
          <p className="membership-note">
            他交过的押金只够扣 {coverable} 个，这次登记 {quantity} 个，还差 {uncovered} 个没押金。
            先让他补交押金（<button type="button" className="link" onClick={() => { void collect(); }}>去收押金</button>）；不交也能登记，但要写清报废费用给没给。
          </p>
          <div className="seg-switch" role="group" aria-label="报废费用">
            <button type="button" aria-pressed={fee === 'paid'} onClick={() => setFee('paid')}>报废费用给了</button>
            <button type="button" aria-pressed={fee === 'unpaid'} onClick={() => setFee('unpaid')}>报废费用没给</button>
          </div>
          <label htmlFor="damageNoDeposit">为什么没交押金</label>
          <input id="damageNoDeposit" className="input" maxLength={300} placeholder="如：顾客说下次一起交" value={why} onChange={e => setWhy(e.target.value)} />
        </section>
      )}
      <ReasonField value={reason} onChange={setReason} placeholder="如：桶身开裂漏水" />
      <ReasonChips options={DAMAGE_REASONS[containerKind(type)]} value={reason} onPick={setReason} />
    </FormDialog>
  );
}

/** 报废时决定押金：默认按原实收批次扣除；人为以外的损坏（如自然老化）可选不扣，由水站承担，押金退回会员可用余额。 */
function ScrapDialog({ row, onClose, onDone }: { row: ContainerDamageRow; onClose: () => void; onDone: () => Promise<void> }) {
  const api = useApi();
  const toast = useToast();
  const key = useIdempotencyKey();
  const [reason, setReason] = useState(row.reason);
  const [deduct, setDeduct] = useState(true);
  const submit = async () => {
    const receipt = await api.scrapDamage(row.id, { reason: reason.trim(), idempotencyKey: key, deductDeposit: deduct });
    await onDone();
    toast(receipt.depositWaived ? '报废完成，未扣押金，对应押金已退回会员可用余额' : `报废完成，已扣押金 ¥${money(receipt.deductedAmount)}`);
  };
  return (
    <FormDialog title="确认报废" className="inventory-dialog" submitLabel={deduct ? '确认报废并扣押金' : '确认报废，不扣押金'} onClose={onClose} onSubmit={submit}>
      <div className="seg-switch" role="group" aria-label="押金处理">
        <button type="button" aria-pressed={deduct} onClick={() => setDeduct(true)}>扣除押金</button>
        <button type="button" aria-pressed={!deduct} onClick={() => setDeduct(false)}>不扣押金（水站承担）</button>
      </div>
      <div className="scrap-confirmation">
        <b>{row.memberName} · {containerLabel(row.containerType)} {row.quantity} 个</b>
        {deduct
          ? <>
            <p>本次扣除押金 <strong>¥{money(row.depositAmount)}</strong></p>
            {row.lotBreakdown.length > 0 && <small>按原实收批次结算：{row.lotBreakdown.map(l => `${l.quantity} 个 × ¥${money(l.unitPrice)}`).join(' + ')}</small>}
          </>
          : <>
            <p>不扣押金 <strong>¥0.00</strong></p>
            <small>占用的 ¥{money(row.depositAmount)} 押金退回会员可用余额，会员可申请退还或用于新领用。</small>
          </>}
        {row.uncoveredQty > 0 && <p className="scrap-uncovered">其中 {row.uncoveredQty} 个登记时押金不够，没有押金可扣。登记备注：{row.uncoveredNote}</p>}
      </div>
      <p className="membership-note">确认后袋桶库存的合计减掉、已报废加上；{deduct ? '并扣除会员押金余额' : '不动会员押金余额，也不计入报废扣押金'}。会员手里的数量不再变。</p>
      <ReasonField value={reason} onChange={setReason} />
      <ReasonChips options={DAMAGE_REASONS[containerKind(row.containerType)]} value={reason} onPick={setReason} />
    </FormDialog>
  );
}
