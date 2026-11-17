import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  KUNLUN_BRAND, KUNLUN_PERMISSIONS as P, PAY_METHODS, calcDepositGap, containerKind, containerUnit, modeLabel, money, payMethodLabel, ticketSummary, ticketsFor, unitOf,
  type ContainerType, type CreateOrderResult, type FulfillMode, type MemberProfile, type PayMethod, type WaterProduct, type WaterType,
} from '@kunlun/shared';
import { AddressPicker } from './addresses';
import { useApi, useAuth } from './auth';
import { FormDialog, NumberInput, useDialogs, useRun } from './feedback';
import { useLoader } from './hooks';
import { Icon } from './icons';

export const DELIVERY_SLOTS = ['尽快送达（约 45 分钟内）', '今天 14:00–16:00', '今天 16:00–18:00'];

export interface DepositPosition {
  held: number;
  /** Containers the paid deposit covers: paid and not refunded, minus those awaiting a scrap decision. */
  covered: number;
  unitDeposit: number;
  /** Deposit paid and not yet refunded, containers awaiting a scrap decision included. */
  paidQty: number;
  paidAmount: number;
  pendingDamageQty: number;
  /** Paid deposit the member could take back now: containers not held and not awaiting a scrap decision. */
  refundableQty: number;
  refundableAmount: number;
}

/** A member's held containers, deposit coverage (paid minus pending damage) and the current unit deposit, per container type. */
export function useDepositPositions(memberId: string | undefined) {
  const api = useApi();
  return useLoader(async () => {
    if (!memberId) return null;
    const [rows, configs] = await Promise.all([api.depositSummary(memberId), api.containerSummary()]);
    return Object.fromEntries(rows.map(row => [row.containerType, {
      held: row.heldQty, covered: row.paidQty - row.pendingDamageQty,
      unitDeposit: configs.find(c => c.containerType === row.containerType)?.unitDeposit ?? 0,
      paidQty: row.paidQty, paidAmount: Number(row.paidAmount), pendingDamageQty: row.pendingDamageQty,
      refundableQty: row.refundableQty, refundableAmount: Number(row.refundableAmount),
    } satisfies DepositPosition])) as Record<ContainerType, DepositPosition>;
  }, [api, memberId]);
}

/**
 * What the member holds and has paid as deposit, one tile per container: the first thing the counter checks before a
 * full-for-empty swap, and what a deposit refund would start from.
 */
function Holdings({ products, positions, error }: { products: WaterProduct[]; positions: Record<ContainerType, DepositPosition> | null; error: string }) {
  const containers = [...new Map(products.map(p => [p.containerId, p])).values()];
  if (!containers.length) return null;
  return (
    <section className="holdings" aria-label="手里的桶袋和已交押金">
      {error ? <p className="account-error" role="alert">{error}</p>
        : !positions ? <p className="membership-note">正在核对手里的桶袋和押金…</p>
        : containers.map(p => {
          const position = positions[p.containerId];
          if (!position) return null;
          const unit = containerUnit(p.containerId);
          const owing = Math.max(0, position.held - Math.max(0, position.covered));
          const [tone, status] = owing > 0 ? ['gold', `欠押金 ${owing} 个 ¥${money(owing * position.unitDeposit)}`]
            : position.refundableQty > 0 ? ['blue', `可退 ${position.refundableQty} 个 ¥${money(position.refundableAmount)}`]
            : position.held > 0 ? ['green', '押金够'] : ['', ''];
          return (
            <div key={p.containerId} className={`holding${containerKind(p.containerId) === 'BAG' ? ' bag' : ''}${owing ? ' owing' : ''}`}>
              <div className="holding-head"><span>{p.name}</span>{status && <span className={`tag ${tone}`}>{status}</span>}</div>
              <div className="holding-held">手里 <b>{position.held}</b> 个{unit}</div>
              <div className="holding-deposit">已交押金 <b>¥{money(position.paidAmount)}</b>{position.paidQty > 0 && <small> · {position.paidQty} 个</small>}</div>
              {position.pendingDamageQty > 0 && <small>其中 {position.pendingDamageQty} 个{unit}待报废审核</small>}
            </div>
          );
        })}
    </section>
  );
}

/** One container type's deposit outcome for a hand-over of `fullOut` full and `emptyIn` returned empties. */
export function DepositDue({ type, position, fullOut, emptyIn, children }: {
  type: ContainerType;
  position: DepositPosition;
  fullOut: number;
  emptyIn: number;
  children?: ReactNode;
}) {
  const gap = calcDepositGap(position.covered, position.held, fullOut, emptyIn);
  const unit = containerUnit(type);
  return (
    <div className={`deposit-due${gap ? ' owing' : ''}`}>
      <div>
        <b>{gap ? `需补押金 ¥${money(gap * position.unitDeposit)}` : `${unit}押金已覆盖`}</b>
        <small>{gap ? `新增占用 ${gap} 个${unit} × ¥${money(position.unitDeposit)}，` : ''}按换回 {emptyIn} 个空{unit}计算（现持有 {position.held} 个，押金覆盖 {Math.max(0, position.covered)} 个）</small>
      </div>
      {gap > 0 && children}
    </div>
  );
}

/** Deposit a hand-over collects now for one water product. */
export interface DepositCollectItem { name: string; type: ContainerType; qty: number; unitDeposit: number }

/** Shown after staff answer 还没收到: nothing was recorded, and how to go ahead when the customer paid less or nothing. */
export const DEPOSIT_NOT_RECEIVED = '押金没收到，没有交付，也没记押金。顾客实际给了几个的押金，就把「实付押金」改成几个；没给的记欠押金，写清备注再交付。';

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
  const total = items.reduce((sum, o) => sum + o.qty * o.unitDeposit, 0);
  const units = [...new Set(items.map(o => containerUnit(o.type)))].join('');
  // The first close wins: 已收到 resolves true before the form closes itself.
  return (
    <FormDialog title="押金真的收到了吗？" className="deposit-received-dialog" submitLabel={`已收到 ¥${money(total)}，交付`}
      onClose={() => onClose(false)} onSubmit={() => onClose(true)}
      extraActions={<button type="button" className="btn" onClick={() => onClose(false)}>还没收到</button>}>
      <div className="deposit-received">
        <span>要收押金</span>
        <strong>¥{money(total)}</strong>
        <em>{payMethodLabel(payMethod)}</em>
        {items.map(o => <small key={`${o.name}-${o.type}`}>{o.name}：收 {o.qty} 个{containerUnit(o.type)} × ¥{money(o.unitDeposit)}</small>)}
        {unpaid && <small className="deposit-received-unpaid">另有 ¥{money(unpaid.amount)}（{unpaid.text}）没收，记欠押金</small>}
      </div>
      <p className="deposit-received-note">
        <b>钱到手了再点「已收到」。</b>{payMethod === 'CASH' ? '现金请当面点清。' : `${payMethodLabel(payMethod)}请看到钱到账再确认。`}
        确认后系统记为已收押金，顾客以后退{units}时要按这笔退钱。
      </p>
      <p className="membership-note">收到的和填的不一样就点「还没收到」，回去改「实付押金」，这次什么都不记。</p>
    </FormDialog>
  );
}

/**
 * 应付、实付、欠押金 for one water product at a hand-over. 应付 is what the hand-over leaves without a deposit, earlier
 * debt included; staff set 实付 to what the customer actually handed over and the rest is recorded as 欠押金.
 */
export function DepositSettle({ type, position, fullOut, emptyIn, paid, onPaidChange, title, children }: {
  type: ContainerType;
  position: DepositPosition;
  fullOut: number;
  emptyIn: number;
  /** Containers whose deposit is collected now, 0 to 应付. */
  paid: number;
  onPaidChange: (paid: number) => void;
  /** The water product, named when a checkout lists several. */
  title?: string;
  /** The payment method picker, shown while something is collected. */
  children?: ReactNode;
}) {
  const gap = calcDepositGap(position.covered, position.held, fullOut, emptyIn);
  const unit = containerUnit(type);
  const price = position.unitDeposit;
  const covered = Math.max(0, position.covered);
  const basis = `按换回 ${emptyIn} 个空${unit}计算（现持有 ${position.held} 个，押金覆盖 ${covered} 个）`;
  if (!gap) return <div className="deposit-due"><div><b>{title ? `${title}：` : ''}{unit}押金已覆盖</b><small>{basis}</small></div></div>;
  const earlier = Math.min(gap, Math.max(0, position.held - covered));
  const owed = gap - paid;
  return (
    <div className={`deposit-settle${owed ? ' owing' : ''}`}>
      {title && <h5>{title}</h5>}
      <div className="deposit-settle-row">
        <span><b>应付押金</b><small>{earlier ? `共 ${gap} 个${unit}，含之前欠的 ${earlier} 个` : `新增占用 ${gap} 个${unit}`} × ¥{money(price)}</small></span>
        <strong>¥{money(gap * price)}</strong>
      </div>
      <div className="deposit-settle-row">
        <span>
          <b>实付押金</b><small>顾客实际给了几个{unit}的押金</small>
          <Stepper value={paid} max={gap} showZero label={`${title ?? ''}实付押金个数`} onChange={onPaidChange} />
        </span>
        <strong>¥{money(paid * price)}</strong>
      </div>
      <div className="deposit-settle-row owed">
        <span><b>欠押金</b><small>{owed ? `${owed} 个${unit}没交，记在会员名下，下次交付并进应付` : '已收齐'}</small></span>
        <strong>¥{money(owed * price)}</strong>
      </div>
      <small className="deposit-settle-basis">{basis}</small>
      {paid > 0 && children}
    </div>
  );
}

/** What staff record when a customer leaves deposit unpaid: whether containers were scrapped, and why it was not paid. */
export interface OwedNote { scrap: 'none' | 'some' | null; scrapQty: number; fee: 'paid' | 'unpaid' | null; text: string }
export const EMPTY_OWED_NOTE: OwedNote = { scrap: null, scrapQty: 1, fee: null, text: '' };

/** What the note still lacks, or '' when it is complete. */
export function owedNoteProblem(note: OwedNote) {
  if (!note.scrap) return '欠押金要写备注：先选有没有报废';
  if (note.scrap === 'some' && !note.fee) return '欠押金要写备注：选报废费用给没给';
  if (!note.text.trim()) return '欠押金要写备注：写一句为什么没交押金';
  return '';
}

/** The note saved with the order, e.g. 欠押金 2 个桶 ¥60.00；报废 1 个桶，报废费用没给；说明：顾客说下次带钱来. */
export function composeOwedNote(note: OwedNote, owed: string, unit: string) {
  const scrap = note.scrap === 'some' ? `报废 ${note.scrapQty} 个${unit}，报废费用${note.fee === 'paid' ? '给了' : '没给'}` : '没有报废';
  return `欠押金 ${owed}；${scrap}；说明：${note.text.trim()}`;
}

/** The required note under 欠押金: scrapped or not, how many, whether the scrap fee was paid, and why no deposit. */
export function OwedNoteFields({ id, value, onChange, unit }: { id: string; value: OwedNote; onChange: (note: OwedNote) => void; unit: string }) {
  const set = (patch: Partial<OwedNote>) => onChange({ ...value, ...patch });
  return (
    <section className="owed-note" aria-label="欠押金备注">
      <h5>欠押金备注<em>必填</em></h5>
      <div className="seg-switch" role="group" aria-label="有没有报废">
        <button type="button" aria-pressed={value.scrap === 'none'} onClick={() => set({ scrap: 'none' })}>没有报废</button>
        <button type="button" aria-pressed={value.scrap === 'some'} onClick={() => set({ scrap: 'some' })}>有报废</button>
      </div>
      {value.scrap === 'some' && <>
        <div className="owed-note-scrap">
          <span>报废了</span>
          <Stepper value={value.scrapQty} min={1} max={999} showZero label="报废个数" onChange={n => set({ scrapQty: n })} />
          <span>个{unit}</span>
        </div>
        <div className="seg-switch" role="group" aria-label="报废费用">
          <button type="button" aria-pressed={value.fee === 'paid'} onClick={() => set({ fee: 'paid' })}>报废费用给了</button>
          <button type="button" aria-pressed={value.fee === 'unpaid'} onClick={() => set({ fee: 'unpaid' })}>报废费用没给</button>
        </div>
      </>}
      <label htmlFor={id}>为什么没交押金</label>
      <input id={id} className="input" maxLength={300} placeholder="如：顾客说下次带钱来" value={value.text} onChange={e => set({ text: e.target.value })} />
    </section>
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
  empties: number; emptyIn: number;
  /** 应付 for this line in containers and money, as if the lines before it were paid in full. */
  gap: number; deposit: number;
  /** Containers whose deposit the customer pays now (实付) and leaves unpaid (欠押金), at a hand-over. */
  paid: number; owed: number;
  /** Containers the member holds without a deposit once this line is handed over, debts earlier in the checkout included. */
  uncoveredAfter: number;
};
type Placed = CreateOrderResult & { name: string; handedOver: boolean };
type Progress = { key: string; order?: CreateOrderResult; deposit?: boolean };

/**
 * 点单：像点外卖一样选水品加入购物袋，再选配送或自提。会员自助和门店点单共用。
 * 每个水品生成一张水单；`counter` 时顾客在店，自提即当场交付、登记换回空桶并收取需补押金：
 * 实付默认等于应付，顾客没给够就往下调，差额记成欠押金并必须写备注。
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
  const [mode, setMode] = useState(initialMode);
  const [cart, setCart] = useState<Partial<Record<WaterType, number>>>({});
  const [step, setStep] = useState<'menu' | 'checkout' | 'done'>('menu');
  const [addressId, setAddressId] = useState<string | null>(null);
  const [slot, setSlot] = useState(DELIVERY_SLOTS[0]);
  const [remark, setRemark] = useState('');
  const [returns, setReturns] = useState<Partial<Record<WaterType, number>>>({});
  // Containers per product the customer did not pay a deposit for; 实付 follows 应付 until staff lower it.
  const [unpaid, setUnpaid] = useState<Partial<Record<WaterType, number>>>({});
  const [owedNote, setOwedNote] = useState<OwedNote>(EMPTY_OWED_NOTE);
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
  // Each water has its own container balance. Empty returns and deposit coverage never cross water products.
  // `covered` counts only deposits actually collected, so a line's uncovered count includes debts left by earlier lines.
  const running = new Map<ContainerType, { position: DepositPosition; empties: number; covered: number }>();
  const lines: Line[] = products.flatMap(product => {
    const water = product.waterType;
    const qty = cart[water] ?? 0;
    if (!qty) return [];
    const container = product.containerId;
    const start = positions?.[container];
    const { position, empties, covered } = running.get(container) ?? { position: start, empties: start?.held ?? 0, covered: start?.covered ?? 0 };
    // Water is swapped full-for-empty: assume every empty the customer holds comes back unless the counter records otherwise.
    const emptyIn = Math.min(empties, handOver ? returns[water] ?? qty : qty);
    const gap = position ? calcDepositGap(position.covered, position.held, qty, emptyIn) : 0;
    // A deposit already taken in this checkout is in the reloaded coverage; nothing more is collected for that line.
    const paid = handOver && !progress.current.get(water)?.deposit ? gap - Math.min(unpaid[water] ?? 0, gap) : 0;
    const heldAfter = (position?.held ?? 0) + qty - emptyIn;
    if (position) running.set(container, { position: { ...position, held: heldAfter, covered: position.covered + gap }, empties: empties - emptyIn, covered: covered + paid });
    return [{
      product, water, qty, tickets: ticketsFor(member, water, mode), container, unit: containerUnit(container), position, empties, emptyIn,
      gap, deposit: gap * (position?.unitDeposit ?? 0), paid, owed: handOver ? gap - paid : 0,
      uncoveredAfter: handOver && position ? Math.max(0, heldAfter - covered - paid) : 0,
    }];
  });
  const count = lines.reduce((sum, l) => sum + l.qty, 0);
  // 桶, 袋 or 桶/袋: the containers this cart actually hands over, so deposit notes name the right one.
  const units = [...new Set(lines.map(l => l.unit))].join('/') || '桶';
  const depositTotal = lines.reduce((sum, l) => sum + l.deposit, 0);
  const priceOf = (l: Line) => l.position?.unitDeposit ?? 0;
  const paidTotal = lines.reduce((sum, l) => sum + l.paid * priceOf(l), 0);
  const owedLines = lines.filter(l => l.owed > 0);
  const owedTotal = owedLines.reduce((sum, l) => sum + l.owed * priceOf(l), 0);
  const owedUnit = [...new Set(owedLines.map(l => l.unit))].join('');
  // Earlier debt with nothing new owed still leaves the member short; the hand-over then records it again with a note.
  const owing = lines.some(l => l.uncoveredAfter > 0);
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
  else if (step === 'checkout' && handOver && depositTotal > 0 && !can(P.DepositCollect)) blocker = '需补押金，当前账号没有收押金权限';
  else if (!positions && !deposits.error) blocker = '正在核对押金…';
  else if (step === 'checkout' && owing) blocker = owedNoteProblem(owedNote);

  const submit = async () => {
    if (busy || blocker) return;
    setBusy(true); setError('');
    // Ask before anything is created; a retry asks only about deposits this checkout has not taken yet.
    const collecting = lines.filter(l => l.paid > 0);
    const unpaidText = owedLines.map(l => `${l.owed} 个${l.unit}`).join('、');
    if (collecting.length && !await confirmDeposit(payMethod,
      collecting.map(l => ({ name: l.product.name, type: l.container, qty: l.paid, unitDeposit: priceOf(l) })),
      owedTotal > 0 ? { amount: owedTotal, text: unpaidText } : undefined)) {
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
        if (handOver) {
          if (line.paid > 0 && !p.deposit) {
            await api.collectDeposit({ memberId: member.id, containerType: line.container, quantity: line.paid, payMethod, idempotencyKey: `${p.key}:deposit:${line.paid}:${payMethod}` });
            p.deposit = true;
          }
          const owe = line.uncoveredAfter;
          await api.fulfillOrder(p.order.id, {
            actualQty: line.qty, fullOutN: line.qty, emptyInM: line.emptyIn, pickupCode: p.order.pickupCode ?? null,
            ...(owe > 0 && { forceCreditOverride: true, overrideReason: composeOwedNote(owedNote, `${owe} 个${line.unit} ¥${money(owe * priceOf(line))}`, line.unit) }),
          });
        }
        done.push({ ...p.order, name: line.product.name, handedOver: handOver });
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

  const again = () => { setPlaced([]); setReturns({}); setUnpaid({}); setOwedNote(EMPTY_OWED_NOTE); setRemark(''); setStep('menu'); };
  const clearCart = () => { setCart({}); setReturns({}); setUnpaid({}); setOwedNote(EMPTY_OWED_NOTE); setError(''); };

  if (step === 'done') return (
    <div className="order-menu" ref={top}>
      <div className="order-done">
        <span className="order-done-icon"><Icon name="check" size="lg" /></span>
        <h3>{placed.every(o => o.handedOver) ? '已交付，欢迎再来' : delivery ? '下单成功，等待送水' : '下单成功，请到店取水'}</h3>
        {placed.map(o => (
          <div key={o.id} className="order-done-line">
            <span><b>{o.name} × {o.orderQty}{unitOf(o.waterType)}</b><small>{o.orderNo}</small></span>
            {o.handedOver ? <em>已交付</em> : o.pickupCode ? <em className="code">取水码 {o.pickupCode}</em> : <em>待配送</em>}
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
          : lines.map(l => l.position && (handOver
            ? <DepositSettle key={l.water} type={l.container} position={l.position} fullOut={l.qty} emptyIn={l.emptyIn} paid={l.paid}
                title={lines.length > 1 ? l.product.name : undefined} onPaidChange={v => setUnpaid(u => ({ ...u, [l.water]: l.gap - v }))} />
            : <DepositDue key={l.water} type={l.container} position={l.position} fullOut={l.qty} emptyIn={l.emptyIn} />))}
        {handOver && paidTotal > 0 && (
          <div className="slot-chips" role="radiogroup" aria-label="押金收款方式">
            {PAY_METHODS.map(p => <button key={p.value} type="button" role="radio" aria-checked={payMethod === p.value} className={payMethod === p.value ? 'active' : ''} onClick={() => setPayMethod(p.value)}>{p.label}</button>)}
          </div>
        )}
        {handOver && owing && <OwedNoteFields id="counterOwedNote" value={owedNote} onChange={setOwedNote} unit={owedUnit || lines.find(l => l.uncoveredAfter)?.unit || '桶'} />}
        {!handOver && depositTotal > 0 && <p className="membership-note">押金{delivery ? '送达时交给送水员' : '取水时在门店支付'}；多换回空{units}可少交，还回{units}后可退押金。</p>}
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
