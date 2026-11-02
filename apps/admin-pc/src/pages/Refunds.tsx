import { useState } from 'react';
import {
  KUNLUN_PERMISSIONS as P, PAY_METHODS, containerLabel, modeLabel, money, payMethodLabel, shortDateTime, unitOf, waterFallbackLabel,
  type PayMethod, type RefundKind, type RefundRequestQuery, type RefundRequestRow, type RefundRequestStatus, type ReviewSettings,
} from '@kunlun/shared';
import { Field, FormDialog, Icon, ReasonChips, useAuth, useDialogs, useLoader, useRun, useToast } from '@kunlun/ui';
import { EmptyRow, Pager, PAGE_SIZE, useDebounced, usePagedTable } from '../common';
import { useAdminData } from '../data';

type Tab = RefundRequestStatus | '';
const TABS: Array<[Tab, string]> = [['PENDING', '待审核'], ['APPROVED', '已通过'], ['REJECTED', '已驳回'], ['', '全部']];
const KINDS: Record<RefundKind, [string, string]> = { GIFT: ['充值赠送', 'green'], DEPOSIT: ['押金退款', 'blue'], RECHARGE: ['水费退款', 'gold'] };
const REJECT_REASONS: Record<'GIFT' | 'REFUND', readonly string[]> = {
  GIFT: ['不符合赠送规则', '赠送数量不对', '会员没有要求赠送'],
  REFUND: ['容器尚未归还', '申请信息有误', '会员已撤回申请', '重复申请'],
};
const statusText = (r: Pick<RefundRequestRow, 'kind' | 'status'>): [string, string] =>
  r.status === 'PENDING' ? ['待审核', 'orange'] : r.status === 'REJECTED' ? ['已驳回', 'gray'] : [r.kind === 'GIFT' ? '已到账' : '已退款', 'green'];

/**
 * 审核：店员充值时手动赠送的水票、店员办理的退押金和退水费，按顶部两个开关决定要不要在这里等管理员审核。
 * 通过即当场退款或让赠票到账，驳回不动任何账目；不要审核的和管理员自己办理的也在这里留有已通过的记录。
 */
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
  const empty = table.error || (!table.data ? '正在加载…' : filtered ? '没有符合条件的记录' : tab === 'PENDING' ? '没有待审核的赠送或退款' : '暂无记录');

  return <>
    <div className="page-head">
      <div><h2>审核</h2><p>店员的手动赠送和退款要不要等管理员，由下面两个开关决定；管理员自己办理直接生效，每笔都在这里留有记录</p></div>
    </div>
    <ReviewSwitches />
    <div className="tabs" role="tablist">
      {TABS.map(([id, label]) => (
        <button key={id || 'all'} type="button" role="tab" aria-selected={tab === id} className={`tab${tab === id ? ' active' : ''}`} onClick={() => setTab(id)}>
          {label}{id === 'PENDING' && pendingRefunds ? ` ${pendingRefunds}` : ''}
        </button>
      ))}
    </div>
    <div className="filter-card">
      <label className="field-search"><Icon name="search" /><input placeholder="搜索会员、手机号或单号" aria-label="搜索会员、手机号或单号" value={query} onChange={e => setQuery(e.target.value)} /></label>
      <select className="select" aria-label="审核类型" value={kind} onChange={e => setKind(e.target.value as RefundKind | '')}>
        <option value="">全部类型</option>
        {(Object.keys(KINDS) as RefundKind[]).map(k => <option key={k} value={k}>{KINDS[k][0]}</option>)}
      </select>
    </div>
    <div className="table-card ledger-table">
      <div style={{ overflowX: 'auto' }}>
        <table>
          <thead><tr><th>单号 / 申请人</th><th>会员</th><th>类型</th><th>内容</th><th>金额</th><th>原因</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>
            {rows.length === 0 ? <EmptyRow colSpan={8}>{empty}</EmptyRow> : rows.map(r => <RequestRow key={r.id} row={r} />)}
          </tbody>
        </table>
      </div>
      <div className="table-footer"><span>共 {table.total} 条 · 押金按原收款批次单价先进先出退还，水费按剩余付费票退还并收回赠票；金额以审核通过时为准</span><Pager page={table.page} total={table.total} onChange={table.setPage} /></div>
    </div>
  </>;
}

/** The two switches; only administrators may flip them, everyone else sees how they are set. */
function ReviewSwitches() {
  const { api, can } = useAuth();
  const toast = useToast();
  const run = useRun();
  const settings = useLoader(() => api.reviewSettings(), [api]);
  const editable = can(P.StaffManage);
  const s = settings.data;
  const flip = (field: 'giftReview' | 'refundReview') => run(async () => {
    if (!s) return;
    const next = await api.saveReviewSettings({ giftReview: s.giftReview, refundReview: s.refundReview, [field]: !s[field] });
    settings.setData(next);
    toast(field === 'giftReview'
      ? next.giftReview ? '已打开：店员手动赠送要审核' : '已关闭：店员手动赠送当场到账'
      : next.refundReview ? '已打开：店员退押金、退水费要审核' : '已关闭：店员可以当场退款');
  })();
  if (settings.error) return <p className="account-error" role="alert">审核设置读取失败：{settings.error}</p>;
  if (!s) return null;
  return (
    <div className="review-switches">
      <SwitchCard label="店员手动赠送要审核" on={s.giftReview} disabled={!editable} onToggle={() => flip('giftReview')}
        hint={s.giftReview ? '店员充值时填的赠送，管理员批准后才到账；付费水票当场到账' : '店员充值时填的赠送当场到账'} />
      <SwitchCard label="店员退押金、退水费要审核" on={s.refundReview} disabled={!editable} onToggle={() => flip('refundReview')}
        hint={s.refundReview ? '店员只能提交申请，管理员通过后才退款' : '店员当场就能退款'} />
      <small className="review-switches-foot">{switchedText(s)}{editable ? '' : '；只有管理员能修改'}</small>
    </div>
  );
}

const switchedText = (s: ReviewSettings) => s.updatedBy && s.updatedAt ? `${s.updatedBy} 于 ${shortDateTime(s.updatedAt)} 修改` : '默认两项都要审核';

function SwitchCard({ label, hint, on, disabled, onToggle }: { label: string; hint: string; on: boolean; disabled: boolean; onToggle: () => void }) {
  return (
    <div className="switch-card">
      <div><b>{label}</b><small>{hint}</small></div>
      <button type="button" role="switch" className="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={onToggle}><span /></button>
    </div>
  );
}

const reviewPermission = (kind: RefundKind) => kind === 'DEPOSIT' ? P.DepositRefundApprove : P.RechargeRefund;

function RequestRow({ row: r }: { row: RefundRequestRow }) {
  const { can } = useAuth();
  const { refresh } = useAdminData();
  const dialogs = useDialogs();
  const run = useRun();
  const [kindLabel, kindTone] = KINDS[r.kind];
  const [statusLabel, statusTone] = statusText(r);
  const review = run(() => dialogs.open(close => <ReviewDialog row={r} onClose={close} onDone={refresh} />));
  return (
    <tr>
      <td><span className="order-no">{r.requestNo}</span><br /><small>{r.applicantName} · {shortDateTime(r.createdAt)}</small></td>
      <td><b>{r.memberName}</b><br /><small>{r.memberNo} · {r.memberPhone}</small></td>
      <td><span className={`tag ${kindTone}`}>{kindLabel}</span></td>
      <td><RequestContent row={r} /></td>
      <td><RequestAmount row={r} /></td>
      <td className="ledger-reason">{r.reason || '—'}</td>
      <td>
        <span className={`tag ${statusTone}`}>{statusLabel}</span>
        {r.status !== 'PENDING' && <><br /><small>{r.reviewerName} · {r.reviewedAt ? shortDateTime(r.reviewedAt) : ''}</small></>}
        {r.status === 'APPROVED' && r.refundNo && <><br /><small>{r.refundNo}</small></>}
        {r.reviewNote && <><br /><small className="ledger-reason">{r.status === 'REJECTED' ? '驳回：' : ''}{r.reviewNote}</small></>}
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

function RequestContent({ row: r }: { row: RefundRequestRow }) {
  if (r.kind === 'DEPOSIT') return <>{r.containerType ? containerLabel(r.containerType) : '容器'} × {r.quantity}</>;
  const unit = r.waterType ? unitOf(r.waterType) : '张';
  const recharge = <>
    <small>{r.planName ?? '充值批次'}</small><br />
    <small className="container-reference" title={r.rechargeNo ?? ''}>{r.rechargeNo}</small>
  </>;
  if (r.kind === 'GIFT') return <>赠送 <b>{r.quantity}{unit}</b><br />{recharge}</>;
  return <>
    退剩余付费 {r.remainingBuy ?? 0}{unit} · 收回赠送 {r.remainingGift ?? 0}{unit}<br />{recharge}<br />
    <small>{r.waterType ? waterFallbackLabel(r.waterType) : ''}{r.fulfillMode ? ` · ${modeLabel(r.fulfillMode)}` : ''}</small>
  </>;
}

function RequestAmount({ row: r }: { row: RefundRequestRow }) {
  if (r.kind === 'GIFT') return r.rechargePaid == null ? <>—</> : <>充值 ¥ {money(r.rechargePaid)}<br /><small>付费 {r.rechargeBuyQty}{r.waterType ? unitOf(r.waterType) : ''}</small></>;
  return <>
    {r.status === 'APPROVED' ? <b className="amount-out">−¥ {money(r.refundAmount ?? 0)}</b> : <>约 ¥ {money(r.estimatedAmount)}</>}<br />
    <small>{r.payMethod ? payMethodLabel(r.payMethod) : '—'}</small>
  </>;
}

/** 通过即按当前账目当场退款或让赠票到账；需要驳回时另开一步填写驳回原因。 */
function ReviewDialog({ row: r, onClose, onDone }: { row: RefundRequestRow; onClose: () => void; onDone: () => Promise<void> }) {
  const { api } = useAuth();
  const toast = useToast();
  const dialogs = useDialogs();
  const run = useRun();
  const gift = r.kind === 'GIFT';
  const unit = r.waterType ? unitOf(r.waterType) : '张';
  const [pay, setPay] = useState<PayMethod>(r.payMethod ?? 'CASH');
  const [note, setNote] = useState('');
  const approve = async () => {
    const result = await api.approveRefund(r.id, gift ? { note: note.trim() || undefined } : { payMethod: pay, note: note.trim() || undefined });
    await onDone();
    toast(gift ? `已批准，赠送 ${r.quantity}${unit}已到账` : `已通过并退款 ¥${money(result.refundAmount)}（${result.refundNo}）`);
    onClose();
  };
  const reject = run(async () => {
    if (await dialogs.open<boolean>(close => <RejectDialog row={r} onClose={close} onDone={onDone} />)) onClose();
  });
  return (
    <FormDialog title={gift ? '审核充值赠送' : `审核${KINDS[r.kind][0]}`} description={`${r.requestNo} · ${r.applicantName} 于 ${new Date(r.createdAt).toLocaleString('zh-CN')} 提交`}
      submitLabel={gift ? '批准赠送' : '通过并退款'} onClose={onClose} onSubmit={approve}
      extraActions={<button type="button" className="btn danger" onClick={reject}>驳回</button>}>
      <div className="membership-summary">
        <b>{r.memberName} · {r.memberNo}</b>
        {gift
          ? <p>{r.planName}（{r.rechargeNo}）{r.rechargePaid != null ? `收 ¥${money(r.rechargePaid)}，` : ''}{r.applicantName} 另送 {r.quantity}{unit}</p>
          : r.kind === 'DEPOSIT'
            ? <p>退还 {r.containerType ? containerLabel(r.containerType) : '容器'}押金 {r.quantity} 个</p>
            : <p>退清 {r.planName}（{r.rechargeNo}）：退付费票 {r.remainingBuy ?? 0}，收回赠票 {r.remainingGift ?? 0}</p>}
        {r.reason && <p>原因：{r.reason}</p>}
        {gift ? <strong>批准后到账 {r.quantity}{unit}</strong> : <strong>预计退 ¥{money(r.estimatedAmount)}</strong>}
      </div>
      {!gift && <Field label="实际退款方式" htmlFor="reviewPay"><select id="reviewPay" className="select" value={pay} onChange={e => setPay(e.target.value as PayMethod)}>{PAY_METHODS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}</select></Field>}
      <Field label="审核备注（选填）" htmlFor="reviewNote"><input id="reviewNote" className="input" maxLength={500} value={note} onChange={e => setNote(e.target.value)} /></Field>
      <p className="membership-note">
        {gift
          ? '批准后赠送的水票马上到账；驳回就不送，充值本身不受影响。'
          : <>{r.kind === 'DEPOSIT'
            ? '通过时重新核对会员手里的桶袋，按原收款批次单价退还；若期间又领用了桶袋导致可退不足，请驳回后重新申请。'
            : '通过时按当时剩余付费票退款并收回赠票；有订单占用水票时须先处理订单。'}
            请确认已线下把钱退给会员，系统不发起支付平台转账。</>}
      </p>
    </FormDialog>
  );
}

function RejectDialog({ row: r, onClose, onDone }: { row: RefundRequestRow; onClose: (rejected?: boolean) => void; onDone: () => Promise<void> }) {
  const { api } = useAuth();
  const toast = useToast();
  const [note, setNote] = useState('');
  const gift = r.kind === 'GIFT';
  return (
    <FormDialog title={gift ? '驳回赠送' : '驳回退款申请'} description={`${r.requestNo} · ${r.memberName}`} submitLabel="确认驳回" onClose={() => onClose()} onSubmit={async () => {
      if (!note.trim()) throw new Error('请填写驳回原因');
      await api.rejectRefund(r.id, note.trim());
      await onDone();
      toast(gift ? `已驳回 ${r.requestNo}，赠送不到账` : `已驳回 ${r.requestNo}，账目未变动`);
      onClose(true);
    }}>
      <Field label="驳回原因" htmlFor="rejectNote"><input id="rejectNote" className="input" required maxLength={500} value={note} onChange={e => setNote(e.target.value)} /></Field>
      <ReasonChips options={REJECT_REASONS[gift ? 'GIFT' : 'REFUND']} value={note} onPick={setNote} />
      <p className="membership-note">{gift ? '驳回后这次充值的付费水票照常可用，只是不送。' : '驳回后会员的押金和水票保持不变，可重新提交申请。'}</p>
    </FormDialog>
  );
}
