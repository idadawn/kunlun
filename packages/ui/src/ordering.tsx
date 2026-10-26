import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  KUNLUN_BRAND, KUNLUN_PERMISSIONS as P, PAY_METHODS, calcDepositGap, containerOf, modeLabel, money, ticketsFor, unitOf,
  type ContainerType, type CreateOrderResult, type FulfillMode, type MemberProfile, type PayMethod, type WaterProduct, type WaterType,
} from '@kunlun/shared';
import { AddressPicker } from './addresses';
import { useApi, useAuth } from './auth';
import { useRun } from './feedback';
import { useLoader } from './hooks';
import { Icon } from './icons';

export const DELIVERY_SLOTS = ['尽快送达（约 45 分钟内）', '今天 14:00–16:00', '今天 16:00–18:00'];

export interface DepositPosition { held: number; covered: number; unitDeposit: number }

/** A member's held containers, deposit coverage (paid minus pending damage) and the current unit deposit, per container type. */
export function useDepositPositions(memberId: string | undefined) {
  const api = useApi();
  return useLoader(async () => {
    if (!memberId) return null;
    const [rows, configs] = await Promise.all([api.depositSummary(memberId), api.containerSummary()]);
    const position = (type: ContainerType): DepositPosition => {
      const row = rows.find(r => r.containerType === type);
      return { held: row?.heldQty ?? 0, covered: (row?.paidQty ?? 0) - (row?.pendingDamageQty ?? 0), unitDeposit: configs.find(c => c.containerType === type)?.unitDeposit ?? 0 };
    };
    return { BUCKET: position('BUCKET'), BAG: position('BAG') } as Record<ContainerType, DepositPosition>;
  }, [api, memberId]);
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
  const unit = type === 'BUCKET' ? '桶' : '袋';
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

/** Round takeout-style quantity control; the minus button and count appear once something is chosen. */
export function Stepper({ value, onChange, max, label, showZero = false }: {
  value: number;
  onChange: (value: number) => void;
  max?: number;
  label: string;
  showZero?: boolean;
}) {
  const shown = showZero || value > 0;
  return (
    <div className="stepper">
      {shown && <button type="button" className="stepper-minus" aria-label={`减少${label}`} disabled={value <= 0} onClick={() => onChange(value - 1)}>−</button>}
      {shown && <span aria-label={label}>{value}</span>}
      <button type="button" className="stepper-plus" aria-label={`增加${label}`} disabled={max !== undefined && value >= max} onClick={() => onChange(value + 1)}>+</button>
    </div>
  );
}

type Line = { product: WaterProduct; water: WaterType; qty: number; tickets: number; container: ContainerType; held: number; emptyIn: number; gap: number; deposit: number };
type Placed = CreateOrderResult & { name: string; handedOver: boolean };
type Progress = { key: string; order?: CreateOrderResult; deposit?: boolean };

/**
 * 点单：像点外卖一样选水品加入购物袋，再选配送或自提。会员自助和门店点单共用。
 * 每个水品生成一张水单；`counter` 时顾客在店，自提即当场交付、登记换回空桶并收取需补押金。
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
  const [mode, setMode] = useState(initialMode);
  const [cart, setCart] = useState<Partial<Record<WaterType, number>>>({});
  const [step, setStep] = useState<'menu' | 'checkout' | 'done'>('menu');
  const [addressId, setAddressId] = useState<string | null>(null);
  const [slot, setSlot] = useState(DELIVERY_SLOTS[0]);
  const [remark, setRemark] = useState('');
  const [returns, setReturns] = useState<Partial<Record<ContainerType, number>>>({});
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
  const lines: Line[] = products.flatMap(product => {
    const water = product.waterType;
    const qty = cart[water] ?? 0;
    if (!qty) return [];
    const container = containerOf(water);
    const position = positions?.[container];
    const held = position?.held ?? 0;
    // Water is swapped full-for-empty: assume every empty the customer holds comes back unless the counter records otherwise.
    const emptyIn = Math.min(held, handOver ? returns[container] ?? qty : qty);
    const gap = position ? calcDepositGap(position.covered, held, qty, emptyIn) : 0;
    return [{ product, water, qty, tickets: ticketsFor(member, water, mode), container, held, emptyIn, gap, deposit: gap * (position?.unitDeposit ?? 0) }];
  });
  const count = lines.reduce((sum, l) => sum + l.qty, 0);
  const depositTotal = lines.reduce((sum, l) => sum + l.deposit, 0);
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
  else if (short) blocker = `${modeLabel(mode)}${unitOf(short.water)}票不足，剩 ${short.tickets} 张`;
  else if (below) blocker = `${below.product.name}${minimumOf(below.product)}${unitOf(below.water)}起送，还差 ${minimumOf(below.product) - below.qty} ${unitOf(below.water)}`;
  else if (step === 'checkout' && delivery && !addressId) blocker = '请选择收货地址';
  else if (step === 'checkout' && handOver && depositTotal > 0 && !can(P.DepositCollect)) blocker = '需补押金，当前账号没有收押金权限';
  else if (!positions && !deposits.error) blocker = '正在核对押金…';

  const submit = async () => {
    if (busy || blocker) return;
    setBusy(true); setError('');
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
          if (line.gap > 0 && !p.deposit) {
            await api.collectDeposit({ memberId: member.id, containerType: line.container, quantity: line.gap, payMethod, idempotencyKey: `${p.key}:deposit` });
            p.deposit = true;
          }
          await api.fulfillOrder(p.order.id, { actualQty: line.qty, fullOutN: line.qty, emptyInM: line.emptyIn, pickupCode: p.order.pickupCode ?? null });
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

  const again = () => { setPlaced([]); setReturns({}); setRemark(''); setStep('menu'); };

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
        <b>{count ? lines.map(l => `${l.product.name.replace(/（.*?）|\(.*?\)/g, '')} ${l.qty}${unitOf(l.water)}`).join(' · ') : '还没有选水'}</b>
        <small>{blocker && blocker !== '正在核对押金…' ? blocker : depositTotal > 0 ? `需补押金 ¥${money(depositTotal)}` : `扣${modeLabel(mode)}水票，无需另付水费`}</small>
      </span>
      {step === 'menu'
        ? <button type="button" className="btn primary" disabled={!!blocker} onClick={() => setStep('checkout')}>选好了</button>
        : <button type="button" className="btn primary" disabled={!!blocker || busy} onClick={submit}>
          {busy ? '正在提交…' : handOver ? depositTotal > 0 ? `收押金并交付` : '确认交付' : '提交订单'}
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
          <div key={l.water} className="checkout-line">
            <span><b>{l.product.name} × {l.qty}{unitOf(l.water)}</b><small>扣{modeLabel(mode)}{unitOf(l.water)}票 {l.qty} 张，剩 {l.tickets - l.qty} 张</small></span>
            {handOver && (
              <span className="checkout-return">
                <small>换回空{unitOf(l.water)}</small>
                <Stepper value={l.emptyIn} max={l.held} showZero label={`换回空${unitOf(l.water)}`} onChange={v => setReturns(r => ({ ...r, [l.container]: v }))} />
              </span>
            )}
          </div>
        ))}
      </section>
      <section className="checkout-card">
        <h4><Icon name="deposit" />桶袋押金</h4>
        {deposits.error ? <p className="account-error" role="alert">{deposits.error}</p>
          : !positions ? <p className="membership-note">正在核对押金…</p>
          : lines.map(l => <DepositDue key={l.water} type={l.container} position={positions[l.container]} fullOut={l.qty} emptyIn={l.emptyIn} />)}
        {depositTotal > 0 && (handOver ? (
          <div className="slot-chips" role="radiogroup" aria-label="押金收款方式">
            {PAY_METHODS.map(p => <button key={p.value} type="button" role="radio" aria-checked={payMethod === p.value} className={payMethod === p.value ? 'active' : ''} onClick={() => setPayMethod(p.value)}>{p.label}</button>)}
          </div>
        ) : <p className="membership-note">押金{delivery ? '送达时交给送水员' : '取水时在门店支付'}；多换回空桶可少交，退桶后可退押金。</p>)}
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
          const unit = unitOf(p.waterType);
          const position = positions?.[containerOf(p.waterType)];
          const soldOut = tickets < minimumOf(p);
          return (
            <article key={p.waterType} className={`menu-item${soldOut && !qty ? ' sold-out' : ''}`}>
              <span className={`menu-thumb${p.waterType === 'BAG_7_5L' ? ' bag' : ''}`}><Icon name="drop" size="xl" /><small>{p.capacityLiters}L</small></span>
              <div className="menu-info">
                <b>{p.name}</b>
                <small>{p.packaging} · {delivery ? `${minimumOf(p)}${unit}起送 · ${p.deliveryFee ? `配送费 ¥${money(p.deliveryFee)}` : '免费配送'}` : '门店领取'}</small>
                {position && <small>押金 ¥{money(position.unitDeposit)}/个{position.held ? ` · 您有 ${position.held} 个空${unit}可换` : ''}</small>}
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
            <span><b>{m.name}</b><small>{m.phone} · 自提 桶{m.bucketPickupTickets} 袋{m.bagPickupTickets} · 配送 桶{m.bucketDeliveryTickets} 袋{m.bagDeliveryTickets}</small></span>
            <Icon name="chevron" />
          </button>
        ))}
      {onNewMember && <button type="button" className="btn sm" onClick={create}><Icon name="plus" size="sm" />新建会员</button>}
    </div>
  );
}
