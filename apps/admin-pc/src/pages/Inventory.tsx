import { useState } from 'react';
import { KUNLUN_PERMISSIONS as P, money, type ContainerSummaryItem, type ContainerType, type InventoryAction } from '@kunlun/shared';
import { Field, FormDialog, ReasonChips, useApi, useAuth, useDialogs, useIdempotencyKey, useLoader, useRun, useToast } from '@kunlun/ui';
import { EmptyRow, useExport } from '../common';
import { useAdminData } from '../data';

export const CONTAINER_NAMES: Record<ContainerType, string> = { BAG: '周转水袋', BUCKET: '周转桶' };
/** Common ways a bucket or bag gets damaged, offered as one-tap reasons when registering damage or scrapping. */
export const DAMAGE_REASONS: Record<ContainerType, readonly string[]> = {
  BUCKET: ['桶身开裂漏水', '桶口破损', '提手断裂', '磕碰变形', '污染异味无法清洗', '自然老化'],
  BAG: ['袋体破损漏水', '袋口/阀门损坏', '封口不严', '污染无法清洗', '自然老化'],
};

export function Inventory() {
  const { containers, version, refresh } = useAdminData();
  const { api, can } = useAuth();
  const dialogs = useDialogs();
  const run = useRun();
  const exportCsv = useExport();
  const permitted = can(P.ContainerInventoryManage);
  const history = useLoader(() => permitted ? api.inventoryOperations() : Promise.resolve([]), [api, permitted, version]);
  const stock = (c: ContainerSummaryItem, action: InventoryAction) =>
    run(() => dialogs.open(close => <StockDialog config={c} action={action} onClose={close} onDone={async () => { await refresh(); await history.reload(); }} />))();

  return <>
    <div className="page-head"><div><h2>袋桶库存</h2><p>管理水袋、周转桶的入库与报废</p></div></div>
    <div className="table-card">
      <div className="table-toolbar"><div><b>袋桶库存</b><small>入库计入门店可用，报废从门店可用扣减</small></div></div>
      <div className="inventory-table-scroll">
        <table>
          <thead><tr><th>容器</th><th>现存总量</th><th>门店可用</th><th>会员持有</th><th>待报废</th><th>累计报废</th><th>操作</th></tr></thead>
          <tbody>
            {containers.length === 0 ? <EmptyRow colSpan={7}>正在加载库存…</EmptyRow> : containers.map(c => (
              <tr key={c.containerType}>
                <td><b>{CONTAINER_NAMES[c.containerType]}</b><br /><small>押金 ¥{money(c.unitDeposit)} / 个</small></td>
                <td><b>{c.totalQty}</b></td>
                <td>{c.inStationQty}</td>
                <td>{c.memberHeldQty}</td>
                <td>{c.damagedQty}</td>
                <td>{c.scrappedQty}</td>
                <td><div className="container-row-actions">
                  <button type="button" className="text-btn" disabled={!permitted} onClick={() => stock(c, 'RECEIVE')}>入库</button>
                  <button type="button" className="text-btn danger" disabled={!permitted || c.inStationQty === 0} onClick={() => stock(c, 'SCRAP')}>报废</button>
                </div></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
    <p className="membership-note">现存总量 = 门店可用 + 会员持有 + 待报废，不含累计报废。待报废是会员归还的破损袋桶，请在「袋桶台账」确认报废并扣押金。</p>
    {permitted && (
      <div className="table-card">
        <div className="table-toolbar">
          <div><b>入库与报废记录</b><small>最近 100 笔，包含会员报废联动记录</small></div>
          <button type="button" className="btn sm" onClick={() => exportCsv('inventory-operations')}>导出全部记录</button>
        </div>
        <div className="inventory-table-scroll">
          <table>
            <thead><tr><th>时间 / 单号</th><th>容器</th><th>业务</th><th>数量</th><th>现存总量</th><th>关联会员 / 原因</th><th>操作人</th></tr></thead>
            <tbody>
              {history.error ? <EmptyRow colSpan={7}>{history.error}</EmptyRow>
                : !history.data?.length ? <EmptyRow colSpan={7}>{history.data ? '暂无入库或报废记录' : '正在加载…'}</EmptyRow>
                : history.data.map(({ operation: o, memberName }) => (
                  <tr key={o.id}>
                    <td>{new Date(o.createdAt).toLocaleString('zh-CN', { hour12: false })}<br /><small>{o.operationNo}</small></td>
                    <td>{CONTAINER_NAMES[o.containerType]}</td>
                    <td><span className={`tag ${o.action === 'RECEIVE' ? 'green' : 'orange'}`}>{o.action === 'RECEIVE' ? '入库' : '报废'}</span></td>
                    <td>{o.action === 'RECEIVE' ? '+' : '−'}{o.quantity}</td>
                    <td>{o.before.totalQty} → {o.after.totalQty}</td>
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

function StockDialog({ config, action, onClose, onDone }: { config: ContainerSummaryItem; action: InventoryAction; onClose: () => void; onDone: () => Promise<void> }) {
  const api = useApi();
  const toast = useToast();
  const key = useIdempotencyKey();
  const scrap = action === 'SCRAP';
  const [quantity, setQuantity] = useState(1);
  const [reason, setReason] = useState('');
  const submit = async () => {
    await api.inventory({ containerType: config.containerType, action, quantity, reason: reason.trim(), idempotencyKey: key });
    await onDone();
    toast(scrap ? '已报废，库存已扣减' : '入库成功');
  };
  return (
    <FormDialog title={`${CONTAINER_NAMES[config.containerType]} · ${scrap ? '报废' : '入库'}`} className="inventory-dialog" submitLabel={scrap ? '确认报废' : '确认入库'} onClose={onClose} onSubmit={submit}>
      <div className="membership-summary">{scrap ? <>从门店可用中报废，当前门店可用 <b>{config.inStationQty}</b> 个。</> : '新购入的袋桶计入门店可用。'}</div>
      <Field label="数量（个）" htmlFor="stockQty">
        <input id="stockQty" className="input" type="number" min={1} max={scrap ? config.inStationQty : 1000000} step={1} required value={quantity} onChange={e => setQuantity(Number(e.target.value))} />
      </Field>
      <ReasonField value={reason} onChange={setReason} placeholder={scrap ? '如：破损、老化无法使用' : '如：采购批次、供应商'} />
      {scrap && <ReasonChips options={[...DAMAGE_REASONS[config.containerType], '盘点报损']} value={reason} onPick={setReason} />}
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
