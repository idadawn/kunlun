import { useState } from 'react';
import {
  KUNLUN_PERMISSIONS as P, containerLabel, containerUnit, modeLabel, money, shortDateTime,
  type DepositSummaryRow, type FulfillMode, type MemberOpeningRecord, type MemberProfile, type OpeningDeposit, type OpeningDepositInput,
  type OpeningEntry, type OpeningHoldingInput, type OpeningItem, type OpeningTicketInput, type RechargePlan, type TicketBatch, type WaterProduct,
} from '@kunlun/shared';
import { Dialog, Field, FormDialog, Icon, NumberInput, Stepper, useAuth, useDialogs, useIdempotencyKey, useLoader, useRun, useToast } from '@kunlun/ui';
import { useAdminData } from './data';

/** The largest count the server takes for tickets left, and for deposits or containers. */
const MAX_TICKETS = 100000;
const MAX_CONTAINERS = 10000;
const MODES: FulfillMode[] = ['PICKUP', 'DELIVERY'];

interface Loaded { batches: TicketBatch[]; deposits: DepositSummaryRow[]; opening: MemberOpeningRecord }

/**
 * 补录上系统前的数据：老会员在用系统之前买的套餐还剩多少、交过的押金、手里的桶袋，一次填好、一次保存。
 * 打开时带出已经补录过的，可以接着改（改剩余数、删掉录错又没用过的、改没退过的押金、改手里的个数）。
 */
export function OpeningDialog({ member, onClose, onDone }: { member: MemberProfile; onClose: () => void; onDone: () => Promise<void> }) {
  const { api, can } = useAuth();
  const loaded = useLoader(async (): Promise<Loaded> => {
    const [batches, deposits, opening] = await Promise.all([api.ticketBatches(member.id), api.depositSummary(member.id), api.memberOpening(member.id)]);
    return { batches, deposits, opening };
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
  const { products, plans } = useAdminData();
  const recorded = data.batches.filter(b => b.source === 'OPENING' && b.status === 'ACTIVE');
  const [edits, setEdits] = useState<Record<string, { remaining: number; remove: boolean }>>(() =>
    Object.fromEntries(recorded.map(b => [b.id, { remaining: b.remainingBuy, remove: false }])));
  const [added, setAdded] = useState<NewPackage[]>(() => recorded.length ? [] : [{ key: 1, choice: '', paid: '', qty: 1, remaining: 1 }]);
  const openingOf = (type: string) => data.opening.deposits.find(d => d.containerType === type);
  const [deposits, setDeposits] = useState<Record<string, { qty: number; price: string }>>(() => Object.fromEntries(data.deposits.map(r => {
    const lot = openingOf(r.containerType);
    return [r.containerType, { qty: lot?.quantity ?? 0, price: money(lot?.unitPrice ?? r.unitDeposit) }];
  })));
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
    const depositChanges: OpeningDepositInput[] = [];
    for (const r of data.deposits) {
      const lot = openingOf(r.containerType); const d = deposits[r.containerType];
      if (lot?.locked) continue;
      if (d.qty > 0 && !moneyOk(d.price)) throw new Error(`${containerLabel(r.containerType)}每个的押金要大于 0、最多两位小数`);
      const price = d.qty > 0 ? Number(d.price) : 0;
      if (lot ? d.qty !== lot.quantity || (d.qty > 0 && price !== Number(lot.unitPrice)) : d.qty > 0)
        depositChanges.push({ containerType: r.containerType, quantity: d.qty, unitPrice: price });
    }
    const holdingChanges: OpeningHoldingInput[] = data.deposits
      .filter(r => holdings[r.containerType] !== r.heldQty)
      .map(r => ({ containerType: r.containerType, quantity: holdings[r.containerType] }));
    if (!tickets.length && !depositChanges.length && !holdingChanges.length) throw new Error('还没有填要补录或修改的内容');
    const entry = await api.saveMemberOpening(member.id, { idempotencyKey: key, tickets, deposits: depositChanges, holdings: holdingChanges, note: note.trim() || undefined });
    await onDone();
    toast(`已补录 ${entry.entryNo}：${entry.items.length} 处变动`);
  };

  return (
    <FormDialog title={title} className="opening-dialog" submitLabel="确认补录" onClose={onClose} onSubmit={submit}
      description="按旧账本或会员手里的凭证填写。补录的不算今天收的钱，只让水票、押金和桶袋对得上；之后点单、退押金、退水费都照常办。">
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
          <small>每种水品的配套桶袋分开填；押金退的时候按这里填的单价退</small>
        </div>
        {data.deposits.map(r => (
          <ContainerRow key={r.containerType} row={r} lot={openingOf(r.containerType)} deposit={deposits[r.containerType]} held={holdings[r.containerType]}
            onDeposit={d => setDeposits(s => ({ ...s, [r.containerType]: d }))} onHeld={n => setHoldings(s => ({ ...s, [r.containerType]: n }))} />
        ))}
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

/** One container: the deposit paid before the system (count × price each) and how many the member holds now. */
function ContainerRow({ row: r, lot, deposit, held, onDeposit, onHeld }: {
  row: DepositSummaryRow; lot?: OpeningDeposit; deposit: { qty: number; price: string }; held: number;
  onDeposit: (deposit: { qty: number; price: string }) => void; onHeld: (held: number) => void;
}) {
  const unit = containerUnit(r.containerType);
  const locked = !!lot?.locked;
  // Coverage once saved: the deposit paid in the system, plus the opening deposit as it will be.
  const coveredNow = r.paidQty - r.pendingDamageQty + r.pendingCollectQty;
  const covered = coveredNow - (lot?.remainingQty ?? 0) + (locked ? lot!.remainingQty : deposit.qty);
  const owing = Math.max(0, held - covered);
  const total = deposit.qty > 0 && moneyOk(deposit.price) ? deposit.qty * Number(deposit.price) : 0;
  return (
    <div className="opening-row">
      <div className="opening-row-head"><b>{containerLabel(r.containerType)}</b><small>现在：已交押金 {r.paidQty} 个 ¥{money(r.paidAmount)} · 手里 {r.heldQty} 个</small></div>
      {locked ? <>
        <div className="opening-inline"><span>上系统前交的押金</span><b>{lot!.quantity} 个 × ¥{money(lot!.unitPrice)} = ¥{money(lot!.amount)}</b></div>
        <p className="membership-note">这笔押金已经退过或报废扣过，不能再改；要退押金请走「退押金」。</p>
      </> : (
        <div className="opening-inline">
          <label htmlFor={`openingDeposit-${r.containerType}`}>上系统前交的押金</label>
          <Stepper id={`openingDeposit-${r.containerType}`} label="押金个数" value={deposit.qty} min={0} max={MAX_CONTAINERS} onChange={qty => onDeposit({ ...deposit, qty })} />
          <label htmlFor={`openingPrice-${r.containerType}`}>个 × 每个 ¥</label>
          <input id={`openingPrice-${r.containerType}`} className="input opening-money" inputMode="decimal" value={deposit.price}
            onChange={e => onDeposit({ ...deposit, price: e.target.value })} />
          {deposit.qty > 0 && <small className="opening-change">共 ¥{money(total)}</small>}
        </div>
      )}
      <div className="opening-inline">
        <label htmlFor={`openingHeld-${r.containerType}`}>现在手里</label>
        <Stepper id={`openingHeld-${r.containerType}`} label="手里个数" value={held} min={0} max={MAX_CONTAINERS} onChange={onHeld} />
        <span>个{unit}</span>
        {held !== r.heldQty && <small className="opening-change">原来 {r.heldQty} → {held}</small>}
      </div>
      {owing > 0 && <p className="profile-warn">手里比押金多 {owing} 个，下次领{unit}时会提示补交押金；没交过就不用填押金。</p>}
    </div>
  );
}

/** What one opening item changed, in plain words. */
export function describeOpeningItem(item: OpeningItem) {
  switch (item.kind) {
    case 'TICKETS':
      return item.action === 'CREATE' ? `补录「${item.name}」，还剩 ${item.after}${item.unit}`
        : item.action === 'REMOVE' ? `删除「${item.name}」（原来还剩 ${item.before}${item.unit}）`
        : `「${item.name}」还剩 ${item.before} → ${item.after}${item.unit}`;
    case 'DEPOSIT': {
      const amount = (a: { quantity: number; unitPrice: number }) => `${a.quantity} 个 × ¥${money(a.unitPrice)}`;
      return item.action === 'CREATE' ? `${containerLabel(item.containerType)}上系统前的押金 ${amount(item.after!)}`
        : item.action === 'REMOVE' ? `删除${containerLabel(item.containerType)}上系统前的押金（${amount(item.before!)}）`
        : `${containerLabel(item.containerType)}上系统前的押金 ${amount(item.before!)} → ${amount(item.after!)}`;
    }
    default:
      return `${containerLabel(item.containerType)}手里 ${item.before} → ${item.after} 个`;
  }
}

/**
 * 会员档案里的「上系统前的数据」：历次补录（谁、什么时候、改了什么），有权限的可以继续补录或修改。
 * 补录的套餐余量、押金和桶袋本身照常显示在水票批次和押金卡片里。
 */
export function OpeningCard({ member }: { member: MemberProfile }) {
  const { api, can } = useAuth();
  const { version, refresh } = useAdminData();
  const dialogs = useDialogs();
  const run = useRun();
  const record = useLoader(() => api.memberOpening(member.id), [api, member.id, version]);
  const entries: OpeningEntry[] = record.data?.entries ?? [];
  const canRecord = can(P.MemberOpening);
  if (!canRecord && record.data && !entries.length) return null;
  const open = run(() => dialogs.open(close => <OpeningDialog member={member} onClose={close} onDone={refresh} />));
  return (
    <section className="card">
      <div className="card-head">
        <div className="card-title">上系统前的数据 <small>老会员用系统之前的套餐、押金和桶</small></div>
        {canRecord && <button type="button" className="text-btn" onClick={() => open()}>{entries.length ? '补录 / 修改' : '去补录'}</button>}
      </div>
      <div className="profile-card-body">
        {record.error ? <p className="account-error" role="alert">{record.error}</p>
          : !record.data ? <p className="membership-note">正在读取补录记录…</p>
          : !entries.length ? <p className="membership-note">还没有补录过。老会员第一次来时，把之前买的套餐还剩多少、交过的押金和手里的桶补录进来，之后的点单和退款就都对得上。</p>
          : <ol className="opening-entries">{entries.map(e => (
            <li key={e.id}>
              <div className="opening-entry-head"><b>{shortDateTime(e.createdAt)}</b><small>{e.operatorName} · {e.entryNo}</small></div>
              <ul>{e.items.map((item, i) => <li key={i}>{describeOpeningItem(item)}</li>)}</ul>
              {e.note && <small className="opening-entry-note">备注：{e.note}</small>}
            </li>
          ))}</ol>}
      </div>
    </section>
  );
}
