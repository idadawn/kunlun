import { useEffect, useState, type ReactNode } from 'react';
import { containerLabel, containerUnit, type ContainerSummaryItem, type InventoryAction, type UpdateStockRequest } from '@kunlun/shared';
import { useAuth } from '../auth';
import { FormDialog, NumberInput, useToast } from '../feedback';
import { useIdempotencyKey } from '../hooks';
import { Stepper } from '../ordering';
import { ReasonChips, type Done } from './common';

/*
 * 袋桶库存的三个数：「新购」「报废」一步登记，「修改数量」直接填现在的数。管理端库存页和员工手机端共用。
 */

const MAX = 1_000_000;
const RECEIVE_REASONS = ['新买了一批', '供应商补货', '供应商赠送'];
const SCRAP_REASONS = ['破了', '漏水', '太旧了', '清点时发现坏了'];

export type StockCount = 'inStationQty' | 'withCustomersQty' | 'scrappedQty';

/** 修改数量：三个数都预先填好现在的值，改哪个填哪个；只把改过的数发给后台，其他的不动。 */
export function StockEditDialog({ config: c, focus = 'inStationQty', onClose, onDone }: { config: ContainerSummaryItem; focus?: StockCount; onClose: () => void; onDone?: Done }) {
  const { api } = useAuth();
  const toast = useToast();
  const key = useIdempotencyKey();
  const unit = containerUnit(c.containerType);
  const [store, setStore] = useState(c.inStationQty);
  const [customers, setCustomers] = useState(c.withCustomersQty);
  const [scrapped, setScrapped] = useState(c.scrappedQty);
  const [threshold, setThreshold] = useState(c.warnThreshold);
  const [note, setNote] = useState('');
  useEffect(() => {
    const input = document.getElementById(`stock-${focus}`) as HTMLInputElement | null;
    input?.focus(); input?.select();
  }, [focus]);

  const changes: Omit<UpdateStockRequest, 'containerType' | 'idempotencyKey'> = {
    ...(store !== c.inStationQty && { inStationQty: store }),
    ...(customers !== c.withCustomersQty && { withCustomersQty: customers }),
    ...(scrapped !== c.scrappedQty && { scrappedQty: scrapped }),
    ...(threshold !== c.warnThreshold && { warnThreshold: threshold }),
  };
  const dirty = Object.keys(changes).length > 0;
  const total = store + customers + c.damagedQty;
  const newlyScrapped = scrapped - c.scrappedQty;
  const missing = c.memberHeldQty - customers;

  const submit = async () => {
    if (!dirty) throw new Error('数量都没变，不用保存');
    await api.updateStock({ containerType: c.containerType, idempotencyKey: key, ...changes, note: note.trim() || undefined });
    await onDone?.();
    toast(`${containerLabel(c.containerType)}的数量已更新`);
  };

  return (
    <FormDialog title="修改数量" description={containerLabel(c.containerType)} className="stock-dialog" submitLabel="保存" onClose={onClose} onSubmit={submit}
      extraActions={<>
        <span className="stock-dialog-total">合计 {total === c.totalQty ? <b>{total}</b> : <><s>{c.totalQty}</s> → <b>{total}</b></>} 个</span>
        <button type="button" className="btn" onClick={onClose}>取消</button>
      </>}>
      <p className="stock-dialog-lead">直接填现在的数量，没变的不用动。新买、报废用卡片上的「新购」「报废」更快。</p>
      <CountField id="stock-inStationQty" label="店里能用的" value={store} original={c.inStationQty} onChange={setStore}>
        空的、满的都算，坏了的不算。
      </CountField>
      <CountField id="stock-withCustomersQty" label="客户手里的" value={customers} original={c.withCustomersQty} onChange={setCustomers}>
        {missing > 0
          ? <span className="warn">比登记在会员名下的（{c.memberHeldQty} 个）少 {missing} 个，可能有会员还了{unit}没登记，可到袋桶台账核对。</span>
          : <>会员名下登记了 {c.memberHeldQty} 个{customers > c.memberHeldQty && `，另有 ${customers - c.memberHeldQty} 个没登记到人`}。</>}
      </CountField>
      <CountField id="stock-scrappedQty" label="已报废的（累计）" value={scrapped} original={c.scrappedQty} onChange={setScrapped}>
        {newlyScrapped > 0 && store === c.inStationQty
          ? <>这次多报废 {newlyScrapped} 个，是从店里拿出来的？ <button type="button" className="link" onClick={() => setStore(Math.max(c.inStationQty - newlyScrapped, 0))}>店里也减 {newlyScrapped} 个</button></>
          : '坏了扔掉的，不再算在合计里。'}
      </CountField>
      <div className="stock-dialog-more">
        <label htmlFor="stockThreshold">店里少于</label>
        <NumberInput id="stockThreshold" className="input" inputMode="numeric" min={0} max={MAX} step={1} required value={threshold}
          onChange={n => setThreshold(Math.min(MAX, Math.max(0, Math.trunc(n) || 0)))} />
        <span>个时提醒（填 0 不提醒）</span>
      </div>
      <label htmlFor="stockNote">备注（选填）</label>
      <input id="stockNote" className="input" maxLength={500} placeholder="如：核对实际数量" value={note} onChange={e => setNote(e.target.value)} />
      <ReasonChips label="常用备注" options={['核对实际数量', `会员还${unit}没登记`, '之前记错了']} value={note} onPick={setNote} />
    </FormDialog>
  );
}

/** 新购 / 报废：一步登记一个数量。新购加到店里；报废从店里拿出来、加到已报废，最多报废店里现有的。 */
export function StockQuickDialog({ config: c, action, onClose, onDone }: { config: ContainerSummaryItem; action: InventoryAction; onClose: () => void; onDone?: Done }) {
  const { api } = useAuth();
  const toast = useToast();
  const key = useIdempotencyKey();
  const unit = containerUnit(c.containerType);
  const scrap = action === 'SCRAP';
  const verb = scrap ? '报废' : '新购';
  const max = scrap ? c.inStationQty : MAX - c.inStationQty;
  const [qty, setQty] = useState(1);
  const [reason, setReason] = useState('');
  useEffect(() => {
    const input = document.getElementById('quickQty') as HTMLInputElement | null;
    input?.focus(); input?.select();
  }, []);
  const delta = scrap ? -qty : qty;

  const submit = async () => {
    await api.inventory({ containerType: c.containerType, action, quantity: qty, reason: reason.trim() || verb, idempotencyKey: key });
    await onDone?.();
    toast(`已${verb} ${qty} 个${unit}，店里现在 ${c.inStationQty + delta} 个`);
  };

  return (
    <FormDialog title={`${verb}${unit}`} description={containerLabel(c.containerType)} className="stock-dialog" submitLabel={`确认${verb}`} onClose={onClose} onSubmit={submit}
      extraActions={<>
        <span className="stock-dialog-total">合计 <s>{c.totalQty}</s> → <b>{c.totalQty + delta}</b> 个</span>
        <button type="button" className="btn" onClick={onClose}>取消</button>
      </>}>
      <p className="stock-dialog-lead">{scrap
        ? `店里坏了、要扔掉的${unit}在这里登记：店里减掉，已报废加上。会员退回的破损请到袋桶台账登记。`
        : `新买回来的${unit}在这里登记，直接加到店里。`}</p>
      <div className="stock-field changed">
        <div className="stock-field-main">
          <label htmlFor="quickQty">{scrap ? '报废几个' : '买了几个'}</label>
          <small>店里 {c.inStationQty} → <b>{c.inStationQty + delta} 个</b>{scrap && <> · 已报废 {c.scrappedQty} → <b>{c.scrappedQty + qty} 个</b></>}</small>
        </div>
        <Stepper id="quickQty" label={`${verb}数量`} value={qty} onChange={setQty} min={1} max={max} />
        {scrap && qty >= max && <p className="stock-field-hint">店里只有 {max} 个，最多报废这么多。</p>}
      </div>
      <label htmlFor="quickReason">{scrap ? '原因' : '备注'}（选填）</label>
      <input id="quickReason" className="input" maxLength={500} placeholder={scrap ? '如：破了' : '如：新买了一批'} value={reason} onChange={e => setReason(e.target.value)} />
      <ReasonChips label={scrap ? '常用原因' : '常用备注'} options={scrap ? SCRAP_REASONS : RECEIVE_REASONS} value={reason} onPick={setReason} />
    </FormDialog>
  );
}

function CountField({ id, label, value, original, onChange, children }: {
  id: string; label: string; value: number; original: number; onChange: (value: number) => void; children: ReactNode;
}) {
  const changed = value !== original;
  return (
    <div className={`stock-field${changed ? ' changed' : ''}`}>
      <div className="stock-field-main">
        <label htmlFor={id}>{label}</label>
        <small>{changed ? <>原来 {original} 个 → <b>{value} 个</b> <button type="button" className="link" onClick={() => onChange(original)}>恢复</button></> : `现在 ${original} 个`}</small>
      </div>
      <Stepper id={id} label={label} value={value} onChange={onChange} min={0} max={MAX} />
      <p className="stock-field-hint">{children}</p>
    </div>
  );
}
