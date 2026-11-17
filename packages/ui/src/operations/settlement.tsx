import { useEffect, useRef, useState } from 'react';
import {
  KUNLUN_PERMISSIONS as P, containerLabel, money, payMethodLabel, shortDateTime,
  type PayMethod, type PermissionCode, type SettlementContainerInput, type SettlementContainerLine, type SettlementPreview, type SettlementSlip,
} from '@kunlun/shared';
import { useAuth } from '../auth';
import { Dialog, Field, FormDialog, useDialogs, useToast } from '../feedback';
import { useIdempotencyKey, useLoader } from '../hooks';
import { Stepper } from '../ordering';
import { RECHARGE_REFUND_REASONS } from './membership';
import { PayButtons, ReasonChips, errorText, parseYuan, sameYuan, type Done } from './common';

/** Settling refunds tickets and deposits and scraps containers, so it takes the rights to approve both kinds of refund. */
export const canSettle = (can: (permission: PermissionCode) => boolean) => can(P.RechargeRefund) && can(P.DepositRefundApprove);

const choiceOf = (c: SettlementContainerLine): SettlementContainerInput =>
  ({ containerType: c.containerType, returned: c.returned, damaged: c.damaged, waiveDamage: c.waiveDamage, unreturned: c.unreturnedMode });
const sameChoice = (a: SettlementContainerInput, b: SettlementContainerInput) => a.containerType === b.containerType
  && a.returned === b.returned && a.damaged === b.damaged && a.waiveDamage === b.waiveDamage && a.unreturned === b.unreturned;

/**
 * 退款结算：会员不再订水或搬走时，一张退款单结清剩余水票、押金和手里的桶袋。按手里实际的桶袋算：还回好的退押金，坏的默认扣押金，
 * 没还的选「不还了」扣下押金（没交押金的按标准从退款里扣），或「以后还」把欠的押金从退款里转成押金。实退金额默认等于应退，可以改。
 */
export function SettlementDialog({ memberId, memberName, onClose, onDone }: { memberId: string; memberName: string; onClose: () => void; onDone?: Done }) {
  const { api, can } = useAuth();
  const toast = useToast();
  const dialogs = useDialogs();
  const key = useIdempotencyKey();
  const [choices, setChoices] = useState<SettlementContainerInput[] | null>(null);
  const [preview, setPreview] = useState<SettlementPreview | null>(null);
  const [loadError, setLoadError] = useState('');
  const [amount, setAmount] = useState('');
  // Once staff type the amount, later changes to the slip leave it alone; until then it follows the computed total.
  const typed = useRef(false);
  const [pay, setPay] = useState<PayMethod>('CASH');
  const [reason, setReason] = useState('');
  const allowed = canSettle(can);

  useEffect(() => {
    if (!allowed) return;
    let alive = true;
    const timer = window.setTimeout(() => {
      api.settlementPreview(memberId, { containers: choices ?? undefined })
        .then(p => {
          if (!alive) return;
          setPreview(p); setLoadError('');
          if (!choices) setChoices(p.slip.containers.map(choiceOf));
          if (!typed.current) setAmount(money(Math.abs(p.slip.computedAmount)));
        })
        .catch(e => alive && setLoadError(errorText(e)));
    }, choices ? 200 : 0);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [api, memberId, choices, allowed]);

  if (!allowed) return <Dialog title="退款结算" onClose={onClose}><p className="account-error" role="alert">退款结算要由能审核水费和押金退款的管理员办理。</p></Dialog>;
  if (!preview) return (
    <Dialog title={`退款结算 · ${memberName}`} onClose={onClose}>
      {loadError ? <p className="account-error" role="alert">{loadError}</p> : <p className="membership-note">正在核对这位会员的水票、押金和桶袋…</p>}
    </Dialog>
  );

  const slip = preview.slip;
  // The slip shown was worked out for other counts until the preview for the latest ones comes back.
  const shown = slip.containers.map(choiceOf);
  const stale = !!choices && (choices.length !== shown.length || choices.some((c, i) => !sameChoice(c, shown[i])));
  const owes = slip.computedAmount < 0;
  const value = parseYuan(amount);
  const final = value === null ? null : owes ? -value : value;
  const changed = final !== null && !sameYuan(final, slip.computedAmount);
  const outOfRange = final !== null && (final < preview.range.min - 0.001 || final > preview.range.max + 0.001);
  const ticketTotal = slip.tickets.reduce((sum, t) => sum + Number(t.value), 0);
  const depositTotal = slip.containers.reduce((sum, c) => sum + Number(c.refundValue), 0);
  // Deposit never paid, taken from the refund: kept by the station for containers not coming back, or held for ones that will.
  const keptOffset = slip.containers.reduce((sum, c) => sum + offsetSplit(c).kept * Number(c.unitDeposit), 0);
  const chargedOffset = slip.containers.reduce((sum, c) => sum + Number(c.offsetAmount), 0) - keptOffset;
  const change = (type: string, patch: Partial<SettlementContainerInput>) =>
    setChoices(list => (list ?? []).map(c => c.containerType === type ? { ...c, ...patch } : c));
  const resetAmount = () => { typed.current = false; setAmount(money(Math.abs(slip.computedAmount))); };

  const submit = async () => {
    if (preview.blockers.length) throw new Error(preview.blockers[0]);
    if (stale) throw new Error(loadError || '正在按改过的桶袋数重新计算，请稍等再确认');
    if (final === null) throw new Error(`请填写${owes ? '实收' : '实退'}金额，最多两位小数`);
    if (outOfRange) throw new Error(rangeText(preview));
    const done = await api.settle(memberId, {
      idempotencyKey: key, payMethod: pay, containers: choices ?? [], amount: final, expectedAmount: slip.computedAmount, reason: reason.trim() || undefined,
    });
    await onDone?.();
    toast(`已结算 ${done.settlementNo}：${done.amount < 0 ? `收 ¥${money(-done.amount)}` : `退 ¥${money(done.amount)}`}`);
    void dialogs.open(close => <SettlementSlipDialog slip={done} onClose={close} />);
  };

  return (
    <FormDialog title={`退款结算 · ${memberName}`} className="settlement-dialog" onClose={onClose} onSubmit={submit}
      description="会员不再订水或搬家时一次结清：剩余水票、押金和手里的桶袋出一张退款单。按手里实际的桶袋数核算。"
      submitLabel={final === null ? '确认结算' : owes ? `确认已收 ¥${money(-final)}` : `确认已退 ¥${money(final)}`}>
      {preview.blockers.length > 0 && <div className="settle-blockers" role="alert">{preview.blockers.map(b => <p key={b}>{b}</p>)}</div>}

      <section className="settle-section" aria-labelledby="settleTicketsTitle">
        <h3 id="settleTicketsTitle">剩余水票</h3>
        {slip.tickets.length === 0 ? <p className="membership-note">没有可退的水票。</p> : slip.tickets.map(t => (
          <div key={t.batchId} className="settle-line">
            <span><b>{t.name}</b><small>剩付费 {t.remainingBuy}{t.unit}{t.remainingGift ? `，收回赠送 ${t.remainingGift}${t.unit}` : ''} · 按原实付单价折算</small></span>
            <strong>¥{money(t.value)}</strong>
          </div>
        ))}
      </section>

      <section className="settle-section" aria-labelledby="settleContainersTitle">
        <h3 id="settleContainersTitle">押金和手里的桶袋</h3>
        {slip.containers.length === 0 ? <p className="membership-note">没有押金，手里也没有桶袋。</p> : slip.containers.map(c => {
          const choice = choices?.find(x => x.containerType === c.containerType) ?? choiceOf(c);
          return <ContainerCard key={c.containerType} line={c} choice={choice} onChange={patch => change(c.containerType, patch)} />;
        })}
      </section>

      {slip.notes.map(n => <p key={n} className="membership-note settle-note">{n}</p>)}

      <div className="settle-total">
        <div><span>水票退款</span><b>¥{money(ticketTotal)}</b></div>
        <div><span>押金退还</span><b>¥{money(depositTotal)}</b></div>
        {chargedOffset > 0.001 && <div><span>没交押金的桶袋（从退款里扣）</span><b>−¥{money(chargedOffset)}</b></div>}
        {keptOffset > 0.001 && <div><span>欠的押金（从退款里转成押金）</span><b>−¥{money(keptOffset)}</b></div>}
        <div className="settle-total-sum"><span>{owes ? '会员应补' : '应退合计'}</span><strong>¥{money(Math.abs(slip.computedAmount))}</strong></div>
      </div>
      {stale && <p className={loadError ? 'account-error' : 'membership-note'} role="status">{loadError || '正在按改过的数重新计算…'}</p>}
      <Field label={owes ? '实收金额（元）' : '实退金额（元）'} htmlFor="settleAmount">
        <div className="refund-amount">
          <input id="settleAmount" className="input" type="number" inputMode="decimal" required min={0} step={0.01} value={amount}
            onChange={e => { typed.current = true; setAmount(e.target.value); }} />
          {changed && <button type="button" className="text-btn" onClick={resetAmount}>改回{owes ? '应补' : '应退'} ¥{money(Math.abs(slip.computedAmount))}</button>}
        </div>
      </Field>
      <p className={`refund-amount-note${changed || outOfRange ? ' changed' : ''}`}>
        {outOfRange ? rangeText(preview)
          : changed ? `比按账${final! < slip.computedAmount ? `少${owes ? '收' : '退'}` : `多${owes ? '收' : '退'}`} ¥${money(Math.abs(final! - slip.computedAmount))}，以这里填的为准：差额先记在水费退款上，少退的再从押金里扣`
          : '默认按应退填好；和会员商量好的金额不一样就改这里，按改的金额结清。'}
      </p>
      <label id="settlePayLabel">{owes ? '收款方式' : '退款方式'}</label>
      <PayButtons labelledBy="settlePayLabel" value={pay} onChange={setPay} />
      <Field label="原因（选填）" htmlFor="settleReason"><input id="settleReason" className="input" maxLength={200} value={reason} onChange={e => setReason(e.target.value)} /></Field>
      <ReasonChips options={RECHARGE_REFUND_REASONS} value={reason} onPick={setReason} />
      <p className="membership-note">只登记线下退款，不发起支付平台转账。确认后水票作废，押金和桶袋按上面结清，并生成一张退款单。</p>
    </FormDialog>
  );
}

const signed = (v: number) => v < 0 ? `收 ¥${money(-v)}` : `退 ¥${money(v)}`;
const rangeText = (p: SettlementPreview) => p.range.min === p.range.max
  ? `这次只能按${signed(p.range.max)}结：没有水费退款可以承担差额`
  : `只能在${signed(p.range.min)}到${signed(p.range.max)}之间：多退记在水费退款上（每笔不超过原实付），少退先少退水费、再扣押金`;

/** One container of the settlement: how many came back good or broken, what happens to the rest, and what that does to the money. */
function ContainerCard({ line: c, choice, onChange }: { line: SettlementContainerLine; choice: SettlementContainerInput; onChange: (patch: Partial<SettlementContainerInput>) => void }) {
  const id = c.containerType;
  const unreturned = c.held - choice.returned - choice.damaged;
  return (
    <div className="settle-card">
      <div className="settle-card-head"><b>{containerLabel(c.containerType)}</b><small>已交押金 {c.covered} 个 · 手里 {c.held} 个</small></div>
      {c.held > 0 ? <>
        <div className="settle-counts">
          <span className="settle-count">
            <label htmlFor={`settleReturned-${id}`}>还回好的</label>
            <Stepper id={`settleReturned-${id}`} label="还回好的个数" value={choice.returned} min={0} max={c.held - choice.damaged} onChange={n => onChange({ returned: n })} />
          </span>
          <span className="settle-count">
            <label htmlFor={`settleDamaged-${id}`}>坏的</label>
            <Stepper id={`settleDamaged-${id}`} label="坏的个数" value={choice.damaged} min={0} max={c.held - choice.returned} onChange={n => onChange({ damaged: n })} />
          </span>
        </div>
        {choice.damaged > 0 && (
          <label className="settle-check"><input type="checkbox" checked={choice.waiveDamage} onChange={e => onChange({ waiveDamage: e.target.checked })} />坏的不扣押金（自然老化等，水站承担）</label>
        )}
        {unreturned > 0 && (
          <div className="settle-modes" role="radiogroup" aria-label={`没还的 ${unreturned} 个${c.unit}怎么办`}>
            <span>没还的 {unreturned} 个：</span>
            <label><input type="radio" name={`settleMode-${id}`} checked={choice.unreturned === 'CHARGE'} onChange={() => onChange({ unreturned: 'CHARGE' })} />不还了，押金不退</label>
            <label><input type="radio" name={`settleMode-${id}`} checked={choice.unreturned === 'KEEP'} onChange={() => onChange({ unreturned: 'KEEP' })} />以后还，押金先留着</label>
          </div>
        )}
      </> : <p className="membership-note">手里没有{c.unit}，只退押金。</p>}
      <ContainerLines line={c} />
    </div>
  );
}

/**
 * Which containers the ones with no deposit paid end up as. Their deposit is taken from the refund and booked as the newest lot,
 * and the settlement uses lots oldest first for broken, written-off, refunded and then kept ones, so the newest go to the last.
 */
function offsetSplit(c: SettlementContainerLine) {
  let left = c.offsetQty;
  const take = (n: number) => { const part = Math.min(n, left); left -= part; return part; };
  const kept = take(c.keptQty);
  take(c.refundQty);
  const charge = take(c.unreturnedMode === 'CHARGE' ? c.unreturned : 0);
  const damage = take(c.damaged > 0 && !c.waiveDamage ? c.damaged : 0);
  return { kept, charge, damage };
}

/** What one container works out to, line by line; the same lines show on the finished slip. */
function ContainerLines({ line: c }: { line: SettlementContainerLine }) {
  const price = Number(c.unitDeposit);
  const split = offsetSplit(c);
  const rows: Array<[string, string, string?]> = [];
  // Broken or written-off ones: the deposit paid for them is kept, and the ones never paid for are charged from the refund.
  const keep = (what: string, qty: number, deducted: number, unpaid: number, verb: string) => {
    const charged: [string, string] = [`没交过押金，按每个 ¥${money(price)} 从退款里扣`, `−¥${money(unpaid * price)}`];
    if (!unpaid) rows.push([`${what}，${verb}`, `¥${money(deducted)} 不退`]);
    else if (unpaid === qty) rows.push([`${what}，${charged[0]}`, charged[1]]);
    else rows.push([`${what}，已交押金的 ${qty - unpaid} 个${verb}`, `¥${money(deducted - unpaid * price)} 不退`], [`另 ${unpaid} 个${charged[0]}`, charged[1]]);
  };
  if (c.refundQty > 0) rows.push([`退押金 ${c.refundQty} 个`, `+¥${money(c.refundAmount)}`, !sameYuan(Number(c.refundAmount), Number(c.refundValue)) ? `原价 ¥${money(c.refundValue)}，少退的记为扣押金` : undefined]);
  if (c.damaged > 0) {
    if (c.waiveDamage) rows.push([`坏的 ${c.damaged} 个，水站承担`, '不扣', c.damageUncovered ? `其中 ${c.damageUncovered} 个没交过押金` : undefined]);
    else keep(`坏的 ${c.damaged} 个`, c.damaged, Number(c.damageDeducted), split.damage, '扣押金');
  }
  if (c.unreturned > 0 && c.unreturnedMode === 'CHARGE') keep(`没还的 ${c.unreturned} 个`, c.unreturned, Number(c.chargeDeducted), split.charge, '押金不退');
  if (c.keptQty > 0) {
    rows.push([`留在会员手里 ${c.keptQty} 个，以后还回再退`, `押金 ¥${money(c.keptDeposit)}`]);
    if (split.kept) rows.push([`其中 ${split.kept} 个没交过押金，按每个 ¥${money(price)} 从退款里转成押金`, `−¥${money(split.kept * price)}`]);
  }
  if (!rows.length) return <p className="membership-note">没有要退或要扣的押金。</p>;
  return (
    <ul className="settle-lines">
      {rows.map(([label, figure, hint]) => <li key={label}><span>{label}{hint && <small>{hint}</small>}</span><b>{figure}</b></li>)}
    </ul>
  );
}

/** 退款单：结算完马上弹出，之后在会员档案里也能再打开。 */
export function SettlementSlipDialog({ slip, onClose }: { slip: SettlementSlip; onClose: () => void }) {
  const collected = slip.amount < 0;
  return (
    <Dialog title={`退款单 ${slip.settlementNo ?? ''}`} className="settlement-slip" onClose={onClose}
      description={`${slip.memberName} · ${slip.memberNo}${slip.createdAt ? ` · ${shortDateTime(slip.createdAt)}` : ''}${slip.operatorName ? ` · 经办 ${slip.operatorName}` : ''}`}>
      <section className="settle-section">
        <h3>水票</h3>
        {slip.tickets.length === 0 ? <p className="membership-note">没有退水票。</p> : slip.tickets.map(t => (
          <div key={t.batchId} className="settle-line">
            <span><b>{t.name}</b><small>退剩余付费 {t.remainingBuy}{t.unit}{t.remainingGift ? `，收回赠送 ${t.remainingGift}${t.unit}` : ''}{t.refundNo ? ` · ${t.refundNo}` : ''}</small>
              {!sameYuan(Number(t.amount), Number(t.value)) && <small>按账 ¥{money(t.value)}</small>}</span>
            <strong>¥{money(t.amount)}</strong>
          </div>
        ))}
      </section>
      <section className="settle-section">
        <h3>押金和桶袋</h3>
        {slip.containers.length === 0 ? <p className="membership-note">没有押金和桶袋。</p> : slip.containers.map(c => (
          <div key={c.containerType} className="settle-card">
            <div className="settle-card-head"><b>{containerLabel(c.containerType)}</b>
              <small>手里 {c.held} 个：还回好的 {c.returned}、坏的 {c.damaged}{c.unreturned ? `、没还 ${c.unreturned}（${c.unreturnedMode === 'KEEP' ? '以后还' : '不还了'}）` : ''}{c.refundNo ? ` · ${c.refundNo}` : ''}</small></div>
            <ContainerLines line={c} />
          </div>
        ))}
      </section>
      {slip.notes.map(n => <p key={n} className="membership-note settle-note">{n}</p>)}
      <div className="settle-total">
        <div><span>按账{slip.computedAmount < 0 ? '应补' : '应退'}</span><b>¥{money(Math.abs(slip.computedAmount))}</b></div>
        <div className="settle-total-sum"><span>{collected ? '实收' : '实退'}</span><strong>¥{money(Math.abs(slip.amount))}</strong></div>
        <small>{slip.payMethod ? payMethodLabel(slip.payMethod) : ''}{slip.reason ? ` · 原因：${slip.reason}` : ''}</small>
      </div>
    </Dialog>
  );
}

/** A member's settlement slips, newest first; reloads when `version` changes. */
export function useSettlements(memberId: string, version?: number) {
  const { api, can } = useAuth();
  return useLoader(() => can(P.MemberRead) ? api.settlements(memberId) : Promise.resolve([] as SettlementSlip[]), [api, memberId, version]);
}

/** Settlement slips as a list, each one tap from its full slip. */
export function SettlementRecords({ slips }: { slips: SettlementSlip[] }) {
  const dialogs = useDialogs();
  return (
    <div className="settle-records">
      {slips.map(s => (
        <button key={s.settlementNo} type="button" className="settle-record" onClick={() => dialogs.open(close => <SettlementSlipDialog slip={s} onClose={close} />)}>
          <span><b>{s.settlementNo}</b><small>{s.createdAt ? shortDateTime(s.createdAt) : ''} · {s.operatorName}</small></span>
          <strong>{s.amount < 0 ? `收 ¥${money(-s.amount)}` : `退 ¥${money(s.amount)}`}</strong>
        </button>
      ))}
    </div>
  );
}
