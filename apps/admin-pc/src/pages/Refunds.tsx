import { useState } from 'react';
import {
  KUNLUN_PERMISSIONS as P, PAY_METHODS, containerLabel, containerUnit, modeLabel, money, payMethodLabel, shortDateTime, unitOf, waterFallbackLabel,
  type PayMethod, type RefundKind, type RefundRequestQuery, type RefundRequestRow, type RefundRequestStatus, type ReviewSettings,
} from '@kunlun/shared';
import { Field, FormDialog, Icon, ReasonChips, useAuth, useDialogs, useLoader, useRun, useToast } from '@kunlun/ui';
import { EmptyRow, Pager, PAGE_SIZE, useDebounced, usePagedTable } from '../common';
import { useAdminData } from '../data';

type Tab = RefundRequestStatus | '';
const TABS: Array<[Tab, string]> = [['PENDING', '待审核'], ['APPROVED', '已通过'], ['REJECTED', '已驳回'], ['', '全部']];
const KINDS: Record<RefundKind, [string, string]> = {
  GIFT: ['充值赠送', 'green'], COLLECT: ['收押金', 'aqua'], DEPOSIT: ['押金退款', 'blue'], RECHARGE: ['水费退款', 'gold'], DAMAGE: ['损坏不赔付', 'red'],
};
const APPROVED_TEXT: Record<RefundKind, string> = { GIFT: '已到账', COLLECT: '已入账', DEPOSIT: '已退款', RECHARGE: '已退款', DAMAGE: '已同意' };
const REFUND_REJECT = {
  title: '驳回退款申请', reasons: ['容器尚未归还', '申请信息有误', '会员已撤回申请', '重复申请'], done: '账目未变动',
  hint: '驳回后会员的押金和水票保持不变，可重新提交申请。',
};
/** What rejecting each kind says: the dialog title, the reasons offered, the toast and what it leaves behind. */
const REJECT: Record<RefundKind, { title: string; reasons: readonly string[]; done: string; hint: string }> = {
  GIFT: { title: '驳回赠送', reasons: ['不符合赠送规则', '赠送数量不对', '会员没有要求赠送'], done: '赠送不到账', hint: '驳回后这次充值的付费水票照常可用，只是不送。' },
  COLLECT: {
    title: '驳回收押金', reasons: ['钱没到账', '金额不对', '重复登记'], done: '这笔押金作废，会员按欠押金算',
    hint: '驳回后这笔押金作废、不入账，会员手里多出的桶袋算欠押金，下次交付时算进应付押金。钱其实到了的话请批准，不要驳回。',
  },
  DEPOSIT: REFUND_REJECT,
  RECHARGE: REFUND_REJECT,
  DAMAGE: {
    title: '驳回不赔付', reasons: ['要顾客赔', '原因不成立', '登记有误'], done: '请提醒员工去找顾客赔',
    hint: '驳回不动任何账目，只记下驳回原因；请提醒员工去找顾客把损坏的桶袋赔上。',
  },
};
const statusText = (r: Pick<RefundRequestRow, 'kind' | 'status'>): [string, string] =>
  r.status === 'PENDING' ? ['待审核', 'orange'] : r.status === 'REJECTED' ? ['已驳回', 'gray'] : [APPROVED_TEXT[r.kind], 'green'];

/**
 * 审核：充值时手动赠送的水票、员工收的押金、交付时损坏桶袋不赔付（这三样管理员账号办的也算）和店员办理的退押金、退水费，
 * 按顶部四个开关决定要不要在这里等管理员审核。通过即当场退款、让赠票到账或把押金入账；驳回不动账目，收押金驳回就作废这笔，
 * 会员变成欠押金。不要审核的退款、损坏不赔付和管理员自己办理的退款也在这里留有已通过的记录。
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
  const empty = table.error || (!table.data ? '正在加载…' : filtered ? '没有符合条件的记录' : tab === 'PENDING' ? '没有待审核的记录' : '暂无记录');

  return <>
    <div className="page-head">
      <div><h2>审核</h2><p>手动赠送、收押金、损坏不赔付和店员的退款要不要等管理员，由下面四个开关决定；前三样不分谁办的都在这里批准，管理员自己办理的退款直接生效，每笔退款都留有记录</p></div>
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
      <div className="table-footer"><span>共 {table.total} 条 · 收的押金批准后按收款时的单价入账；押金按原收款批次单价先进先出退还，水费按剩余付费票退还并收回赠票；金额以审核通过时为准</span><Pager page={table.page} total={table.total} onChange={table.setPage} /></div>
    </div>
  </>;
}

type SwitchField = 'giftReview' | 'refundReview' | 'depositReview' | 'damageReview';
const SWITCH_TOASTS: Record<SwitchField, [on: string, off: string]> = {
  giftReview: ['已打开：手动赠送要审核', '已关闭：手动赠送当场到账'],
  refundReview: ['已打开：店员退押金、退水费要审核', '已关闭：店员可以当场退款'],
  depositReview: ['已打开：收押金要审核', '已关闭：收押金当场入账'],
  damageReview: ['已打开：损坏不赔付要审核', '已关闭：损坏不赔付直接生效'],
};

/** The four switches; only administrators may flip them, everyone else sees how they are set. */
function ReviewSwitches() {
  const { api, can } = useAuth();
  const toast = useToast();
  const run = useRun();
  const settings = useLoader(() => api.reviewSettings(), [api]);
  const editable = can(P.StaffManage);
  const s = settings.data;
  const flip = (field: SwitchField) => run(async () => {
    if (!s) return;
    const next = await api.saveReviewSettings({
      giftReview: s.giftReview, refundReview: s.refundReview, depositReview: s.depositReview, damageReview: s.damageReview, [field]: !s[field],
    });
    settings.setData(next);
    toast(SWITCH_TOASTS[field][next[field] ? 0 : 1]);
  })();
  if (settings.error) return <p className="account-error" role="alert">审核设置读取失败：{settings.error}</p>;
  if (!s) return null;
  return (
    <div className="review-switches">
      <SwitchCard label="手动赠送要审核" on={s.giftReview} disabled={!editable} onToggle={() => flip('giftReview')}
        hint={s.giftReview ? '充值时填的赠送（管理员账号填的也一样）在这里批准后才到账；付费水票当场到账' : '充值时填的赠送当场到账'} />
      <SwitchCard label="店员退押金、退水费要审核" on={s.refundReview} disabled={!editable} onToggle={() => flip('refundReview')}
        hint={s.refundReview ? '店员只能提交申请，管理员通过后才退款' : '店员当场就能退款'} />
      <SwitchCard label="收押金要审核" on={s.depositReview} disabled={!editable} onToggle={() => flip('depositReview')}
        hint={s.depositReview
          ? '员工收的押金（交付时收的也算，管理员账号收的也一样）先记待审核，核对到账批准后才入账；交付照常，驳回就作废，会员变成欠押金'
          : '收的押金当场入账'} />
      <SwitchCard label="损坏不赔付要审核" on={s.damageReview} disabled={!editable} onToggle={() => flip('damageReview')}
        hint={s.damageReview ? '交付时损坏的桶袋选了不赔付，要在这里批准；驳回就提醒员工去找顾客赔，账目不变' : '不赔付直接生效，这里留一条已同意的记录'} />
      <small className="review-switches-foot">{switchedText(s)}{editable ? '' : '；只有管理员能修改'}</small>
    </div>
  );
}

const switchedText = (s: ReviewSettings) => s.updatedBy && s.updatedAt ? `${s.updatedBy} 于 ${shortDateTime(s.updatedAt)} 修改` : '默认都要审核';

function SwitchCard({ label, hint, on, disabled, onToggle }: { label: string; hint: string; on: boolean; disabled: boolean; onToggle: () => void }) {
  return (
    <div className="switch-card">
      <div><b>{label}</b><small>{hint}</small></div>
      <button type="button" role="switch" className="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={onToggle}><span /></button>
    </div>
  );
}

const reviewPermission = (kind: RefundKind) => kind === 'DEPOSIT' || kind === 'COLLECT' || kind === 'DAMAGE' ? P.DepositRefundApprove : P.RechargeRefund;

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
  const container = r.containerType ? containerLabel(r.containerType) : '容器';
  if (r.kind === 'DEPOSIT') return <>{container} × {r.quantity}</>;
  if (r.kind === 'COLLECT') return <>{container} × {r.quantity}{r.unitPrice != null && <><br /><small>押金 ¥{money(r.unitPrice)}/个</small></>}</>;
  if (r.kind === 'DAMAGE') return <>损坏 {container} × {r.quantity}{r.orderNo && <><br /><small className="container-reference" title={r.orderNo}>水单 {r.orderNo}</small></>}</>;
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
  if (r.kind === 'DAMAGE') return <>—<br /><small>不动账</small></>;
  const pay = <small>{r.payMethod ? payMethodLabel(r.payMethod) : '—'}</small>;
  if (r.kind === 'COLLECT') return <>
    {r.status === 'APPROVED' ? <b className="amount-in">+¥ {money(r.refundAmount ?? r.estimatedAmount)}</b> : <>¥ {money(r.estimatedAmount)}</>}<br />{pay}
  </>;
  return <>
    {r.status === 'APPROVED' ? <b className="amount-out">−¥ {money(r.refundAmount ?? 0)}</b> : <>约 ¥ {money(r.estimatedAmount)}</>}<br />{pay}
  </>;
}

/** 通过即按当前账目当场退款、让赠票到账或把收的押金入账；需要驳回时另开一步填写驳回原因。 */
function ReviewDialog({ row: r, onClose, onDone }: { row: RefundRequestRow; onClose: () => void; onDone: () => Promise<void> }) {
  const { api } = useAuth();
  const toast = useToast();
  const dialogs = useDialogs();
  const run = useRun();
  const { kind } = r;
  const unit = r.waterType ? unitOf(r.waterType) : '张';
  const container = r.containerType ? containerLabel(r.containerType) : '容器';
  const piece = r.containerType ? containerUnit(r.containerType) : '桶袋';
  // Gifts and damage waivers move no money; for the rest the reviewer can correct how the money actually went.
  const movesMoney = kind !== 'GIFT' && kind !== 'DAMAGE';
  const [pay, setPay] = useState<PayMethod>(r.payMethod ?? 'CASH');
  const [note, setNote] = useState('');
  const approve = async () => {
    const result = await api.approveRefund(r.id, { ...(movesMoney ? { payMethod: pay } : {}), note: note.trim() || undefined });
    await onDone();
    toast(kind === 'GIFT' ? `已批准，赠送 ${r.quantity}${unit}已到账`
      : kind === 'COLLECT' ? `已批准，押金 ¥${money(result.refundAmount)} 已入账（${result.refundNo}）`
      : kind === 'DAMAGE' ? `已同意不赔付（${r.requestNo}）`
      : `已通过并退款 ¥${money(result.refundAmount)}（${result.refundNo}）`);
    onClose();
  };
  const reject = run(async () => {
    if (await dialogs.open<boolean>(close => <RejectDialog row={r} onClose={close} onDone={onDone} />)) onClose();
  });
  const submitLabel = kind === 'GIFT' ? '批准赠送' : kind === 'COLLECT' ? '钱已到账，批准' : kind === 'DAMAGE' ? '同意不赔付' : '通过并退款';
  const happened = kind === 'COLLECT' ? '收款' : kind === 'DAMAGE' ? '交付时登记' : '提交';
  return (
    <FormDialog title={kind === 'GIFT' ? '审核充值赠送' : `审核${KINDS[kind][0]}`} description={`${r.requestNo} · ${r.applicantName} 于 ${new Date(r.createdAt).toLocaleString('zh-CN')} ${happened}`}
      submitLabel={submitLabel} onClose={onClose} onSubmit={approve}
      extraActions={<button type="button" className="btn danger" onClick={reject}>驳回</button>}>
      <div className="membership-summary">
        <b>{r.memberName} · {r.memberNo}</b>
        {kind === 'GIFT'
          ? <p>{r.planName}（{r.rechargeNo}）{r.rechargePaid != null ? `收 ¥${money(r.rechargePaid)}，` : ''}{r.applicantName} 另送 {r.quantity}{unit}</p>
          : kind === 'COLLECT'
            ? <p>{container}：{r.applicantName} 收了 {r.quantity} 个{piece}的押金{r.unitPrice != null ? `，每个 ¥${money(r.unitPrice)}` : ''}{r.payMethod ? `，${payMethodLabel(r.payMethod)}` : ''}</p>
            : kind === 'DAMAGE'
              ? <p>{r.orderNo ? `水单 ${r.orderNo} ` : ''}交付时损坏 {r.quantity} 个{piece}（{container}），顾客不赔付</p>
              : kind === 'DEPOSIT'
                ? <p>退还 {container}押金 {r.quantity} 个</p>
                : <p>退清 {r.planName}（{r.rechargeNo}）：退付费票 {r.remainingBuy ?? 0}，收回赠票 {r.remainingGift ?? 0}</p>}
        {r.reason && <p>{kind === 'DAMAGE' ? '不赔付的原因' : '原因'}：{r.reason}</p>}
        <strong>{kind === 'GIFT' ? `批准后到账 ${r.quantity}${unit}`
          : kind === 'COLLECT' ? `批准后入账 ¥${money(r.estimatedAmount)}`
          : kind === 'DAMAGE' ? '批准、驳回都不动账'
          : `预计退 ¥${money(r.estimatedAmount)}`}</strong>
      </div>
      {movesMoney && (
        <Field label={kind === 'COLLECT' ? '实际收款方式' : '实际退款方式'} htmlFor="reviewPay">
          <select id="reviewPay" className="select" value={pay} onChange={e => setPay(e.target.value as PayMethod)}>{PAY_METHODS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}</select>
        </Field>
      )}
      <Field label="审核备注（选填）" htmlFor="reviewNote"><input id="reviewNote" className="input" maxLength={500} value={note} onChange={e => setNote(e.target.value)} /></Field>
      <p className="membership-note">
        {kind === 'GIFT'
          ? '批准后赠送的水票马上到账；驳回就不送，充值本身不受影响。'
          : kind === 'COLLECT'
            ? '先核对微信、支付宝或钱箱里这笔钱到没到。批准后押金按收款时的单价入账，会员以后退桶袋就按这笔退；钱没到就驳回，这笔作废，会员手里多出的桶袋算欠押金。'
            : kind === 'DAMAGE'
              ? '批准就是水站自己承担这次损坏，账目不变；不同意就驳回，并提醒员工去找顾客赔。'
              : <>{kind === 'DEPOSIT'
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
  const text = REJECT[r.kind];
  return (
    <FormDialog title={text.title} description={`${r.requestNo} · ${r.memberName}`} submitLabel="确认驳回" onClose={() => onClose()} onSubmit={async () => {
      if (!note.trim()) throw new Error('请填写驳回原因');
      await api.rejectRefund(r.id, note.trim());
      await onDone();
      toast(`已驳回 ${r.requestNo}，${text.done}`);
      onClose(true);
    }}>
      <Field label="驳回原因" htmlFor="rejectNote"><input id="rejectNote" className="input" required maxLength={500} value={note} onChange={e => setNote(e.target.value)} /></Field>
      <ReasonChips options={text.reasons} value={note} onPick={setNote} />
      <p className="membership-note">{text.hint}</p>
    </FormDialog>
  );
}
