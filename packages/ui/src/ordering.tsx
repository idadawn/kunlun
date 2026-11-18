import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  KUNLUN_BRAND, KUNLUN_PERMISSIONS as P, PAY_METHODS, containerKind, containerUnit, modeLabel, money, payMethodLabel, ticketSummary, ticketsFor, unitOf,
  type DepositSummaryRow, type ContainerType, type CreateOrderResult, type FulfillMode, type MemberProfile, type PayMethod, type WaterProduct, type WaterType,
} from '@kunlun/shared';
import { AddressPicker } from './addresses';
import { useApi, useAuth } from './auth';
import { FormDialog, NumberInput, useDialogs, useRun } from './feedback';
import { useLoader } from './hooks';
import { Icon } from './icons';
import { parseYuan, useReviewSettings, waitsForReview } from './operations/common';

export const DELIVERY_SLOTS = ['尽快送达（约 45 分钟内）', '今天 14:00–16:00', '今天 16:00–18:00'];

export interface DepositPosition {
  held: number;
  unitDeposit: number;
  damageQty: number;
  pool: DepositSummaryRow['pool'];
}

export function useDepositPositions(memberId: string | undefined) {
  const api = useApi();
  return useLoader(async () => {
    if (!memberId) return null;
    const rows = await api.depositSummary(memberId);
    return Object.fromEntries(rows.map(r => [r.containerType, {
      held: r.heldQty, unitDeposit: r.unitDeposit, damageQty: r.damageQty, pool: r.pool,
    } satisfies DepositPosition]));
  }, [api, memberId]);
}

export function depositGap(p: DepositPosition, fullOut: number, emptyIn: number) {
  return Math.max(0, Math.round((p.pool.required + (fullOut - emptyIn) * p.unitDeposit - p.pool.available - p.pool.pendingCollect) * 100) / 100);
}

function Holdings({ products, positions, error }: { products: WaterProduct[]; positions: Record<ContainerType, DepositPosition> | null; error: string }) {
  const pool = positions && Object.values(positions)[0]?.pool;
  return <section className="holdings" aria-label="手里的桶袋和已交押金">
    {error ? <p role="alert">{error}</p> : pool ? <>
      <div className="holding"><b>押金余额 ¥{money(pool.total)}</b><p>持有桶袋需 ¥{money(pool.required)} · {pool.shortfall ? `欠押金 ¥${money(pool.shortfall)}` : '押金已覆盖'}</p>
        {pool.pendingCollect > 0 && <small>另有 ¥{money(pool.pendingCollect)} 收款待审核，已计入覆盖金额</small>}</div>
      {products.map(p => { const pos = positions?.[p.containerId]; return pos && <div key={p.containerId} className="holding"><b>{p.name}</b>
        <p>手里 {pos.held} 个{containerUnit(p.containerId)}{pos.damageQty > 0 && ` · 累计登记破损 ${pos.damageQty} 个`}</p></div>; })}
    </> : <p>正在核对桶袋和押金…</p>}
  </section>;
}

function DepositRows({ unit, position, fullOut, emptyIn, dueLabel }: {
  unit: string; position: DepositPosition; fullOut: number; emptyIn: number | null; dueLabel: string;
}) {
  return <>
    <div className="deposit-row">
      <span>当前持有</span>
      <b>{position.held} 个{unit} · 价值 ¥{money(position.held * position.unitDeposit)}</b>
    </div>
    {emptyIn === null
      ? <div className="deposit-row"><span>本次领出</span><b>{fullOut} 个{unit}</b></div>
      : <div className="deposit-row">
          <span>已交押金{position.pool.pendingCollect > 0 && <small>其中 ¥{money(position.pool.pendingCollect)} 已收待审核</small>}</span>
          <strong>¥{money(position.pool.total + position.pool.pendingCollect)}</strong>
        </div>}
    <div className="deposit-row due"><span>{dueLabel}</span><strong>¥{money(depositGap(position, fullOut, emptyIn ?? 0))}</strong></div>
  </>;
}

export function DepositEstimate({ type, position, qty, title }: {
  type: ContainerType; position: DepositPosition; qty: number; title?: string;
}) {
  return <div className="deposit-handover">{title && <h5>{title}</h5>}
    <DepositRows unit={containerUnit(type)} position={position} fullOut={qty} emptyIn={null} dueLabel="预计交付后押金缺口" />
    <small>按本次暂未归还空桶袋估算，实际归还后重新计算，可继续下单。</small>
  </div>;
}

/**
 * What staff record at hand-over: the amount received when a deposit is due,
 * and whether any container came back damaged, whether the customer pays for it, and why not.
 */
export interface HandoverChoice {
  /** 客户是否支付押金, null until staff answer. */
  pays: boolean | null;
  /** Actual yuan received, defaulting to the estimated shortfall. */
  amount?: string;
  damaged: boolean;
  damagedQty: number;
  /** 是否赔付, null until staff answer. */
  compensated: boolean | null;
  /** Why a damaged container is not paid for. */
  reason: string;
}
export const EMPTY_HANDOVER: HandoverChoice = { pays: null, damaged: false, damagedQty: 1, compensated: null, reason: '' };

/** A shortfall is advisory. Only an explicitly recorded payment is collected. */
export function paidOf(choice: HandoverChoice, due: number) {
  return choice.pays && due > 0 ? parseYuan(choice.amount ?? money(due)) ?? 0 : 0;
}

/** What the hand-over answers still lack, or '' when they are complete. */
export function handoverProblem(choice: HandoverChoice, due: number, unit: string) {
  if (due > 0 && choice.pays && paidOf(choice, due) <= 0) return '请输入实际收到的押金，最多两位小数';
  if (choice.damaged && choice.compensated === null) return `先选损坏的${unit}是否赔付`;
  if (choice.damaged && choice.compensated === false && !choice.reason.trim()) return `损坏的${unit}不赔付，要写上原因`;
  return '';
}

/**
 * The sentence saved with the order and the container ledger, e.g. 顾客没交押金，交付后欠 5 个袋的押金 ¥25.00；损坏 1 个袋，
 * 不赔付：自然老化. `paid` is the deposit taken for this order, `owed` what the member still owes after it. '' when nothing to say.
 */
export function composeHandoverNote(choice: HandoverChoice, { unit, paid, owed }: { unit: string; paid: number; owed: number }) {
  const parts: string[] = [];
  if (paid > 0) parts.push(`本次实收押金 ¥${money(paid)}`);
  if (owed > 0) parts.push(`交付后欠押金 ¥${money(owed)}`);
  if (choice.damaged) parts.push(`损坏 ${choice.damagedQty} 个${unit}，${choice.compensated ? '顾客赔付' : `不赔付：${choice.reason.trim()}`}`);
  return parts.join('；');
}

/** The damage answers as the hand-over request carries them; nothing when no container is damaged. */
export function damageFields(choice: HandoverChoice) {
  if (!choice.damaged) return {};
  return { damagedQty: choice.damagedQty, damageCompensated: choice.compensated, damageReason: choice.compensated ? null : choice.reason.trim() };
}

const NOT_COMPENSATED_REASONS = ['自然老化', '送水时碰坏的', '顾客不肯赔'];

/** A yes/no question answered with two buttons; `value` null shows neither pressed. */
function Question({ label, value, yes, no, onChange }: { label: string; value: boolean | null; yes: string; no: string; onChange: (value: boolean) => void }) {
  return (
    <div className="handover-question">
      <b>{label}</b>
      <div className="seg-switch" role="group" aria-label={label}>
        <button type="button" aria-pressed={value === true} onClick={() => onChange(true)}>{yes}</button>
        <button type="button" aria-pressed={value === false} onClick={() => onChange(false)}>{no}</button>
      </div>
    </div>
  );
}

/**
 * A hand-over's deposit and damaged containers for one water product. The deposit part shows 手里 / 本次领 / 应付押金;
 * when some is due it asks 客户是否支付押金: 是 brings up 实付 at 应付 for staff to lower, 否 leaves it all owed. The
 * damage part asks whether any container is damaged, how many, whether the customer pays for it and, if not, why.
 */
export function HandoverDeposit({ id, type, position, fullOut, emptyIn, value, onChange, collected = 0, payMethod, title, depositReviewed = false, damageReviewed = false }: {
  /** Prefix for the field ids, unique in the page. */
  id: string;
  type: ContainerType;
  position: DepositPosition;
  fullOut: number;
  emptyIn: number;
  value: HandoverChoice;
  onChange: (choice: HandoverChoice) => void;
  /** Containers whose deposit this checkout already took on an earlier try: not asked again. */
  collected?: number;
  /** The payment method picker, shown while something is paid. */
  payMethod?: ReactNode;
  /** The water product, named when a checkout lists several. */
  title?: string;
  /** Deposits staff take wait for an admin to check the money arrived. */
  depositReviewed?: boolean;
  /** Damage the customer does not pay for waits for an admin's approval. */
  damageReviewed?: boolean;
}) {
  const unit = containerUnit(type);
  const { can } = useAuth();
  const due = depositGap(position, fullOut, emptyIn);
  const paid = collected ? 0 : paidOf(value, due);
  const owed = Math.max(0, due - paid);
  const set = (patch: Partial<HandoverChoice>) => onChange({ ...value, ...patch });
  return (
    <div className="handover">
      <div className={`deposit-handover${due ? ' owing' : ''}`}>
        {title && <h5>{title}</h5>}
        <DepositRows unit={unit} position={position} fullOut={fullOut} emptyIn={emptyIn} dueLabel="应付押金" />
        {due > 0 && (collected
          ? <small className="deposit-hint">本次已收押金 ¥{money(collected)}，还差的记欠押金。</small>
          : can(P.DepositCollect) && <Question label="客户是否支付押金？" value={value.pays} yes="是" no="否" onChange={pays => set({ pays, amount: undefined })} />)}
        {value.pays && !collected && due > 0 && (
          <div className="deposit-row">
            <span>
              <b>实付押金</b><small>默认收齐应付的，顾客给得少就往下调{depositReviewed ? '；收的押金要管理员核对到账后才入账' : ''}</small>
              <input className="input" type="number" aria-label="实收押金金额" min="0.01" step="0.01" inputMode="decimal"
                value={value.amount ?? money(due)} onChange={e => set({ amount: e.target.value })} />
            </span>
          </div>
        )}
        {paid > 0 && payMethod}
        {owed > 0 && (
          <div className="deposit-row owed">
            <span><b>欠押金</b><small>可继续交付，会员档案会显示差额</small></span>
            <strong>¥{money(owed)}</strong>
          </div>
        )}
      </div>
      <div className={`handover-damage${value.damaged ? ' active' : ''}`}>
        <Question label={`是否有损坏的${unit}？`} value={value.damaged} yes="有" no="没有" onChange={damaged => set({ damaged })} />
        {value.damaged && <>
          <div className="handover-question">
            <b>损坏了几个</b>
            <Stepper value={value.damagedQty} min={1} max={Math.max(1, position.held + fullOut)} showZero label={`${title ?? ''}损坏的${unit}个数`} onChange={n => set({ damagedQty: n })} />
          </div>
          <Question label="是否赔付？" value={value.compensated} yes="赔付" no="不赔付" onChange={compensated => set({ compensated })} />
          {value.compensated === false && <>
            <label htmlFor={`${id}-reason`}>不赔付的原因<em>必填</em></label>
            <input id={`${id}-reason`} className="input" maxLength={200} placeholder="写一句为什么不赔" value={value.reason} onChange={e => set({ reason: e.target.value })} />
            <div className="slot-chips reason-chips" role="group" aria-label="常用原因">
              {NOT_COMPENSATED_REASONS.map(r => <button key={r} type="button" className={value.reason.trim() === r ? 'active' : ''} aria-pressed={value.reason.trim() === r} onClick={() => set({ reason: r })}>{r}</button>)}
            </div>
            {damageReviewed && <small className="deposit-hint">不赔付要管理员在「审核」里批准；驳回就要去找顾客赔。</small>}
          </>}
        </>}
      </div>
    </div>
  );
}

/** Deposit a hand-over collects now for one water product. */
export interface DepositCollectItem { name: string; amount: number }

/** Shown after staff answer 还没收到: nothing was recorded, and how to go ahead when the customer paid less or nothing. */
export const DEPOSIT_NOT_RECEIVED = '押金没收到，没有交付，也没记押金。请把「实付押金」改为收到的金额；一点没给就在「客户是否支付押金」选「否」，记成欠押金再交付。';

/**
 * Asks whether the deposit is really in hand before a hand-over records it. A deposit recorded but never paid is still
 * refunded when the customer returns the container, so the station would pay out money it never took in.
 * `unpaid` is the part left as 欠押金, shown so staff see the whole picture. Resolves true only on 已收到.
 */
export function useConfirmDepositReceived() {
  const dialogs = useDialogs();
  return useCallback(async (payMethod: PayMethod, items: DepositCollectItem[], unpaid?: { amount: number; text: string }) =>
    await dialogs.open<boolean>(close => <DepositReceivedDialog payMethod={payMethod} items={items} unpaid={unpaid} onClose={close} />) === true, [dialogs]);
}

function DepositReceivedDialog({ payMethod, items, unpaid, onClose }: {
  payMethod: PayMethod;
  items: DepositCollectItem[];
  unpaid?: { amount: number; text: string };
  onClose: (received?: boolean) => void;
}) {
  const total = items.reduce((sum, o) => sum + o.amount, 0);
  const reviewed = waitsForReview(useReviewSettings(), 'deposit');
  // The first close wins: 已收到 resolves true before the form closes itself.
  return (
    <FormDialog title="押金真的收到了吗？" className="deposit-received-dialog" submitLabel={`已收到 ¥${money(total)}，交付`}
      onClose={() => onClose(false)} onSubmit={() => onClose(true)}
      extraActions={<button type="button" className="btn" onClick={() => onClose(false)}>还没收到</button>}>
      <div className="deposit-received">
        <span>要收押金</span>
        <strong>¥{money(total)}</strong>
        <em>{payMethodLabel(payMethod)}</em>
        {items.map(o => <small key={o.name}>{o.name} · 收押金 ¥{money(o.amount)}</small>)}
        {unpaid && <small className="deposit-received-unpaid">另有 ¥{money(unpaid.amount)}（{unpaid.text}）没收，记欠押金</small>}
      </div>
      <p className="deposit-received-note">
        <b>钱到手了再点「已收到」。</b>{payMethod === 'CASH' ? '现金请当面点清。' : `${payMethodLabel(payMethod)}请看到钱到账再确认。`}
        {reviewed ? '确认后先记为待审核，管理员核对到账、批准后才入账，' : '确认后系统记为已收押金，'}计入会员押金池。
      </p>
      <p className="membership-note">收到的和填的不一样就点「还没收到」，回去改「实付押金」，这次什么都不记。</p>
    </FormDialog>
  );
}

/**
 * The counter's 换回空桶 control, big enough to notice. It cannot exceed the empties the customer holds, and says how the
 * count compares with the full ones taken: every one short is one more deposit.
 */
function ReturnEmpties({ unit, taken, value, max, label, onChange }: {
  unit: string; taken: number; value: number; max: number; label: string; onChange: (value: number) => void;
}) {
  const compare = value < taken ? `比领走的少换 ${taken - value} 个，少换的要交押金` : value > taken ? `比领走的多换回 ${value - taken} 个` : `领走 ${taken} 个换回 ${value} 个`;
  return (
    <div className="return-empties">
      <span>
        <b>换回空{unit}</b>
        <small>{max ? `顾客手里 ${max} 个空${unit}；${compare}` : `顾客手里没有空${unit}可换，领走的都要交押金`}</small>
      </span>
      <Stepper value={value} max={max} showZero label={label} onChange={onChange} />
    </div>
  );
}

/**
 * Round takeout-style quantity control; the minus button and count appear once something is chosen.
 * With an `id` it is a form field: the count is always shown and can also be typed in.
 */
export function Stepper({ id, value, onChange, min = 0, max, label, showZero = false }: {
  id?: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  label: string;
  showZero?: boolean;
}) {
  const shown = showZero || id !== undefined || value > 0;
  const set = (n: number) => onChange(Math.min(max ?? Infinity, Math.max(min, Math.trunc(n) || 0)));
  return (
    <div className="stepper">
      {shown && <button type="button" className="stepper-minus" aria-label={`减少${label}`} disabled={value <= min} onClick={() => set(value - 1)}>−</button>}
      {shown && (id === undefined
        ? <span aria-label={label}>{value}</span>
        : <NumberInput id={id} className="stepper-input" inputMode="numeric" min={min} max={max} step={1} required value={value} onChange={set} />)}
      <button type="button" className="stepper-plus" aria-label={`增加${label}`} disabled={max !== undefined && value >= max} onClick={() => set(value + 1)}>+</button>
    </div>
  );
}

type Line = {
  product: WaterProduct; water: WaterType; qty: number; tickets: number; container: ContainerType; unit: string;
  /** The container position this line starts from, after the lines before it; undefined while it loads. */
  position?: DepositPosition;
  /** Empties the customer still has to swap for this line. */
  empties: number;
  /** Empties returned: counted by the counter at a hand-over, unknown (0) for an order handed over later. */
  emptyIn: number;
  /** 应付 (hand-over) or 需补 (order) for this line in containers and money, as if the lines before it were paid in full. */
  gap: number;
  choice: HandoverChoice;
  /** Containers whose deposit an earlier try of this checkout already took for this line. */
  collected: number;
  /** Containers whose deposit the customer pays now (实付) and leaves unpaid (欠押金, once staff answered), at a hand-over. */
  paid: number; owed: number;
};
/** An order placed in this checkout, with what of its hand-over still waits for an admin: the deposit taken, an unpaid damage. */
type Placed = CreateOrderResult & { name: string; handedOver: boolean; depositPending?: number; damagePending?: boolean };
type Progress = { key: string; order?: CreateOrderResult; deposit?: number; depositPending?: number };

/**
 * 点单：像点外卖一样选水品加入购物袋，再选配送或自提。会员自助和门店点单共用。
 * 每个水品生成一张水单；`counter` 时顾客在店，自提即当场交付、登记换回空桶，问客户是否支付押金（是就默认收齐应付，
 * 可往下调；否就记欠押金）和有没有损坏的桶袋。送水上门和凭码自提还不知道会收回几个空桶，需补押金 = 欠的 + 这次领的。
 */
export function OrderMenu({ member, products, counter = false, initialMode = 'DELIVERY', onRecharge, onPlaced, doneActions }: {
  member: MemberProfile;
  products: WaterProduct[];
  counter?: boolean;
  initialMode?: FulfillMode;
  onRecharge?: () => void;
  onPlaced?: (orders: CreateOrderResult[]) => void | Promise<void>;
  doneActions?: ReactNode;
}) {
  const { api, can } = useAuth();
  const deposits = useDepositPositions(member.id);
  const confirmDeposit = useConfirmDepositReceived();
  const review = useReviewSettings();
  const [mode, setMode] = useState(initialMode);
  const [cart, setCart] = useState<Partial<Record<WaterType, number>>>({});
  const [step, setStep] = useState<'menu' | 'checkout' | 'done'>('menu');
  const [addressId, setAddressId] = useState<string | null>(null);
  const [slot, setSlot] = useState(DELIVERY_SLOTS[0]);
  const [remark, setRemark] = useState('');
  const [returns, setReturns] = useState<Partial<Record<WaterType, number>>>({});
  // Per product at a hand-over: whether the customer paid the deposit (and how many), and any damaged containers.
  const [choices, setChoices] = useState<Partial<Record<WaterType, HandoverChoice>>>({});
  const [payMethod, setPayMethod] = useState<PayMethod>('WECHAT');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [placed, setPlaced] = useState<Placed[]>([]);
  // Per product within one checkout: the idempotency key and the steps already done, so a retry resumes instead of repeating.
  const progress = useRef(new Map<WaterType, Progress>());
  const top = useRef<HTMLDivElement>(null);
  useEffect(() => { top.current?.scrollIntoView({ block: 'nearest' }); }, [step]);

  const delivery = mode === 'DELIVERY';
  const handOver = counter && !delivery && can(P.OrderFulfill);
  const positions = deposits.data;
  let addedValue = 0;
  let paidSoFar = 0;
  const lines: Line[] = products.flatMap(product => {
    const water = product.waterType;
    const qty = cart[water] ?? 0;
    if (!qty) return [];
    const container = product.containerId;
    const start = positions?.[container];
    const position = start && { ...start, pool: { ...start.pool, required: start.pool.required + addedValue, available: start.pool.available + paidSoFar } };
    const empties = position?.held ?? 0;
    const emptyIn = handOver ? Math.min(empties, returns[water] ?? qty) : 0;
    const gap = position ? depositGap(position, qty, emptyIn) : 0;
    const choice = choices[water] ?? EMPTY_HANDOVER;
    const collected = progress.current.get(water)?.deposit ?? 0;
    const paid = handOver && !collected ? paidOf(choice, gap) : 0;
    const owed = Math.max(0, gap - paid);
    addedValue += (qty - emptyIn) * (position?.unitDeposit ?? 0);
    paidSoFar += paid;
    return [{ product, water, qty, tickets: ticketsFor(member, water, mode), container, unit: containerUnit(container),
      position, empties, emptyIn, gap, choice, collected, paid, owed }];
  });
  const count = lines.reduce((sum, l) => sum + l.qty, 0);
  const depositTotal = lines.at(-1)?.gap ?? 0;
  const paidTotal = paidSoFar;
  const owedTotal = lines.at(-1)?.owed ?? 0;
  const owing = owedTotal > 0;
  const minimumOf = (p: WaterProduct) => (delivery ? Math.max(1, p.deliveryMinimum) : 1);
  const short = lines.find(l => l.qty > l.tickets);
  const below = lines.find(l => l.qty < minimumOf(l.product));
  const started = [...progress.current.values()].some(p => p.order);

  const setQty = (p: WaterProduct, next: number) => {
    const current = cart[p.waterType] ?? 0;
    const min = minimumOf(p);
    // Delivery has a minimum per product: the first tap adds the minimum and dropping below it removes the item.
    const qty = next <= 0 ? 0 : next > current ? Math.max(next, min) : next < min ? 0 : next;
    setCart(c => ({ ...c, [p.waterType]: qty }));
    setError('');
  };

  let blocker = '';
  if (!count) blocker = '请先选择水品';
  else if (short) blocker = `${short.product.name}${modeLabel(mode)}票不足，剩 ${short.tickets} 张`;
  else if (below) blocker = `${below.product.name}${minimumOf(below.product)}${below.unit}起送，还差 ${minimumOf(below.product) - below.qty} ${below.unit}`;
  else if (step === 'checkout' && delivery && !addressId) blocker = '请选择收货地址';
  else if (!positions && !deposits.error) blocker = '正在核对押金…';
  else if (step === 'checkout' && handOver) blocker = lines.map(l => handoverProblem(l.choice, l.collected ? 0 : l.gap, l.unit)).find(Boolean) ?? '';

  const submit = async () => {
    if (busy || blocker) return;
    setBusy(true); setError('');
    // Ask before anything is created; a retry asks only about deposits this checkout has not taken yet.
    const collecting = lines.filter(l => l.paid > 0);

    if (collecting.length && !await confirmDeposit(payMethod,
      collecting.map(l => ({ name: l.product.name, amount: l.paid })),
      owedTotal > 0 ? { amount: owedTotal, text: "交付后差额" } : undefined)) {
      setBusy(false);
      setError(DEPOSIT_NOT_RECEIVED);
      return;
    }
    const done: Placed[] = [];
    try {
      for (const line of lines) {
        let p = progress.current.get(line.water);
        if (!p) { p = { key: crypto.randomUUID() }; progress.current.set(line.water, p); }
        p.order ??= await api.createOrder({
          memberId: member.id, waterType: line.water, fulfillMode: mode, orderQty: line.qty, idempotencyKey: p.key,
          addressId: delivery ? addressId : null, appointmentSlot: delivery ? slot : null, remark: remark.trim() || null,
        });
        let damagePending = false;
        if (handOver) {
          if (line.paid > 0 && !p.deposit) {
            const taken = await api.collectDeposit({ memberId: member.id, amount: line.paid, payMethod, idempotencyKey: `${p.key}:deposit` });
            p.deposit = line.paid;
            if (taken.status === 'PENDING') p.depositPending = taken.totalAmount;
          }
          const owe = line.owed;
          const note = composeHandoverNote(line.choice, { unit: line.unit, paid: p.deposit ?? 0, owed: owe });
          const result = await api.fulfillOrder(p.order.id, {
            actualQty: line.qty, fullOutN: line.qty, emptyInM: line.emptyIn, pickupCode: p.order.pickupCode ?? null,
            ...(note && { overrideReason: note }), ...damageFields(line.choice),
          });
          damagePending = result.damageReviewStatus === 'PENDING';
        }
        done.push({ ...p.order, name: line.product.name, handedOver: handOver, depositPending: p.depositPending, damagePending });
        progress.current.delete(line.water);
        setCart(c => ({ ...c, [line.water]: 0 }));
      }
      setPlaced(prev => [...prev, ...done]);
      setStep('done');
    } catch (e) {
      setPlaced(prev => [...prev, ...done]);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      if (done.length) await onPlaced?.(done);
      await deposits.reload();
    }
  };

  const again = () => { setPlaced([]); setReturns({}); setChoices({}); setRemark(''); setStep('menu'); };
  const clearCart = () => { setCart({}); setReturns({}); setChoices({}); setError(''); };

  if (step === 'done') return (
    <div className="order-menu" ref={top}>
      <div className="order-done">
        <span className="order-done-icon"><Icon name="check" size="lg" /></span>
        <h3>{placed.every(o => o.handedOver) ? '已交付，欢迎再来' : delivery ? '下单成功，等待送水' : '下单成功，请到店取水'}</h3>
        {placed.map(o => (
          <div key={o.id} className="order-done-line">
            <span><b>{o.name} × {o.orderQty}{unitOf(o.waterType)}</b><small>{o.orderNo}</small></span>
            {o.handedOver ? <em>已交付</em> : o.pickupCode ? <em className="code">取水码 {o.pickupCode}</em> : <em>待配送</em>}
            {(o.depositPending || o.damagePending) && <small className="order-done-review">
              {[o.depositPending && `押金 ¥${money(o.depositPending)} 等管理员核对到账`, o.damagePending && '损坏不赔付等管理员批准'].filter(Boolean).join('；')}
            </small>}
          </div>
        ))}
        {!placed.every(o => o.handedOver) && <p className="membership-note">{placed.some(o => !o.handedOver && o.fulfillMode === 'PICKUP') ? '到店出示取水码即可领取；' : ''}水单完成前可在“水单”中查看进度或取消。</p>}
        <div className="order-done-actions">
          <button type="button" className="btn" onClick={again}>再来一单</button>
          {doneActions}
        </div>
      </div>
    </div>
  );

  const cartBar = (
    <div className="cart-bar">
      <span className="cart-icon"><Icon name="box" />{count > 0 && <i>{count}</i>}</span>
      <span className="cart-text">
        <b>{count ? lines.map(l => `${l.product.name.replace(/（.*?）|\(.*?\)/g, '')} ${l.qty}${l.unit}`).join(' · ') : '还没有选水'}</b>
        <small>{blocker && blocker !== '正在核对押金…' ? blocker
          : handOver && owedTotal > 0 ? `实付押金 ¥${money(paidTotal)} · 欠押金 ¥${money(owedTotal)}`
          : depositTotal > 0 ? `${handOver ? '应付' : '需补'}押金 ¥${money(depositTotal)}` : `扣${modeLabel(mode)}水票，无需另付水费`}</small>
      </span>
      {step === 'menu' && count > 0 && <button type="button" className="cart-clear" aria-label="清空购物车" title="清空购物车" onClick={clearCart}><Icon name="trash" size="sm" />清空</button>}
      {step === 'menu'
        ? <button type="button" className="btn primary" disabled={!!blocker} onClick={() => setStep('checkout')}>选好了</button>
        : <button type="button" className="btn primary" disabled={!!blocker || busy} onClick={submit}>
          {busy ? '正在提交…' : handOver ? paidTotal > 0 ? '收押金并交付' : owing ? '记欠押金并交付' : '确认交付' : '提交订单'}
        </button>}
    </div>
  );

  if (step === 'checkout') return (
    <div className="order-menu" ref={top}>
      {!started && <button type="button" className="checkout-back" onClick={() => setStep('menu')}><Icon name="back" size="sm" />继续选水</button>}
      <section className="checkout-card">
        {delivery ? <>
          <h4><Icon name="truck" />送水上门</h4>
          <AddressPicker owner={member} value={addressId} onChange={setAddressId} />
          <div className="slot-chips" role="radiogroup" aria-label="期望送达时段">
            {DELIVERY_SLOTS.map(s => <button key={s} type="button" role="radio" aria-checked={slot === s} className={slot === s ? 'active' : ''} onClick={() => setSlot(s)}>{s}</button>)}
          </div>
        </> : handOver ? <>
          <h4><Icon name="store" />当场取水</h4>
          <p className="membership-note">顾客在店，提交后直接交付并登记换回的空桶空袋。</p>
        </> : <>
          <h4><Icon name="store" />到店自提</h4>
          <p className="checkout-store"><b>{KUNLUN_BRAND.store}</b><small>营业时间 08:00–20:00 · 下单后凭取水码领取</small></p>
        </>}
      </section>
      <section className="checkout-card">
        <h4><Icon name="drop" />水品</h4>
        {lines.map(l => (
          <div key={l.water} className="checkout-item">
            <div className="checkout-line">
              <span><b>{l.product.name} × {l.qty}{l.unit}</b><small>扣{modeLabel(mode)}票 {l.qty} 张，剩 {l.tickets - l.qty} 张</small></span>
            </div>
            {handOver && <ReturnEmpties unit={l.unit} taken={l.qty} value={l.emptyIn} max={l.empties} label={`${l.product.name}换回空${l.unit}`}
              onChange={v => setReturns(r => ({ ...r, [l.water]: v }))} />}
          </div>
        ))}
      </section>
      <section className="checkout-card">
        <h4><Icon name="deposit" />桶袋押金</h4>
        {deposits.error ? <p className="account-error" role="alert">{deposits.error}</p>
          : !positions ? <p className="membership-note">正在核对押金…</p>
          : lines.map(l => {
            if (!l.position) return null;
            const title = lines.length > 1 ? l.product.name : undefined;
            return handOver
              ? <HandoverDeposit key={l.water} id={`counter-${l.water}`} type={l.container} position={l.position} fullOut={l.qty} emptyIn={l.emptyIn}
                  depositReviewed={waitsForReview(review, 'deposit')} damageReviewed={waitsForReview(review, 'damage')}
                  value={l.choice} collected={l.collected} title={title} onChange={c => setChoices(s => ({ ...s, [l.water]: c }))}
                  payMethod={l === lines.find(x => x.paid > 0) && (
                    // One payment method for the whole checkout, shown under the first deposit paid.
                    <div className="slot-chips pay-chips" role="radiogroup" aria-label="押金收款方式">
                      {PAY_METHODS.map(p => <button key={p.value} type="button" role="radio" aria-checked={payMethod === p.value} className={payMethod === p.value ? 'active' : ''} onClick={() => setPayMethod(p.value)}>{p.label}</button>)}
                    </div>
                  )} />
              : <DepositEstimate key={l.water} type={l.container} position={l.position} qty={l.qty} title={title} />;
          })}
        {!handOver && depositTotal > 0 && <p className="membership-note">按实际交接数量核对押金，欠押金也可以下单。</p>}
      </section>
      <section className="checkout-card">
        <label htmlFor="orderRemark"><h4><Icon name="edit" />备注</h4></label>
        <input id="orderRemark" className="input" maxLength={200} placeholder={delivery ? '如：空桶放门口、到了先打电话' : '选填'} value={remark} onChange={e => setRemark(e.target.value)} />
      </section>
      {error && <p className="account-error" role="alert">{error}</p>}
      {started && <p className="membership-note">部分水单已创建，请重试完成；也可稍后在水单列表中处理。</p>}
      {cartBar}
    </div>
  );

  return (
    <div className="order-menu" ref={top}>
      <Holdings products={products} positions={positions} error={deposits.error} />
      <div className="mode-switch" role="tablist" aria-label="取水方式">
        {(['DELIVERY', 'PICKUP'] as const).map(m => (
          <button key={m} type="button" role="tab" aria-selected={mode === m} className={mode === m ? 'active' : ''} onClick={() => { setMode(m); setError(''); }}>
            <Icon name={m === 'DELIVERY' ? 'truck' : 'store'} />
            <span><b>{m === 'DELIVERY' ? '送水上门' : counter ? '到店取水' : '到店自提'}</b><small>{m === 'DELIVERY' ? '扣配送票 · 预约时段' : counter ? '扣自提票 · 当场换桶' : '扣自提票 · 凭码领取'}</small></span>
          </button>
        ))}
      </div>
      <div className="menu-list">
        {products.length === 0 && <p className="membership-note">正在加载水品…</p>}
        {products.map(p => {
          const tickets = ticketsFor(member, p.waterType, mode);
          const qty = cart[p.waterType] ?? 0;
          const unit = containerUnit(p.containerType);
          const position = positions?.[p.containerId];
          const soldOut = tickets < minimumOf(p);
          return (
            <article key={p.waterType} className={`menu-item${soldOut && !qty ? ' sold-out' : ''}`}>
              <span className={`menu-thumb${p.containerType === 'BAG' ? ' bag' : ''}`}><Icon name="drop" size="xl" /><small>{p.capacityLiters}L</small></span>
              <div className="menu-info">
                <b>{p.name}</b>
                <small>{p.packaging} · {delivery ? `${minimumOf(p)}${unit}起送 · ${p.deliveryFee ? `配送费 ¥${money(p.deliveryFee)}` : '免费配送'}` : '门店领取'}</small>
                {position && <small>押金 ¥{money(position.unitDeposit)}/个{position.held ? ` · 手里 ${position.held} 个空${unit}可换` : ''}</small>}
                <div className="menu-foot">
                  <span className="menu-tickets"><b>{tickets}</b>张{modeLabel(mode)}{unit}票</span>
                  {soldOut && !qty
                    ? onRecharge ? <button type="button" className="btn sm" onClick={onRecharge}>去充值</button> : <em>水票不足</em>
                    : <Stepper value={qty} max={tickets} label={p.name} onChange={v => setQty(p, v)} />}
                </div>
              </div>
            </article>
          );
        })}
      </div>
      {onRecharge && !lines.length && products.some(p => ticketsFor(member, p.waterType, mode) < minimumOf(p)) && <p className="membership-note">水票不足时可先充值再点单。</p>}
      {error && <p className="account-error" role="alert">{error}</p>}
      {cartBar}
    </div>
  );
}

/** 门店点单：先找到顾客，再用同一份点单菜单为其下单。员工 H5 和管理端共用。 */
export function CounterOrder({ products, memberId, onMemberChange, onRecharge, onNewMember, onPlaced }: {
  products: WaterProduct[];
  memberId?: string;
  onMemberChange: (memberId: string | undefined) => void;
  onRecharge?: (member: MemberProfile) => Promise<unknown>;
  onNewMember?: () => Promise<string | undefined>;
  onPlaced?: () => void | Promise<void>;
}) {
  const api = useApi();
  const member = useLoader(() => memberId ? api.memberProfile(memberId) : Promise.resolve(null), [api, memberId]);
  if (!memberId) return <CustomerSearch onPick={onMemberChange} onNewMember={onNewMember} />;
  if (member.error) return <p className="account-error" role="alert">{member.error}</p>;
  const m = member.data;
  if (!m || m.id !== memberId) return <p className="membership-note">正在读取顾客信息…</p>;
  return (
    <div className="counter-order">
      <div className="counter-customer">
        <span className="counter-avatar">{m.name[0]}</span>
        <span><b>{m.name}</b><small>{m.phone} · {m.memberNo}</small></span>
        <button type="button" className="btn sm" onClick={() => onMemberChange(undefined)}>换顾客</button>
      </div>
      <OrderMenu key={m.id} member={m} products={products} counter initialMode="PICKUP"
        onRecharge={onRecharge && (async () => { await onRecharge(m); await member.reload(); })}
        onPlaced={async () => { await member.reload(); await onPlaced?.(); }} />
    </div>
  );
}

function CustomerSearch({ onPick, onNewMember }: { onPick: (memberId: string) => void; onNewMember?: () => Promise<string | undefined> }) {
  const api = useApi();
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => { const t = window.setTimeout(() => setDebounced(query.trim()), 200); return () => window.clearTimeout(t); }, [query]);
  const members = useLoader(() => api.listMembers(debounced), [api, debounced]);
  const run = useRun();
  const create = run(async () => { const id = await onNewMember?.(); if (id) onPick(id); });
  return (
    <div className="counter-search">
      <label className="counter-search-box"><Icon name="search" />
        <input autoFocus inputMode="search" placeholder="顾客手机号、姓名或会员号" aria-label="查找顾客" value={query} onChange={e => setQuery(e.target.value)} />
      </label>
      {members.error ? <p className="account-error" role="alert">{members.error}</p>
        : !members.data ? <p className="membership-note">正在查找…</p>
        : members.data.length === 0 ? <p className="membership-note">没有找到顾客{onNewMember ? '，可新建会员后点单' : ''}</p>
        : members.data.slice(0, 8).map(m => (
          <button key={m.id} type="button" className="counter-customer pick" onClick={() => onPick(m.id)}>
            <span className="counter-avatar">{m.name[0]}</span>
            <span><b>{m.name}</b><small>{m.phone} · {ticketSummary(m.tickets)}</small></span>
            <Icon name="chevron" />
          </button>
        ))}
      {onNewMember && <button type="button" className="btn sm" onClick={create}><Icon name="plus" size="sm" />新建会员</button>}
    </div>
  );
}
