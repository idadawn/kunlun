import { useEffect, useState, type ReactNode } from 'react';
import {
  KUNLUN_PERMISSIONS as P, containerKind, containerLabel, containerUnit, money, shortDateTime,
  type ContainerSummaryItem, type ContainerType, type InventoryBalance, type InventoryOperation, type UpdateStockRequest,
} from '@kunlun/shared';
import { FormDialog, Icon, ReasonChips, Stepper, useApi, useAuth, useDialogs, useIdempotencyKey, useLoader, useRun, useToast } from '@kunlun/ui';
import { EmptyRow, useExport, useGo } from '../common';
import { useAdminData } from '../data';

const MAX = 1_000_000;
type Count = 'inStationQty' | 'withCustomersQty' | 'scrappedQty';

/** 客户手里 of records written before it was its own count: what members held plus what stock-takes found unregistered. */
const customersOf = (b: InventoryBalance) => b.withCustomersQty ?? b.memberHeldQty + (b.unregisteredOutQty ?? 0);

export function Inventory() {
  const { containers, loaded, version, refresh } = useAdminData();
  const { api, can } = useAuth();
  const dialogs = useDialogs();
  const run = useRun();
  const exportCsv = useExport();
  const permitted = can(P.ContainerInventoryManage);
  const [filter, setFilter] = useState<ContainerType | ''>('');
  const history = useLoader(() => permitted ? api.inventoryOperations(filter || undefined) : Promise.resolve([]), [api, permitted, filter, version]);
  const edit = (config: ContainerSummaryItem, focus: Count = 'inStationQty') =>
    run(() => dialogs.open(close => <StockDialog config={config} focus={focus} onClose={close} onDone={refresh} />))();

  return <>
    <div className="page-head">
      <div><h2>袋桶库存</h2><p>店里、客户手里、报废的数量随时点开就能改；领桶、还桶、破损登记会自动跟着变</p></div>
      {permitted && <div className="head-actions"><button type="button" className="btn" onClick={() => exportCsv('inventory-operations')}><Icon name="export" size="sm" />导出修改记录</button></div>}
    </div>

    <div className="stock-grid">
      {!loaded ? <p className="stock-placeholder">正在加载库存…</p>
        : containers.length === 0 ? <p className="stock-placeholder">还没有水品，先到「水品与押金标准」添加，配套桶袋会自动出现在这里。</p>
        : containers.map(c => <StockCard key={c.containerType} c={c} onEdit={permitted ? focus => edit(c, focus) : undefined} />)}
    </div>

    {permitted && (
      <div className="table-card">
        <div className="table-toolbar">
          <div><b>修改记录</b><small>最近 100 笔，含入库、报废和会员破损报废</small></div>
          <select className="select stock-filter" aria-label="按桶袋筛选" value={filter} onChange={e => setFilter(e.target.value as ContainerType | '')}>
            <option value="">全部桶袋</option>
            {containers.map(c => <option key={c.containerType} value={c.containerType}>{containerLabel(c.containerType)}</option>)}
          </select>
        </div>
        <div className="inventory-table-scroll">
          <table className="stock-history">
            <thead><tr><th>时间</th><th>桶袋</th><th>改了什么</th><th>备注</th><th>经办人</th></tr></thead>
            <tbody>
              {history.error ? <EmptyRow colSpan={5}>{history.error}</EmptyRow>
                : !history.data ? <EmptyRow colSpan={5}>正在加载…</EmptyRow>
                : !history.data.length ? <EmptyRow colSpan={5}>还没有修改记录，点上面的数字就能改</EmptyRow>
                : history.data.map(({ operation: o, memberName }) => (
                  <tr key={o.id}>
                    <td>{shortDateTime(o.createdAt)}<br /><small title={o.operationNo}>{o.operationNo.slice(0, 10)}</small></td>
                    <td>{containerLabel(o.containerType)}</td>
                    <td><OperationChanges operation={o} /></td>
                    <td className="inventory-reason">{memberName && <><b>{memberName}</b><br /></>}{['修改数量', '盘点'].includes(o.reason) ? <span className="stock-muted">—</span> : o.reason}</td>
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

/** One container: three numbers that open the edit dialog, the total, and member returns still waiting for a scrap decision. */
function StockCard({ c, onEdit }: { c: ContainerSummaryItem; onEdit?: (focus: Count) => void }) {
  const go = useGo();
  const bag = containerKind(c.containerType) === 'BAG';
  const unregistered = c.withCustomersQty - c.memberHeldQty;
  const customersNote = unregistered === 0 ? '都登记在会员名下' : unregistered > 0 ? `会员名下 ${c.memberHeldQty}，另有 ${unregistered} 个没登记` : `会员名下登记了 ${c.memberHeldQty} 个`;
  return (
    <article className="stock-card">
      <header className="stock-card-head">
        <span className={`stock-icon${bag ? ' bag' : ''}`}><Icon name="drop" /></span>
        <div className="stock-title">
          <h3>{containerLabel(c.containerType)}</h3>
          <small>押金 ¥{money(c.unitDeposit)} / 个{c.countedAt && ` · 上次修改 ${shortDateTime(c.countedAt)}`}</small>
        </div>
        {c.lowStockWarning && <span className="tag orange dot">店里偏少</span>}
      </header>
      <div className="stock-tiles">
        <Tile label="店里" value={c.inStationQty} note={c.warnThreshold > 0 ? `少于 ${c.warnThreshold} 个时提醒` : '空的满的都算'} tone={c.lowStockWarning ? 'warn' : 'store'} onEdit={onEdit && (() => onEdit('inStationQty'))} />
        <Tile label="客户手里" value={c.withCustomersQty} note={customersNote} onEdit={onEdit && (() => onEdit('withCustomersQty'))} />
        <Tile label="已报废" value={c.scrappedQty} note="累计，不算在合计里" tone="scrapped" onEdit={onEdit && (() => onEdit('scrappedQty'))} />
      </div>
      <footer className="stock-card-foot">
        <span className="stock-sum">合计 <b>{c.totalQty}</b> 个<small>店里 + 客户手里{c.damagedQty > 0 ? ' + 待确认报废' : ''}</small></span>
        {onEdit && <button type="button" className="btn primary sm" onClick={() => onEdit('inStationQty')}><Icon name="edit" size="sm" />修改数量</button>}
      </footer>
      {c.damagedQty > 0 && (
        <button type="button" className="stock-pending" onClick={() => go('assets')}>
          <Icon name="info" size="sm" /><span>会员退回 <b>{c.damagedQty}</b> 个破损，还没确认报废</span><em>去台账处理 ›</em>
        </button>
      )}
    </article>
  );
}

function Tile({ label, value, note, tone, onEdit }: { label: string; value: number; note: string; tone?: 'store' | 'warn' | 'scrapped'; onEdit?: () => void }) {
  const content = <>
    <span className="stock-tile-label">{label}{onEdit && <Icon name="edit" size="sm" />}</span>
    <span className="stock-tile-value">{value}<small>个</small></span>
    <span className="stock-tile-note" title={note}>{note}</span>
  </>;
  const className = `stock-tile${tone ? ` ${tone}` : ''}`;
  return onEdit
    ? <button type="button" className={className} aria-label={`修改${label}的数量，现在 ${value} 个`} onClick={onEdit}>{content}</button>
    : <div className={className}>{content}</div>;
}

const FIELDS: Array<[string, (b: InventoryBalance) => number]> = [
  ['店里', b => b.inStationQty], ['客户手里', customersOf], ['待确认报废', b => b.damagedQty], ['已报废', b => b.scrappedQty],
];
const TAGS = { ADJUST: ['修改', 'blue'], COUNT: ['盘点', 'gray'], RECEIVE: ['入库', 'green'], SCRAP: ['报废', 'orange'] } as const;

/** Every record, old stock-takes included, reads as "店里 198 → 196" for each number that changed. */
function OperationChanges({ operation: o }: { operation: InventoryOperation }) {
  const [label, tone] = o.action === 'SCRAP' && o.sourceState === 'DAMAGED' ? ['会员破损报废', 'orange'] : TAGS[o.action] ?? TAGS.ADJUST;
  const changed = FIELDS.flatMap(([name, get]) => get(o.before) === get(o.after) ? [] : [{ name, from: get(o.before), to: get(o.after) }]);
  if (o.warnThreshold) changed.push({ name: '提醒线', from: o.warnThreshold.before, to: o.warnThreshold.after });
  return (
    <div className="stock-changes">
      <span className={`tag ${tone}`}>{label}</span>
      {changed.length ? changed.map(x => <span key={x.name} className="stock-change">{x.name} <b>{x.from} → {x.to}</b></span>) : <span className="stock-muted">数量没变</span>}
    </div>
  );
}

/** 修改数量：三个数都预先填好现在的值，改哪个填哪个；只把改过的数发给后台，其他的不动。 */
function StockDialog({ config: c, focus, onClose, onDone }: { config: ContainerSummaryItem; focus: Count; onClose: () => void; onDone: () => Promise<void> }) {
  const api = useApi();
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
    await onDone();
    toast(`${containerLabel(c.containerType)}的数量已更新`);
  };

  return (
    <FormDialog title="修改数量" description={containerLabel(c.containerType)} className="stock-dialog" submitLabel="保存" onClose={onClose} onSubmit={submit}
      extraActions={<>
        <span className="stock-dialog-total">合计 {total === c.totalQty ? <b>{total}</b> : <><s>{c.totalQty}</s> → <b>{total}</b></>} 个</span>
        <button type="button" className="btn" onClick={onClose}>取消</button>
      </>}>
      <p className="stock-dialog-lead">直接填现在的数量，没变的不用动。</p>
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
        <input id="stockThreshold" className="input" type="number" inputMode="numeric" min={0} max={MAX} step={1} required value={threshold}
          onChange={e => setThreshold(Math.min(MAX, Math.max(0, Math.trunc(Number(e.target.value)) || 0)))} />
        <span>个时在菜单上提醒（填 0 不提醒）</span>
      </div>
      <label htmlFor="stockNote">备注（选填）</label>
      <input id="stockNote" className="input" maxLength={500} placeholder="如：新买了 20 个" value={note} onChange={e => setNote(e.target.value)} />
      <ReasonChips label="常用备注" options={['新买了一批', '核对实际数量', `${unit}坏了报废`, `会员还${unit}没登记`]} value={note} onPick={setNote} />
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
