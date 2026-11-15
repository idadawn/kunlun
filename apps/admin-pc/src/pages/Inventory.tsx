import { useState, type FormEvent, type ReactNode } from 'react';
import { KUNLUN_PERMISSIONS as P, containerKind, containerLabel, money, shortDateTime, type ContainerSummaryItem, type ContainerType, type InventoryOperation } from '@kunlun/shared';
import { Dialog, Field, FormDialog, ReasonChips, useApi, useAuth, useDialogs, useIdempotencyKey, useLoader, useRun, useToast } from '@kunlun/ui';
import { EmptyRow, useExport, useGo } from '../common';
import { useAdminData } from '../data';

/** Common ways a bucket or bag gets damaged, offered as one-tap reasons when registering damage or scrapping. */
export const DAMAGE_REASONS: Record<ContainerType, readonly string[]> = {
  BUCKET: ['桶身开裂漏水', '桶口破损', '提手断裂', '磕碰变形', '污染异味无法清洗', '自然老化'],
  BAG: ['袋体破损漏水', '袋口/阀门损坏', '封口不严', '污染无法清洗', '自然老化'],
};

/** A figure answered "说不清" in a stock-take. */
const Unverified = () => <span className="stock-unknown">待核实</span>;

/** 客户手里 = 登记在会员名下的 + 盘点时多出来、还没登记到人的；说不清时只知道会员名下的部分。 */
function WithCustomers({ held, unregistered, unknown }: { held: number; unregistered: number; unknown: boolean }) {
  if (unknown) return <b>会员名下 {held} 个 + <Unverified /></b>;
  if (unregistered > 0) return <b>{held + unregistered} 个<small>（会员名下 {held}，未登记 {unregistered}）</small></b>;
  return <b>{held} 个</b>;
}

const totalText = (total: number, unsure: boolean) => `${unsure ? '至少 ' : ''}${total}`;

export function Inventory() {
  const { containers, version, refresh } = useAdminData();
  const { api, can } = useAuth();
  const dialogs = useDialogs();
  const run = useRun();
  const go = useGo();
  const exportCsv = useExport();
  const permitted = can(P.ContainerInventoryManage);
  const history = useLoader(() => permitted ? api.inventoryOperations() : Promise.resolve([]), [api, permitted, version]);
  const done = async () => { await refresh(); await history.reload(); };
  const open = (render: (close: () => void) => ReactNode) => run(() => dialogs.open(render))();

  return <>
    <div className="page-head"><div><h2>袋桶库存</h2><p>盘点时照实回答三个问题：店里有多少、客户手里有多少、要报废多少；说不清的先记为待核实</p></div></div>
    <div className="stock-grid">
      {containers.length === 0 ? <p className="membership-note">正在加载库存…</p> : containers.map(c => (
        <article key={c.containerType} className="stock-card">
          <header>
            <div><h3>{containerLabel(c.containerType)}</h3><small>押金 ¥{money(c.unitDeposit)} / 个 · {c.countedAt ? `上次盘点 ${shortDateTime(c.countedAt)}` : '还没盘点过'}</small></div>
            {c.lowStockWarning && <span className="tag orange">店里偏少</span>}
          </header>
          <div className="stock-total"><span>现存总量</span><strong>{totalText(c.totalQty, c.inStationUnknown || c.outUnknown)}</strong><span>个</span></div>
          <div className="stock-rows">
            <div className="stock-row"><span>店里能用</span>{c.inStationUnknown ? <Unverified /> : <b>{c.inStationQty} 个</b>}</div>
            <div className="stock-row"><span>客户手里</span><WithCustomers held={c.memberHeldQty} unregistered={c.unregisteredOutQty} unknown={c.outUnknown} /></div>
            {c.damagedQty > 0 && (
              <div className="stock-row"><span>会员退回待报废</span><button type="button" className="link" onClick={() => go('assets')}>{c.damagedQty} 个 · 去台账确认 ›</button></div>
            )}
            <div className="stock-row"><span>累计已报废（不算库存）</span><b>{c.scrappedQty} 个</b></div>
          </div>
          {permitted && (
            <footer>
              <button type="button" className="btn primary" onClick={() => open(close => <StocktakeDialog config={c} onClose={close} onDone={done} />)}>开始盘点</button>
              <button type="button" className="btn" onClick={() => open(close => <ReceiveDialog config={c} onClose={close} onDone={done} />)}>新买入库</button>
            </footer>
          )}
        </article>
      ))}
    </div>
    <p className="membership-note">现存总量 = 店里能用 + 客户手里 + 会员退回待报废，不含已报废的。盘点时答「说不清」的项目记为「待核实」，不影响日常收发桶，下次盘点填上数字就行。</p>
    {permitted && (
      <div className="table-card">
        <div className="table-toolbar">
          <div><b>盘点与入库记录</b><small>最近 100 笔，包含会员破损报废联动记录</small></div>
          <button type="button" className="btn sm" onClick={() => exportCsv('inventory-operations')}>导出全部记录</button>
        </div>
        <div className="inventory-table-scroll">
          <table>
            <thead><tr><th>时间 / 单号</th><th>容器</th><th>业务</th><th>内容</th><th>现存总量</th><th>关联会员 / 备注</th><th>操作人</th></tr></thead>
            <tbody>
              {history.error ? <EmptyRow colSpan={7}>{history.error}</EmptyRow>
                : !history.data?.length ? <EmptyRow colSpan={7}>{history.data ? '暂无盘点或入库记录' : '正在加载…'}</EmptyRow>
                : history.data.map(({ operation: o, memberName }) => (
                  <tr key={o.id}>
                    <td>{new Date(o.createdAt).toLocaleString('zh-CN', { hour12: false })}<br /><small>{o.operationNo}</small></td>
                    <td>{containerLabel(o.containerType)}</td>
                    <td><OperationTag action={o.action} /></td>
                    <td><OperationContent operation={o} /></td>
                    <td>{totalText(o.before.totalQty, !!(o.before.inStationUnknown || o.before.outUnknown))} → {totalText(o.after.totalQty, !!(o.after.inStationUnknown || o.after.outUnknown))}</td>
                    <td className="inventory-reason">{memberName && <><b>{memberName}</b><br /></>}{o.reason}</td>
                    <td>{o.operatorName}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>
    )}
  </>;
}

const OperationTag = ({ action }: { action: InventoryOperation['action'] }) =>
  action === 'COUNT' ? <span className="tag blue">盘点</span> : action === 'RECEIVE' ? <span className="tag green">入库</span> : <span className="tag orange">报废</span>;

function OperationContent({ operation: o }: { operation: InventoryOperation }) {
  if (o.action !== 'COUNT') return <>{o.action === 'RECEIVE' ? '+' : '−'}{o.quantity}</>;
  const answers = o.counted;
  if (!answers) return <>盘点</>;
  return (
    <small className="stock-counted">
      店里 {answers.inStationQty ?? <Unverified />} · 客户手里 {answers.withCustomersQty ?? <Unverified />}（会员名下 {answers.registeredHeldQty}）· 报废 {answers.scrapQty}
    </small>
  );
}

/** One answer of the stock-take: a count, or "说不清" which the server records as 待核实. */
type Answer = { unknown: boolean; value: string };
const answered = (a: Answer) => (a.unknown ? null : Number(a.value));

function CountStep({ id, label, question, hint, answer, onChange, quick, children }: {
  id: string;
  label: string;
  question: string;
  hint: ReactNode;
  answer: Answer;
  onChange: (answer: Answer) => void;
  quick: Array<{ label: string; value: number }>;
  children?: ReactNode;
}) {
  return (
    <div className="stocktake-step">
      <small className="stocktake-label">{label}</small>
      <label htmlFor={id} className="stocktake-question">{question}</label>
      <p className="stocktake-hint">{hint}</p>
      <div className="stocktake-answer">
        <input id={id} className="input" type="number" inputMode="numeric" min={0} max={1000000} step={1} autoFocus
          required={!answer.unknown} disabled={answer.unknown} placeholder={answer.unknown ? '待核实' : ''}
          value={answer.unknown ? '' : answer.value} onChange={e => onChange({ unknown: false, value: e.target.value })} />
        <span>个</span>
      </div>
      <div className="slot-chips stocktake-quick" role="group" aria-label="快捷回答">
        {quick.map(q => (
          <button key={q.label} type="button" className={!answer.unknown && answer.value === String(q.value) ? 'active' : ''} onClick={() => onChange({ unknown: false, value: String(q.value) })}>{q.label}</button>
        ))}
        <button type="button" className={answer.unknown ? 'active' : ''} aria-pressed={answer.unknown} onClick={() => onChange({ ...answer, unknown: !answer.unknown })}>说不清，先记为待核实</button>
      </div>
      {children}
    </div>
  );
}

const STEPS = ['店里', '客户手里', '报废', '确认'] as const;

/** 盘点向导：一步只问一件事，最后汇总确认；说不清的项目记为待核实。 */
function StocktakeDialog({ config: c, onClose, onDone }: { config: ContainerSummaryItem; onClose: () => void; onDone: () => Promise<void> }) {
  const api = useApi();
  const toast = useToast();
  const key = useIdempotencyKey();
  const name = containerLabel(c.containerType);
  const registered = c.memberHeldQty;
  const [step, setStep] = useState(0);
  const [store, setStore] = useState<Answer>({ unknown: false, value: c.inStationUnknown ? '' : String(c.inStationQty) });
  const [customers, setCustomers] = useState<Answer>({ unknown: false, value: c.outUnknown ? '' : String(registered + c.unregisteredOutQty) });
  const [scrap, setScrap] = useState('0');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const storeQty = answered(store);
  const customersQty = answered(customers);
  const scrapQty = Number(scrap) || 0;
  const unregistered = customersQty === null ? 0 : Math.max(customersQty - registered, 0);
  const totalAfter = (storeQty ?? Math.max(c.inStationQty - scrapQty, 0)) + registered + c.damagedQty + unregistered;
  const unsure = storeQty === null || customersQty === null;

  const next = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    if (step < STEPS.length - 1) { setStep(step + 1); return; }
    setBusy(true);
    try {
      await api.stocktake({ containerType: c.containerType, inStationQty: storeQty, withCustomersQty: customersQty, scrapQty, idempotencyKey: key, note: note.trim() || undefined });
      await onDone();
      toast(`${name}盘点已保存`);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Dialog title={`盘点 · ${name}`} description="一步一个问题，照实回答；说不清的不用硬填" className="stocktake-dialog" onClose={onClose}>
      <form onSubmit={next}>
        <ol className="stocktake-steps" aria-label={`第 ${step + 1} 步，共 ${STEPS.length} 步`}>
          {STEPS.map((title, i) => <li key={title} className={i < step ? 'done' : i === step ? 'current' : ''}>{title}</li>)}
        </ol>
        {step === 0 && (
          <CountStep id="countStore" label="第 1 步 · 店里" question={`现在店里有多少个能用的${name}？`}
            hint="空的、满的都算；坏了不能用的先不算，第 3 步再说。" answer={store} onChange={setStore}
            quick={c.inStationUnknown ? [] : [{ label: `和系统里一样（${c.inStationQty} 个）`, value: c.inStationQty }]} />
        )}
        {step === 1 && (
          <CountStep id="countCustomers" label="第 2 步 · 客户手里" question="客户手里大概有多少个？"
            hint={<>已经拿回家、还没还回来的。系统里登记在会员名下的有 <b>{registered}</b> 个。</>} answer={customers} onChange={setCustomers}
            quick={[{ label: `就是会员名下的 ${registered} 个`, value: registered }]}>
            {customersQty !== null && customersQty > registered && (
              <p className="stocktake-note">其中 {customersQty - registered} 个没登记到具体会员，记为「客户手里 · 未登记」。</p>
            )}
            {customersQty !== null && customersQty < registered && (
              <p className="stocktake-note warn">比登记在会员名下的少 {registered - customersQty} 个，可能有会员还了桶没登记。先照实填，之后可到「袋桶台账」核对会员手里的数量。</p>
            )}
          </CountStep>
        )}
        {step === 2 && (
          <div className="stocktake-step">
            <small className="stocktake-label">第 3 步 · 报废</small>
            <label htmlFor="countScrap" className="stocktake-question">店里有多少个坏了、要报废？</label>
            <p className="stocktake-hint">
              报废后就不再算库存。{c.damagedQty > 0 && <>会员退回来的 {c.damagedQty} 个待报废要决定扣不扣押金，请到「袋桶台账」确认，这里不用算。</>}
            </p>
            <div className="stocktake-answer">
              <input id="countScrap" className="input" type="number" inputMode="numeric" min={0} max={1000000} step={1} required autoFocus value={scrap} onChange={e => setScrap(e.target.value)} />
              <span>个</span>
            </div>
            <div className="slot-chips stocktake-quick" role="group" aria-label="快捷回答">
              <button type="button" className={scrapQty === 0 ? 'active' : ''} onClick={() => setScrap('0')}>没有要报废的</button>
            </div>
            <div className="membership-fields stocktake-extra">
              <Field label={scrapQty > 0 ? '报废原因 / 备注（选填）' : '备注（选填）'} htmlFor="countNote">
                <input id="countNote" className="input" maxLength={500} placeholder={scrapQty > 0 ? '如：桶身开裂' : '如：月底盘点'} value={note} onChange={e => setNote(e.target.value)} />
              </Field>
              {scrapQty > 0 && <ReasonChips options={DAMAGE_REASONS[containerKind(c.containerType)]} value={note} onPick={setNote} />}
            </div>
          </div>
        )}
        {step === 3 && (
          <div className="stocktake-step">
            <small className="stocktake-label">确认</small>
            <p className="stocktake-question">看一下盘点结果，没问题就保存</p>
            <div className="detail-card">
              <div className="detail-row"><span>店里能用</span>{storeQty === null ? <Unverified /> : <b>{storeQty} 个</b>}</div>
              <div className="detail-row"><span>客户手里</span><WithCustomers held={registered} unregistered={unregistered} unknown={customersQty === null} /></div>
              {c.damagedQty > 0 && <div className="detail-row"><span>会员退回待报废</span><b>{c.damagedQty} 个</b></div>}
              <div className="detail-row"><span>这次报废</span><b>{scrapQty} 个</b></div>
              <div className="detail-row"><span>盘点后现存总量</span><b>{totalText(totalAfter, unsure)} 个<small>（原来 {totalText(c.totalQty, c.inStationUnknown || c.outUnknown)} 个）</small></b></div>
            </div>
            {unsure && <p className="stocktake-note">「待核实」的项目不影响日常收发桶，下次盘点填上数字就行。</p>}
          </div>
        )}
        <p role="alert" className="account-error">{error}</p>
        <footer>
          {step > 0 && <button type="button" className="btn" disabled={busy} onClick={() => { setError(''); setStep(step - 1); }}>上一步</button>}
          <button className="btn primary" type="submit" disabled={busy}>{step < STEPS.length - 1 ? '下一步' : busy ? '正在保存…' : '确认盘点'}</button>
        </footer>
      </form>
    </Dialog>
  );
}

function ReceiveDialog({ config, onClose, onDone }: { config: ContainerSummaryItem; onClose: () => void; onDone: () => Promise<void> }) {
  const api = useApi();
  const toast = useToast();
  const key = useIdempotencyKey();
  const [quantity, setQuantity] = useState(1);
  const [reason, setReason] = useState('');
  const submit = async () => {
    await api.inventory({ containerType: config.containerType, action: 'RECEIVE', quantity, reason: reason.trim(), idempotencyKey: key });
    await onDone();
    toast('入库成功');
  };
  return (
    <FormDialog title={`${containerLabel(config.containerType)} · 新买入库`} className="inventory-dialog" submitLabel="确认入库" onClose={onClose} onSubmit={submit}>
      <div className="membership-summary">新买回来的袋桶直接算进店里能用的。</div>
      <Field label="数量（个）" htmlFor="stockQty">
        <input id="stockQty" className="input" type="number" min={1} max={1000000} step={1} required value={quantity} onChange={e => setQuantity(Number(e.target.value))} />
      </Field>
      <ReasonField value={reason} onChange={setReason} placeholder="如：采购批次、供应商" />
    </FormDialog>
  );
}

export function ReasonField({ value, onChange, placeholder = '填写来源或处理原因' }: { value: string; onChange: (value: string) => void; placeholder?: string }) {
  return (
    <Field label="原因 / 备注" htmlFor="operationReason">
      <textarea id="operationReason" className="input" maxLength={500} rows={3} required placeholder={placeholder} value={value} onChange={e => onChange(e.target.value)} />
    </Field>
  );
}
