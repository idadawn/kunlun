import { useEffect, useState } from 'react';
import {
  KUNLUN_PERMISSIONS as P, containerLabel, money, shortDateTime,
  type ContainerSummaryItem, type ContainerType, type InventoryAction, type InventoryBalance, type InventorySource, type MemberProfile,
} from '@kunlun/shared';
import { Dialog, Field, FormDialog, Icon, saveBlob, useApi, useAuth, useDialogs, useIdempotencyKey, useLoader, useRun, useToast } from '@kunlun/ui';
import { EmptyRow, useExport, useOperations } from '../common';
import { useAdminData } from '../data';

const NAMES: Record<ContainerType, string> = { BUCKET: '周转桶', BAG: '周转水袋' };
const ACTIONS: Record<InventoryAction, string> = { RECEIVE: '采购入库', DAMAGE: '破损登记', REPAIR: '修复入库', SCRAP: '确认报废', COUNT: '库存盘点' };
const SOURCES: Record<InventorySource, string> = { AVAILABLE: '门店可用', TRANSIT: '配送在途', INSPECTING: '待检', ABNORMAL: '异常待处理', MEMBER: '会员归还（破损）', DAMAGED: '破损待处理', EXTERNAL: '外部入库' };
const COLUMNS: Partial<Record<InventorySource, keyof InventoryBalance>> = { AVAILABLE: 'inStationQty', TRANSIT: 'inTransitQty', INSPECTING: 'inspectingQty', ABNORMAL: 'abnormalQty', MEMBER: 'memberHeldQty', DAMAGED: 'damagedQty' };

export function Assets() {
  const { containers, containerLedgers, version, refresh } = useAdminData();
  const { api, can } = useAuth();
  const dialogs = useDialogs();
  const toast = useToast();
  const run = useRun();
  const ops = useOperations();
  const exportCsv = useExport();
  const permitted = can(P.ContainerInventoryManage);
  const [historyFilter, setHistoryFilter] = useState<ContainerType | ''>('');
  const [movementFilter, setMovementFilter] = useState<ContainerType | ''>('');
  const history = useLoader(() => permitted ? api.inventoryOperations(historyFilter || undefined) : Promise.resolve([]), [api, permitted, historyFilter, version]);
  const movements = containerLedgers.filter(c => !movementFilter || c.containerType === movementFilter);

  const manage = (type: ContainerType) => run(() => dialogs.open(close => <InventoryDialog type={type} onClose={close} onDone={async () => { await refresh(); await history.reload(); }} />))();
  const exportOperations = run(async () => {
    saveBlob(await api.exportCsv('inventory-operations'), '桶袋库存维护流水.csv');
    toast('报表已导出');
  });

  return <>
    <div className="page-head">
      <div><h2>桶袋台账</h2><p>管理周转桶、水袋的库存、领还、破损和报废</p></div>
      <div className="head-actions">
        <button type="button" className="btn" onClick={() => exportCsv('container-ledgers')}><Icon name="export" />导出台账</button>
        <button type="button" className="btn primary" onClick={() => ops.movement()}><Icon name="plus" />独立登记领还</button>
      </div>
    </div>
    <div className="inventory-grid">
      {containers.length === 0 ? <p>正在加载库存…</p> : containers.map(c => <InventoryCard key={c.containerType} c={c} permitted={permitted} onManage={() => manage(c.containerType)} />)}
    </div>
    {permitted && (
      <div className="table-card inventory-ledger">
        <div className="table-toolbar">
          <div><b>库存维护流水</b><small>最近 100 笔 · 入库、破损、修复、报废与盘点</small></div>
          <div className="membership-actions">
            <select className="select" aria-label="库存流水容器类型" value={historyFilter} onChange={e => setHistoryFilter(e.target.value as ContainerType | '')}>
              <option value="">全部容器</option><option value="BUCKET">周转桶</option><option value="BAG">周转水袋</option>
            </select>
            <button type="button" className="btn sm" onClick={exportOperations}>导出全部流水</button>
          </div>
        </div>
        <div className="inventory-table-scroll">
          <table>
            <thead><tr><th>时间 / 单号</th><th>容器</th><th>业务</th><th>数量</th><th>位置变化</th><th>原因 / 关联会员</th><th>操作人</th></tr></thead>
            <tbody>
              {history.error ? <EmptyRow colSpan={7}>{history.error}</EmptyRow> : !history.data?.length ? <tr><td colSpan={7} className="inventory-empty">{history.data ? '暂无库存维护记录' : '正在加载…'}</td></tr>
                : history.data.map(({ operation: o, memberName }) => {
                  const source = o.action === 'RECEIVE' ? 'AVAILABLE' : o.sourceState;
                  const col = COLUMNS[source] ?? 'inStationQty';
                  return (
                    <tr key={o.id}>
                      <td>{new Date(o.createdAt).toLocaleString('zh-CN')}<br /><small>{o.operationNo}</small></td>
                      <td>{NAMES[o.containerType]}</td>
                      <td>{ACTIONS[o.action]}</td>
                      <td>{o.action === 'COUNT' && o.quantity > 0 ? '+' : ''}{o.quantity}</td>
                      <td>{SOURCES[source]} {o.before[col]} → {o.after[col]}<br /><small>总量 {o.before.totalQty} → {o.after.totalQty}{o.action === 'DAMAGE' ? ` · 破损 ${o.before.damagedQty} → ${o.after.damagedQty}` : ''}</small></td>
                      <td className="inventory-reason">{o.reason}{memberName && <><br /><small>{memberName}</small></>}</td>
                      <td>{o.operatorName}</td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      </div>
    )}
    <div className="table-card" style={{ marginTop: 20 }}>
      <div className="table-toolbar">
        <div><b>容器领还流水</b><small>满桶出库（领出 N）与空桶回库（收回 M）独立留痕</small></div>
        <select className="select" aria-label="领还流水容器类型" value={movementFilter} onChange={e => setMovementFilter(e.target.value as ContainerType | '')}>
          <option value="">全部容器</option><option value="BUCKET">15L 周转桶</option><option value="BAG">5L 周转水袋</option>
        </select>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table>
          <thead><tr><th>流水单号 / 时间</th><th>会员</th><th>关联单号</th><th>容器类型</th><th>满桶领出 (N)</th><th>空桶收回 (M)</th><th>持有变化 (N−M)</th><th>操作人</th></tr></thead>
          <tbody>
            {movements.length === 0 ? <EmptyRow colSpan={8}>暂无容器流转流水，可通过「水单交付」或右上角「独立登记领还」产生记录</EmptyRow> : movements.map(c => (
              <tr key={c.ledgerNo}>
                <td><span className="order-no">{c.ledgerNo}</span><br /><small style={{ color: 'var(--muted)' }}>{shortDateTime(c.createdAt)}</small></td>
                <td><b>{c.memberName}</b></td>
                <td>{c.orderNo}</td>
                <td>{containerLabel(c.containerType)}</td>
                <td><b>{c.fullOutQty}</b></td>
                <td><b>{c.emptyInQty}</b></td>
                <td>{c.deltaHeld === 0 ? <span className="tag green">0（等量换水）</span> : c.deltaHeld > 0 ? <span className="tag orange">+{c.deltaHeld}（新增持有）</span> : <span className="tag aqua">{c.deltaHeld}（退回容器）</span>} (持有 {c.heldAfter})</td>
                <td>{c.operatorName}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  </>;
}

function InventoryCard({ c, permitted, onManage }: { c: ContainerSummaryItem; permitted: boolean; onManage: () => void }) {
  const metrics: Array<[string, number]> = [['门店可用', c.inStationQty], ['会员持有', c.memberHeldQty], ['在途', c.inTransitQty], ['待检', c.inspectingQty], ['异常', c.abnormalQty], ['破损待处理', c.damagedQty || 0]];
  return (
    <article className="inventory-card">
      <header>
        <div><h3>{NAMES[c.containerType]}</h3><small>可回收周转 · 押金 ¥{money(c.unitDeposit)} / 个</small></div>
        <span className={`tag ${c.identityValid ? 'green' : 'orange'}`}>{c.identityValid ? '台账平衡' : '需核对台账'}</span>
      </header>
      <div className="inventory-total"><span>现存总量</span><b>{c.totalQty}<small>个</small></b><button type="button" className="btn primary sm" disabled={!permitted} onClick={onManage}>维护数量</button></div>
      <div className="inventory-metrics">{metrics.map(([label, value]) => <div key={label} className={label === '破损待处理' ? 'inventory-damaged' : undefined}><span>{label}</span><b>{value}</b></div>)}</div>
      <footer><span>累计报废 <b>{c.scrappedQty || 0}</b> 个（不计入现存总量）</span><span>{c.lowStockWarning ? `可用库存低于预警值 ${c.warnThreshold}` : '可用库存正常'}</span></footer>
    </article>
  );
}

function InventoryDialog({ type: initialType, onClose, onDone }: { type: ContainerType; onClose: () => void; onDone: () => Promise<void> }) {
  const api = useApi();
  const toast = useToast();
  const key = useIdempotencyKey();
  const [data, setData] = useState<{ configs: ContainerSummaryItem[]; members: MemberProfile[] } | null>(null);
  const [error, setError] = useState('');
  const [type, setType] = useState(initialType);
  const [action, setAction] = useState<InventoryAction>('RECEIVE');
  const [source, setSource] = useState<InventorySource>('AVAILABLE');
  const [memberId, setMemberId] = useState('');
  const [quantity, setQuantity] = useState(1);
  const [reason, setReason] = useState('');

  useEffect(() => {
    Promise.all([api.containerSummary(), api.listMembers()]).then(([configs, members]) => setData({ configs, members })).catch(e => setError(e.message));
  }, [api]);

  if (!data) return <Dialog title="桶袋库存维护" onClose={onClose}>{error ? <p className="account-error" role="alert">{error}</p> : <p className="membership-note">正在加载库存…</p>}</Dialog>;
  const config = data.configs.find(c => c.containerType === type)!;
  const sourceQty = (s: InventorySource, c = config) => Number(c[COLUMNS[s] ?? 'inStationQty']) || 0;
  const choices: InventorySource[] = action === 'COUNT' ? ['AVAILABLE', 'INSPECTING', 'DAMAGED', 'ABNORMAL', 'TRANSIT'] : ['AVAILABLE', 'INSPECTING', 'ABNORMAL', 'TRANSIT', 'MEMBER'];
  const fromMember = action === 'DAMAGE' && source === 'MEMBER';

  const reset = (nextType: ContainerType, nextAction: InventoryAction) => {
    setType(nextType); setAction(nextAction); setSource('AVAILABLE');
    setQuantity(nextAction === 'COUNT' ? sourceQty('AVAILABLE', data.configs.find(c => c.containerType === nextType)!) : 1);
  };

  let preview = `现存 ${config.totalQty} 个 · 可用 ${config.inStationQty} 个 · 破损待处理 ${config.damagedQty || 0} 个。`;
  if (action === 'RECEIVE') preview += ` 本次入库 ${quantity} 个，可用和现存总量各增加 ${quantity} 个。`;
  else if (action === 'COUNT') { const delta = quantity - sourceQty(source); preview += ` ${SOURCES[source]}账面 ${sourceQty(source)} 个，实盘 ${quantity} 个，${delta > 0 ? '盘盈 ' + delta : delta < 0 ? '盘亏 ' + -delta : '账实一致'}。`; }
  else if (action === 'DAMAGE') {
    const m = data.members.find(x => x.id === memberId);
    const available = fromMember ? (m ? (type === 'BUCKET' ? m.heldBuckets : m.heldBags) : '—') : sourceQty(source);
    preview += ` 来源当前 ${available} 个，本次 ${quantity} 个转入破损待处理，现存总量不变。`;
  } else if (action === 'REPAIR') preview += ` 修复 ${quantity} 个后转回可用库存，现存总量不变。`;
  else preview += ` 报废 ${quantity} 个，现存总量减少 ${quantity} 个，累计报废增加 ${quantity} 个。`;
  const note = action === 'COUNT' ? '提交时核对账面数量；库存已变化时需重新打开并盘点。'
    : fromMember ? '确认实物已收回后登记；会员持有会减少，押金和赔偿另行结算。' : '库存操作不自动改变水票或押金余额，每笔保留操作记录。';

  const submit = async () => {
    const result = await api.inventory({
      containerType: type, action, reason: reason.trim(), idempotencyKey: key,
      quantity: action === 'COUNT' ? 0 : quantity,
      sourceState: action === 'DAMAGE' || action === 'COUNT' ? source : 'AVAILABLE',
      memberId: fromMember ? memberId || null : null,
      countedQuantity: action === 'COUNT' ? quantity : null,
      expectedQuantity: action === 'COUNT' ? sourceQty(source) : null,
    });
    await onDone();
    toast(`${ACTIONS[action]}已登记：${result.operationNo}`);
  };

  return (
    <FormDialog title="桶袋库存维护" className="inventory-dialog" submitLabel={action === 'SCRAP' ? '确认报废' : action === 'COUNT' ? '确认盘点' : '确认登记'} onClose={onClose} onSubmit={submit}>
      <Field label="容器类型" htmlFor="inventoryType">
        <select id="inventoryType" className="select" value={type} onChange={e => reset(e.target.value as ContainerType, action)}>
          {Object.entries(NAMES).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
      </Field>
      <Field label="业务类型" htmlFor="inventoryAction">
        <select id="inventoryAction" className="select" value={action} onChange={e => reset(type, e.target.value as InventoryAction)}>
          {Object.entries(ACTIONS).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
      </Field>
      {(action === 'DAMAGE' || action === 'COUNT') && (
        <div className="inventory-field">
          <label htmlFor="inventorySource">{action === 'COUNT' ? '盘点位置' : '来源位置'}</label>
          <select id="inventorySource" className="select" value={source} onChange={e => { const s = e.target.value as InventorySource; setSource(s); if (action === 'COUNT') setQuantity(sourceQty(s)); }}>
            {choices.map(s => <option key={s} value={s}>{SOURCES[s]}</option>)}
          </select>
        </div>
      )}
      {fromMember && (
        <div className="inventory-field">
          <label htmlFor="inventoryMember">已归还破损容器的会员</label>
          <select id="inventoryMember" className="select" required value={memberId} onChange={e => setMemberId(e.target.value)}>
            <option value="">请选择会员</option>
            {data.members.map(m => <option key={m.id} value={m.id}>{m.name} · {m.memberNo}</option>)}
          </select>
        </div>
      )}
      <Field label={action === 'COUNT' ? '实盘数量' : '操作数量'} htmlFor="inventoryQuantity">
        <input id="inventoryQuantity" className="input" type="number" min={action === 'COUNT' ? 0 : 1} max={1000000} step={1} required value={quantity} onChange={e => setQuantity(Number(e.target.value))} />
      </Field>
      <div className="membership-summary">{preview}</div>
      <Field label="原因 / 备注" htmlFor="inventoryReason">
        <textarea id="inventoryReason" className="input" rows={3} maxLength={500} required placeholder="填写入库来源、破损原因、报废依据或盘点说明" value={reason} onChange={e => setReason(e.target.value)} />
      </Field>
      <p className="membership-note">{note}</p>
    </FormDialog>
  );
}
