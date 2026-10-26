import { useState, type ReactNode } from 'react';
import {
  KUNLUN_PERMISSIONS as P, money,
  type CirculationBusinessType, type CirculationRow, type ContainerDamageRow, type ContainerHoldingRow, type ContainerType, type Paged,
} from '@kunlun/shared';
import { Field, FormDialog, MemberPicker, useApi, useAuth, useDialogs, useIdempotencyKey, useLoader, useRun, useToast } from '@kunlun/ui';
import { EmptyRow, Pager, useExport, useOperations } from '../common';
import { useAdminData } from '../data';
import { CONTAINER_NAMES, ReasonField } from './Inventory';

type Tab = 'holdings' | 'movements' | 'damages';
type Member = Pick<ContainerHoldingRow, 'id' | 'name' | 'memberNo' | 'heldBags' | 'heldBuckets' | 'depositAmount'>;
type Ledger = ({ tab: 'holdings' } & Paged<ContainerHoldingRow>) | ({ tab: 'movements' } & Paged<CirculationRow>) | ({ tab: 'damages' } & Paged<ContainerDamageRow>);
const TABS: Array<[Tab, string]> = [['holdings', '会员持有'], ['movements', '周转流水'], ['damages', '破损报废']];
const BUSINESS: Record<CirculationBusinessType, string> = { TURNOVER: '领还周转', DAMAGE_RETURN: '破损归还', SCRAP: '报废扣押金' };
const time = (value: string) => new Date(value).toLocaleString('zh-CN', { hour12: false });

export function Assets() {
  const { version, refresh } = useAdminData();
  const { api, can } = useAuth();
  const dialogs = useDialogs();
  const run = useRun();
  const ops = useOperations();
  const exportCsv = useExport();
  const manage = can(P.ContainerInventoryManage);
  const canScrap = manage && can(P.DepositRefundApprove);
  const [tab, setTab] = useState<Tab>('holdings');
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
    <thead><tr><th>会员</th><th>手机号</th><th>持有水袋</th><th>持有桶</th><th>押金余额</th><th>待报废</th><th>操作</th></tr></thead>
    <tbody>{body(7, '暂无持有袋桶或待报废的会员', result?.tab === 'holdings' && result.rows.map(m => (
      <tr key={m.id}>
        <td><b>{m.name}</b><br /><small>{m.memberNo}</small></td>
        <td>{m.phone}</td>
        <td>{m.heldBags} 个</td>
        <td>{m.heldBuckets} 个</td>
        <td>¥{money(m.depositAmount)}</td>
        <td>{m.pendingDamageQty} 个<br /><small>占用押金 ¥{money(m.pendingDamageAmount)}</small></td>
        <td><button type="button" className="text-btn" disabled={!manage || m.heldBags + m.heldBuckets === 0} onClick={() => reportDamage(m)}>登记破损</button></td>
      </tr>
    )))}</tbody>
  </>;
  else if (tab === 'movements') table = <>
    <thead><tr><th>时间 / 单号</th><th>会员</th><th>容器 / 业务</th><th>领出 / 归还 / 报废</th><th>持有变化 / 结余</th><th>扣押金</th><th>关联单号 / 原因</th><th>操作人</th></tr></thead>
    <tbody>{body(8, '暂无周转记录', result?.tab === 'movements' && result.rows.map(r => (
      <tr key={r.ledgerNo}>
        <td>{time(r.createdAt)}<br /><small>{r.ledgerNo}</small></td>
        <td><b>{r.memberName}</b><br /><small>{r.memberNo}</small></td>
        <td>{CONTAINER_NAMES[r.containerType]}<br /><span className={`tag ${r.businessType === 'SCRAP' ? 'orange' : 'green'}`}>{BUSINESS[r.businessType] ?? '领还周转'}</span></td>
        <td>{r.fullOutQty} / {r.emptyInQty} / {r.scrappedQty}</td>
        <td>{r.deltaHeld > 0 ? '+' : ''}{r.deltaHeld}<br /><small>持有 {r.heldAfter} 个</small></td>
        <td>{r.depositDeductedAmount ? `−¥${money(r.depositDeductedAmount)}` : '—'}</td>
        <td className="inventory-reason"><small>{r.referenceNo}</small><br />{r.remark}</td>
        <td>{r.operatorName}</td>
      </tr>
    )))}</tbody>
  </>;
  else table = <>
    <thead><tr><th>时间 / 破损单号</th><th>会员</th><th>容器 / 数量</th><th>原实收押金</th><th>状态</th><th>原因</th><th>操作</th></tr></thead>
    <tbody>{body(7, '暂无符合条件的破损记录', result?.tab === 'damages' && result.rows.map(r => (
      <tr key={r.id}>
        <td>{time(r.createdAt)}<br /><small>{r.damageNo}</small></td>
        <td><b>{r.memberName}</b><br /><small>{r.memberNo}</small></td>
        <td>{CONTAINER_NAMES[r.containerType]} × {r.quantity}</td>
        <td>¥{money(r.depositAmount)}<br /><small>{r.status === 'PENDING' ? '待报废时扣除' : '已扣除'}</small></td>
        <td><span className={`tag ${r.status === 'PENDING' ? 'orange' : 'gray'}`}>{r.status === 'PENDING' ? '待报废' : '已报废'}</span></td>
        <td className="inventory-reason">{r.reason}{r.scrapReason && <><br /><small>报废：{r.scrapReason}</small></>}</td>
        <td>{r.status === 'PENDING'
          ? <button type="button" className="text-btn danger" disabled={!canScrap} onClick={() => confirmScrap(r)}>报废并扣押金</button>
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
      <div><h2>袋桶台账</h2><p>会员领还、破损归还与报废扣押金，全程记录</p></div>
      <div className="head-actions">
        <button type="button" className="btn" onClick={() => exportCsv('container-ledgers')}>导出周转流水</button>
        <button type="button" className="btn" onClick={() => reportDamage()}>登记破损</button>
        <button type="button" className="btn primary" onClick={() => ops.movement()}>登记领还</button>
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
            <option value="">全部容器</option><option value="BAG">周转水袋</option><option value="BUCKET">周转桶</option>
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

function DamageDialog({ member, onClose, onDone }: { member?: Member; onClose: (reported?: boolean) => void; onDone: () => Promise<void> }) {
  const api = useApi();
  const toast = useToast();
  const key = useIdempotencyKey();
  const [selected, setSelected] = useState<Member | null>(member ?? null);
  const [type, setType] = useState<ContainerType>(member && member.heldBags === 0 ? 'BUCKET' : 'BAG');
  const [quantity, setQuantity] = useState(1);
  const [reason, setReason] = useState('');

  const submit = async () => {
    if (!selected) throw new Error('请选择会员');
    await api.reportDamage({ memberId: selected.id, containerType: type, quantity, reason: reason.trim(), idempotencyKey: key });
    await onDone();
    toast('破损已登记，押金尚未扣除');
    onClose(true);
  };
  return (
    <FormDialog title="登记破损归还" className="inventory-dialog" submitLabel="登记破损归还" onClose={() => onClose()} onSubmit={submit}>
      <div className="membership-summary">实物收回后登记。减少会员持有、转入待报废；此时不扣押金，对应押金暂不可退款或用于新领用。</div>
      <Field label="会员" htmlFor="damageMember"><MemberPicker id="damageMember" value={selected} onChange={setSelected} /></Field>
      <Field label="容器类型" htmlFor="damageType">
        <select id="damageType" className="select" value={type} onChange={e => setType(e.target.value as ContainerType)}>
          <option value="BAG">周转水袋</option><option value="BUCKET">周转桶</option>
        </select>
      </Field>
      <p className="membership-note">{selected ? `当前持有${type === 'BAG' ? '水袋' : '桶'} ${type === 'BAG' ? selected.heldBags : selected.heldBuckets} 个 · 押金余额 ¥${money(selected.depositAmount)}` : '请选择会员'}</p>
      <Field label="已收回破损数量（个）" htmlFor="damageQuantity">
        <input id="damageQuantity" className="input" type="number" min={1} max={10000} step={1} required value={quantity} onChange={e => setQuantity(Number(e.target.value))} />
      </Field>
      <ReasonField value={reason} onChange={setReason} />
    </FormDialog>
  );
}

function ScrapDialog({ row, onClose, onDone }: { row: ContainerDamageRow; onClose: () => void; onDone: () => Promise<void> }) {
  const api = useApi();
  const toast = useToast();
  const key = useIdempotencyKey();
  const [reason, setReason] = useState(row.reason);
  const submit = async () => {
    const receipt = await api.scrapDamage(row.id, { reason: reason.trim(), idempotencyKey: key });
    await onDone();
    toast(`报废完成，已扣押金 ¥${money(receipt.deductedAmount)}`);
  };
  return (
    <FormDialog title="确认报废并扣押金" className="inventory-dialog" submitLabel="确认报废并扣押金" onClose={onClose} onSubmit={submit}>
      <div className="scrap-confirmation">
        <b>{row.memberName} · {CONTAINER_NAMES[row.containerType]} {row.quantity} 个</b>
        <p>本次扣除押金 <strong>¥{money(row.depositAmount)}</strong></p>
        <small>按原实收批次结算：{row.lotBreakdown.map(l => `${l.quantity} 个 × ¥${money(l.unitPrice)}`).join(' + ')}</small>
      </div>
      <p className="membership-note">确认后减少现存库存，增加累计报废，并扣除会员押金余额；不会再减少会员持有数量。</p>
      <ReasonField value={reason} onChange={setReason} />
    </FormDialog>
  );
}
