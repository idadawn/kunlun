import { useState } from 'react';
import {
  KUNLUN_PERMISSIONS as P, containerLabel, containerUnit, modeLabel, money, stationDay,
  type DepositSummaryRow, type FulfillMode, type MemberOpeningRecord, type MemberProfile,
  type OpeningHoldingInput, type OpeningTicketInput, type RechargePlan, type TicketBatch, type WaterProduct,
} from '@kunlun/shared';
import { useAuth } from '../auth';
import { Dialog, Field, FormDialog, NumberInput, useToast } from '../feedback';
import { useIdempotencyKey, useLoader } from '../hooks';
import { Icon } from '../icons';
import { Stepper } from '../ordering';
import { parseYuan } from './common';

/** The largest count the server takes for tickets left, and for deposits or containers. */
const MAX_TICKETS = 100000;
const MAX_CONTAINERS = 10000;
const MODES: FulfillMode[] = ['PICKUP', 'DELIVERY'];

interface Loaded { batches: TicketBatch[]; deposits: DepositSummaryRow[]; opening: MemberOpeningRecord; products: WaterProduct[]; plans: RechargePlan[] }

/**
 * 补录上系统前的数据：老会员在用系统之前买的套餐还剩多少、交过的押金、手里的桶袋，一次填好、一次保存。
 * 打开时带出已经补录过的，可以接着改（改剩余数、删掉录错又没用过的、改没退过的押金、改手里的个数）。
 */
export function OpeningDialog({ member, onClose, onDone }: { member: MemberProfile; onClose: () => void; onDone: () => Promise<void> }) {
  const { api, can } = useAuth();
  const loaded = useLoader(async (): Promise<Loaded> => {
    const [batches, deposits, opening, products, plans] = await Promise.all([
      api.ticketBatches(member.id), api.depositSummary(member.id), api.memberOpening(member.id), api.listProducts(), api.listPlans(),
    ]);
    return { batches, deposits, opening, products, plans };
  }, [api, member.id]);
  const title = `补录上系统前的数据 · ${member.name}`;
  if (!can(P.MemberOpening)) return <Dialog title={title} onClose={onClose}><p className="account-error" role="alert">当前账号没有补录权限，请联系管理员</p></Dialog>;
  if (!loaded.data) return (
    <Dialog title={title} onClose={onClose}>
      {loaded.error ? <p className="account-error" role="alert">{loaded.error}</p> : <p className="membership-note">正在读取这位会员现在的水票、押金和桶袋…</p>}
    </Dialog>
  );
  return <OpeningForm member={member} title={title} data={loaded.data} onClose={onClose} onDone={onDone} />;
}

/** A package typed in this time: a known plan (price and size editable, in case it was sold differently back then) or an unknown one. */
interface NewPackage { key: number; choice: string; paid: string; qty: number; remaining: number }

const parseChoice = (choice: string) => {
  const [kind, a, b] = choice.split(':');
  return kind === 'plan' ? { planId: a } : kind === 'unknown' ? { waterType: a, fulfillMode: b as FulfillMode } : null;
};
const moneyOk = (text: string) => /^\d{1,8}(\.\d{1,2})?$/.test(text.trim()) && Number(text) > 0;

function OpeningForm({ member, title, data, onClose, onDone }: { member: MemberProfile; title: string; data: Loaded; onClose: () => void; onDone: () => Promise<void> }) {
  const { api } = useAuth();
  const toast = useToast();
  const key = useIdempotencyKey();
  const { products, plans } = data;
  const originalDate = data.opening.cardOpenedOn ?? null;
  const [cardDate, setCardDate] = useState(originalDate ?? '');
  const recorded = data.batches.filter(b => b.source === 'OPENING' && b.status === 'ACTIVE');
  const [edits, setEdits] = useState<Record<string, { remaining: number; remove: boolean }>>(() =>
    Object.fromEntries(recorded.map(b => [b.id, { remaining: b.remainingBuy, remove: false }])));
  const [added, setAdded] = useState<NewPackage[]>([]);
  const [depositText, setDepositText] = useState(() => money(data.opening.depositAmount));
  const [holdings, setHoldings] = useState<Record<string, number>>(() => Object.fromEntries(data.deposits.map(r => [r.containerType, r.heldQty])));
  const [note, setNote] = useState('');

  const planById = (id: string) => plans.find(p => p.id === id);
  const productOf = (water: string) => products.find(p => p.waterType === water);
  const unitFor = (water: string | undefined) => (water && productOf(water)?.containerType === 'BAG' ? '袋' : '桶');
  const update = (k: number, patch: Partial<NewPackage>) => setAdded(rows => rows.map(r => r.key === k ? { ...r, ...patch } : r));
  const choose = (row: NewPackage, choice: string) => {
    const picked = parseChoice(choice);
    const plan = picked && 'planId' in picked ? planById(picked.planId!) : undefined;
    update(row.key, plan
      ? { choice, paid: money(plan.price), qty: plan.buyQty, remaining: Math.min(row.remaining, plan.buyQty) }
      : { choice, paid: '', qty: Math.max(row.qty, row.remaining) });
  };
  const waterOf = (row: NewPackage) => {
    const picked = parseChoice(row.choice);
    return picked && 'planId' in picked ? planById(picked.planId!)?.waterType : picked?.waterType;
  };

  const submit = async () => {
    const tickets: OpeningTicketInput[] = [];
    for (const b of recorded) {
      const e = edits[b.id];
      if (e.remove) tickets.push({ batchId: b.id, remaining: 0, remove: true });
      else if (e.remaining !== b.remainingBuy) tickets.push({ batchId: b.id, remaining: e.remaining });
    }
    added.forEach((row, i) => {
      const picked = parseChoice(row.choice);
      const label = added.length > 1 ? `第 ${i + 1} 个新套餐` : '新套餐';
      if (!picked) throw new Error(`${label}还没选是哪个套餐`);
      if (row.remaining < 1) throw new Error(`${label}现在还剩几${unitFor(waterOf(row))}要大于 0`);
      if ('planId' in picked) {
        const plan = planById(picked.planId!)!;
        if (!moneyOk(row.paid)) throw new Error(`${label}当时实付的金额要大于 0、最多两位小数`);
        if (row.qty < row.remaining) throw new Error(`${label}还剩的不能比套餐的 ${row.qty} 多`);
        tickets.push({ waterType: plan.waterType, fulfillMode: plan.fulfillMode, planId: plan.id, paidAmount: Number(row.paid), packageQty: row.qty, remaining: row.remaining });
      } else tickets.push({ waterType: picked.waterType, fulfillMode: picked.fulfillMode, paidAmount: 0, remaining: row.remaining });
    });
    const amount = parseYuan(depositText);
    if (amount === null) throw new Error('请输入历史押金总额，最多两位小数');
    if (amount < data.opening.lockedDepositAmount) throw new Error(`历史押金不能低于已发生业务的 ¥${money(data.opening.lockedDepositAmount)}`);
    const depositChanged = amount !== data.opening.depositAmount;
    const holdingChanges: OpeningHoldingInput[] = data.deposits
      .filter(r => holdings[r.containerType] !== r.heldQty)
      .map(r => ({ containerType: r.containerType, quantity: holdings[r.containerType] }));
    const dateChanged = (cardDate || null) !== originalDate;
    if (cardDate && cardDate > stationDay()) throw new Error('开卡日期不能晚于今天');
    if (!dateChanged && !tickets.length && !depositChanged && !holdingChanges.length) throw new Error('还没有填要补录或修改的内容');
    const entry = await api.saveMemberOpening(member.id, { idempotencyKey: key, tickets, ...(dateChanged && { cardDate: { value: cardDate || null, expected: originalDate } }), ...(depositChanged && { depositAmount: amount, expectedDepositAmount: data.opening.depositAmount }), holdings: holdingChanges, note: note.trim() || undefined });
    await onDone();
    toast(`已补录 ${entry.entryNo}：${entry.items.length} 处变动`);
  };

  return (
    <FormDialog title={title} className="opening-dialog" submitLabel="确认补录" onClose={onClose} onSubmit={submit}
      description="按旧账本或会员凭证填写。套餐按原实付水费统计，押金单独记账。">
      <Field label="开卡日期（选填）" htmlFor="openingCardDate">
        <input id="openingCardDate" className="input" type="date" max={stationDay()} value={cardDate} onInput={e => setCardDate(e.currentTarget.value)} />
      </Field>
      <p className="membership-note">已补录的套餐水费计入开卡当天；日期不详可留空，待确认后再计入收款统计。</p>
      <section className="opening-section" aria-labelledby="openingTicketsTitle">
        <div className="opening-section-head">
          <h3 id="openingTicketsTitle">买过的套餐还剩多少</h3>
          <small>这些水票先用，再用系统里充值的；填了当时付的钱，退款按原价折算</small>
        </div>
        {recorded.map(b => {
          const e = edits[b.id]; const unit = unitFor(b.waterType); const reserved = b.reservedBuy;
          const priced = Number(b.paidAmount) > 0;
          return (
            <div key={b.id} className={`opening-row${e.remove ? ' removing' : ''}`}>
              <div className="opening-row-head">
                <b>{b.name}</b>
                {e.remove
                  ? <button type="button" className="text-btn" onClick={() => setEdits(s => ({ ...s, [b.id]: { ...e, remove: false } }))}>撤销删除</button>
                  : b.removable && <button type="button" className="text-btn danger" onClick={() => setEdits(s => ({ ...s, [b.id]: { ...e, remove: true } }))}>录错了，删除</button>}
              </div>
              {e.remove ? <p className="membership-note">保存后删除这笔余额（还剩 {b.remainingBuy}{unit}），会员的水票同时减掉。</p> : <>
                <div className="opening-inline">
                  <label htmlFor={`openingLeft-${b.id}`}>现在还剩</label>
                  <Stepper id={`openingLeft-${b.id}`} label="还剩数量" value={e.remaining} min={reserved} max={priced ? b.fixedQty : MAX_TICKETS}
                    onChange={n => setEdits(s => ({ ...s, [b.id]: { ...e, remaining: n } }))} />
                  <span>{unit}</span>
                  {e.remaining !== b.remainingBuy && <small className="opening-change">原来 {b.remainingBuy} → {e.remaining}</small>}
                </div>
                <p className="membership-note">
                  {priced ? `当时实付 ¥${money(b.paidAmount)} / 套餐 ${b.fixedQty}${unit}，现在剩的折合 ¥${money(Number(b.paidAmount) * e.remaining / b.fixedQty)}` : '套餐不清楚，没有原价，不能按原价退款'}
                  {reserved > 0 && `；有 ${reserved}${unit}被未完成的水单占着，不能少于这个数`}
                  {!b.removable && '；已经用来下过单，不能删除，只能改剩余'}
                </p>
              </>}
            </div>
          );
        })}
        {added.map((row, i) => (
          <NewPackageRow key={row.key} row={row} index={i} products={products} plans={plans} unit={unitFor(waterOf(row))}
            onChoose={choice => choose(row, choice)} onChange={patch => update(row.key, patch)}
            onRemove={() => setAdded(rows => rows.filter(r => r.key !== row.key))} />
        ))}
        <button type="button" className="btn sm opening-add" onClick={() => setAdded(rows => [...rows, { key: Math.max(0, ...rows.map(r => r.key)) + 1, choice: '', paid: '', qty: 1, remaining: 1 }])}>
          <Icon name="plus" size="sm" />{recorded.length || added.length ? '再添加一个套餐' : '添加上系统前买的套餐'}
        </button>
      </section>

      <section className="opening-section" aria-labelledby="openingContainersTitle">
        <div className="opening-section-head">
          <h3 id="openingContainersTitle">押金和手里的桶袋</h3>
        </div>
        <Field label="上系统前已交押金总额（元）" htmlFor="openingDepositTotal">
          <input id="openingDepositTotal" className="input opening-money" inputMode="decimal" type="number" min={data.opening.lockedDepositAmount} step="0.01" required
            value={depositText} onChange={e => setDepositText(e.target.value)} />
        </Field>
        {data.opening.lockedDepositAmount > 0 && <p className="membership-note">其中 ¥{money(data.opening.lockedDepositAmount)} 已发生退款或报废占用，需保留原记录。</p>}
        {data.deposits.map(r => <div className="opening-inline" key={r.containerType}>
          <label htmlFor={`openingHeld-${r.containerType}`}>{r.name} · 手里{containerUnit(r.containerType)}数</label>
          <Stepper id={`openingHeld-${r.containerType}`} label={`${r.name}持有数量`} value={holdings[r.containerType]} min={0} max={MAX_CONTAINERS}
            onChange={n => setHoldings(s => ({ ...s, [r.containerType]: n }))} />
        </div>)}
      </section>

      <Field label="备注（选填）" htmlFor="openingNote">
        <input id="openingNote" className="input" maxLength={200} placeholder="如：纸质台账第 3 页、会员出示的充值卡" value={note} onChange={e => setNote(e.target.value)} />
      </Field>
    </FormDialog>
  );
}

function NewPackageRow({ row, index, products, plans, unit, onChoose, onChange, onRemove }: {
  row: NewPackage; index: number; products: WaterProduct[]; plans: RechargePlan[]; unit: string;
  onChoose: (choice: string) => void; onChange: (patch: Partial<NewPackage>) => void; onRemove: () => void;
}) {
  const picked = parseChoice(row.choice);
  const priced = !!picked && 'planId' in picked;
  const id = `openingPlan-${row.key}`;
  const value = priced && moneyOk(row.paid) && row.qty > 0 ? Number(row.paid) * row.remaining / row.qty : null;
  return (
    <div className="opening-row new">
      <div className="opening-row-head">
        <label htmlFor={id}>{index === 0 ? '当时买的套餐' : `第 ${index + 1} 个套餐`}</label>
        <button type="button" className="text-btn" onClick={onRemove}>不填这个</button>
      </div>
      <select id={id} className="select" value={row.choice} onChange={e => onChoose(e.target.value)}>
        <option value="">请选择当时买的套餐</option>
        {products.map(p => {
          const own = plans.filter(plan => plan.waterType === p.waterType);
          return (
            <optgroup key={p.waterType} label={p.name}>
              {own.map(plan => <option key={plan.id} value={`plan:${plan.id}`}>{plan.name}{plan.status === 'ACTIVE' ? '' : '（已停用）'}</option>)}
              {MODES.map(mode => <option key={mode} value={`unknown:${p.waterType}:${mode}`}>{p.name} · {modeLabel(mode)}（套餐不清楚）</option>)}
            </optgroup>
          );
        })}
      </select>
      {priced && (
        <div className="opening-inline">
          <label htmlFor={`openingPaid-${row.key}`}>当时实付 ¥</label>
          <input id={`openingPaid-${row.key}`} className="input opening-money" inputMode="decimal" value={row.paid} onChange={e => onChange({ paid: e.target.value })} />
          <label htmlFor={`openingQty-${row.key}`}>套餐共</label>
          <NumberInput id={`openingQty-${row.key}`} className="input opening-count" inputMode="numeric" min={1} max={MAX_TICKETS} value={row.qty}
            onChange={n => onChange({ qty: Math.max(0, Math.trunc(n)) })} />
          <span>{unit}</span>
        </div>
      )}
      {picked && (
        <div className="opening-inline">
          <label htmlFor={`openingRemaining-${row.key}`}>现在还剩</label>
          <Stepper id={`openingRemaining-${row.key}`} label="还剩数量" value={row.remaining} min={1} max={priced ? Math.max(1, row.qty) : MAX_TICKETS} onChange={n => onChange({ remaining: n })} />
          <span>{unit}</span>
        </div>
      )}
      <p className="membership-note">
        {!picked ? '照旧账选；套餐列表里没有当时的价格，可以选最接近的再改实付金额和桶数。'
          : priced ? (value === null ? '填好实付金额和套餐桶数后显示折合金额' : `还剩 ${row.remaining}${unit}，按原价折合 ¥${money(value)}，退款就按这个算`)
          : '不知道当时付了多少钱：可以照常用水，但不能按原价退款'}
      </p>
    </div>
  );
}
