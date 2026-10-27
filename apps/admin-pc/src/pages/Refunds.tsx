import { useState } from 'react';
import {
  KUNLUN_PERMISSIONS as P, PAY_METHODS, containerLabel, modeLabel, money, payMethodLabel, shortDateTime, unitOf, waterFallbackLabel,
  type PayMethod, type RefundKind, type RefundRequestQuery, type RefundRequestRow, type RefundRequestStatus,
} from '@kunlun/shared';
import { Field, FormDialog, Icon, ReasonChips, useAuth, useDialogs, useRun, useToast } from '@kunlun/ui';
import { EmptyRow, Pager, PAGE_SIZE, useDebounced, usePagedTable } from '../common';
import { useAdminData } from '../data';

type Tab = RefundRequestStatus | '';
const TABS: Array<[Tab, string]> = [['PENDING', '待审核'], ['APPROVED', '已通过'], ['REJECTED', '已驳回'], ['', '全部']];
const KINDS: Record<RefundKind, [string, string]> = { DEPOSIT: ['押金退款', 'blue'], RECHARGE: ['水费退款', 'gold'] };
const STATUS: Record<RefundRequestStatus, [string, string]> = { PENDING: ['待审核', 'orange'], APPROVED: ['已退款', 'green'], REJECTED: ['已驳回', 'gray'] };
const REJECT_REASONS = ['容器尚未归还', '申请信息有误', '会员已撤回申请', '重复申请'] as const;

/** 退款审核：押金退款和退清充值剩余权益都先由员工或会员提交申请，管理员在这里核对后通过（当场退款）或驳回（不动账）。 */
export function Refunds() {
  const { api } = useAuth();
  const { pendingRefunds } = useAdminData();
  const [tab, setTab] = useState<Tab>('PENDING');
  const [kind, setKind] = useState<RefundKind | ''>('');
  const [query, setQuery] = useState('');
  const q = useDebounced(query.trim());
  const filter: RefundRequestQuery = { status: tab || undefined, kind: kind || undefined, q };
  const filtered = !!(q || kind);
  const table = usePagedTable(page => api.refundRequests({ ...filter, page, pageSize: PAGE_SIZE }), [filter]);
  const rows = table.data?.rows ?? [];
  const empty = table.error || (!table.data ? '正在加载…' : filtered ? '没有符合条件的退款申请' : tab === 'PENDING' ? '没有待审核的退款申请' : '暂无退款申请');

  return <>
    <div className="page-head">
      <div><h2>退款审核</h2><p>所有退款先提交申请，管理员审核通过后才退款；驳回不动任何账目，水票和押金照常保留</p></div>
    </div>
    <div className="tabs" role="tablist">
      {TABS.map(([id, label]) => (
        <button key={id || 'all'} type="button" role="tab" aria-selected={tab === id} className={`tab${tab === id ? ' active' : ''}`} onClick={() => setTab(id)}>
          {label}{id === 'PENDING' && pendingRefunds ? ` ${pendingRefunds}` : ''}
        </button>
      ))}
    </div>
    <div className="filter-card">
      <label className="field-search"><Icon name="search" /><input placeholder="搜索会员、手机号或申请单号" aria-label="搜索会员、手机号或申请单号" value={query} onChange={e => setQuery(e.target.value)} /></label>
      <select className="select" aria-label="退款类型" value={kind} onChange={e => setKind(e.target.value as RefundKind | '')}>
        <option value="">全部类型</option><option value="DEPOSIT">押金退款</option><option value="RECHARGE">水费退款</option>
      </select>
    </div>
    <div className="table-card ledger-table">
      <div style={{ overflowX: 'auto' }}>
        <table>
          <thead><tr><th>申请单号 / 申请人</th><th>会员</th><th>类型</th><th>退款内容</th><th>金额 / 方式</th><th>申请原因</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>
            {rows.length === 0 ? <EmptyRow colSpan={8}>{empty}</EmptyRow> : rows.map(r => <RefundRow key={r.id} row={r} />)}
          </tbody>
        </table>
      </div>
      <div className="table-footer"><span>共 {table.total} 条 · 押金按原收款批次单价先进先出退还，水费按剩余付费票退还并收回赠票；金额以审核通过时为准</span><Pager page={table.page} total={table.total} onChange={table.setPage} /></div>
    </div>
  </>;
}

const reviewPermission = (kind: RefundKind) => kind === 'DEPOSIT' ? P.DepositRefundApprove : P.RechargeRefund;

function RefundRow({ row: r }: { row: RefundRequestRow }) {
  const { can } = useAuth();
  const { refresh } = useAdminData();
  const dialogs = useDialogs();
  const run = useRun();
  const [kindLabel, kindTone] = KINDS[r.kind];
  const [statusLabel, statusTone] = STATUS[r.status];
  const review = run(() => dialogs.open(close => <ReviewDialog row={r} onClose={close} onDone={refresh} />));
  return (
    <tr>
      <td><span className="order-no">{r.requestNo}</span><br /><small>{r.applicantName} · {shortDateTime(r.createdAt)}</small></td>
      <td><b>{r.memberName}</b><br /><small>{r.memberNo} · {r.memberPhone}</small></td>
      <td><span className={`tag ${kindTone}`}>{kindLabel}</span></td>
      <td><RefundContent row={r} /></td>
      <td>{r.status === 'APPROVED' ? <b className="amount-out">−¥ {money(r.refundAmount ?? 0)}</b> : <>约 ¥ {money(r.estimatedAmount)}</>}<br /><small>{r.payMethod ? payMethodLabel(r.payMethod) : '—'}</small></td>
      <td className="ledger-reason">{r.reason || '—'}</td>
      <td>
        <span className={`tag ${statusTone}`}>{statusLabel}</span>
        {r.status !== 'PENDING' && <><br /><small>{r.reviewerName} · {r.reviewedAt ? shortDateTime(r.reviewedAt) : ''}</small></>}
        {r.status === 'APPROVED' && r.refundNo && <><br /><small>{r.refundNo}</small></>}
        {r.status === 'REJECTED' && r.reviewNote && <><br /><small className="ledger-reason">驳回：{r.reviewNote}</small></>}
      </td>
      <td>
        {r.status === 'PENDING'
          ? can(reviewPermission(r.kind))
            ? <button type="button" className="btn primary sm" onClick={review}>审核</button>
            : <small>无审核权限</small>
          : '—'}
      </td>
    </tr>
  );
}

function RefundContent({ row: r }: { row: RefundRequestRow }) {
  if (r.kind === 'DEPOSIT') return <>{r.containerType ? containerLabel(r.containerType) : '容器'} × {r.quantity}</>;
  const unit = r.waterType ? unitOf(r.waterType) : '张';
  return <>
    {r.planName ?? '充值批次'}<br />
    <small className="container-reference" title={r.rechargeNo ?? ''}>{r.rechargeNo}</small><br />
    <small>{r.waterType ? waterFallbackLabel(r.waterType) : ''}{r.fulfillMode ? ` · ${modeLabel(r.fulfillMode)}` : ''}</small><br />
    <small>剩余付费 {r.remainingBuy ?? 0} · 赠 {r.remainingGift ?? 0} {unit}</small>
  </>;
}

/** 通过即按当前账目当场退款；需要驳回时另开一步填写驳回原因。 */
function ReviewDialog({ row: r, onClose, onDone }: { row: RefundRequestRow; onClose: () => void; onDone: () => Promise<void> }) {
  const { api } = useAuth();
  const toast = useToast();
  const dialogs = useDialogs();
  const run = useRun();
  const [pay, setPay] = useState<PayMethod>(r.payMethod ?? 'CASH');
  const [note, setNote] = useState('');
  const approve = async () => {
    const result = await api.approveRefund(r.id, { payMethod: pay, note: note.trim() || undefined });
    await onDone();
    toast(`已通过并退款 ¥${money(result.refundAmount)}（${result.refundNo}）`);
    onClose();
  };
  const reject = run(async () => {
    if (await dialogs.open<boolean>(close => <RejectDialog row={r} onClose={close} onDone={onDone} />)) onClose();
  });
  return (
    <FormDialog title={`审核${KINDS[r.kind][0]}`} description={`${r.requestNo} · ${r.applicantName} 于 ${new Date(r.createdAt).toLocaleString('zh-CN')} 提交`}
      submitLabel="通过并退款" onClose={onClose} onSubmit={approve}
      extraActions={<button type="button" className="btn danger" onClick={reject}>驳回</button>}>
      <div className="membership-summary">
        <b>{r.memberName} · {r.memberNo}</b>
        {r.kind === 'DEPOSIT'
          ? <p>退还 {r.containerType ? containerLabel(r.containerType) : '容器'}押金 {r.quantity} 个</p>
          : <p>退清 {r.planName}（{r.rechargeNo}）：退付费票 {r.remainingBuy ?? 0}，收回赠票 {r.remainingGift ?? 0}</p>}
        {r.reason && <p>申请原因：{r.reason}</p>}
        <strong>预计退 ¥{money(r.estimatedAmount)}</strong>
      </div>
      <Field label="实际退款方式" htmlFor="reviewPay"><select id="reviewPay" className="select" value={pay} onChange={e => setPay(e.target.value as PayMethod)}>{PAY_METHODS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}</select></Field>
      <Field label="审核备注（选填）" htmlFor="reviewNote"><input id="reviewNote" className="input" maxLength={500} value={note} onChange={e => setNote(e.target.value)} /></Field>
      <p className="membership-note">
        {r.kind === 'DEPOSIT'
          ? '通过时重新核对会员持有容器，按原收款批次单价退还；若期间又领用了容器导致可退不足，请驳回后重新申请。'
          : '通过时按当时剩余付费票退款并收回赠票；有订单占用水票时须先处理订单。'}
        请确认已线下把钱退给会员，系统不发起支付平台转账。
      </p>
    </FormDialog>
  );
}

function RejectDialog({ row: r, onClose, onDone }: { row: RefundRequestRow; onClose: (rejected?: boolean) => void; onDone: () => Promise<void> }) {
  const { api } = useAuth();
  const toast = useToast();
  const [note, setNote] = useState('');
  return (
    <FormDialog title="驳回退款申请" description={`${r.requestNo} · ${r.memberName}`} submitLabel="确认驳回" onClose={() => onClose()} onSubmit={async () => {
      if (!note.trim()) throw new Error('请填写驳回原因');
      await api.rejectRefund(r.id, note.trim());
      await onDone();
      toast(`已驳回 ${r.requestNo}，账目未变动`);
      onClose(true);
    }}>
      <Field label="驳回原因" htmlFor="rejectNote"><input id="rejectNote" className="input" required maxLength={500} value={note} onChange={e => setNote(e.target.value)} /></Field>
      <ReasonChips options={REJECT_REASONS} value={note} onPick={setNote} />
      <p className="membership-note">驳回后会员的押金和水票保持不变，可重新提交申请。</p>
    </FormDialog>
  );
}
