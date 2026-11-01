import { useState } from 'react';
import { containerUnit, money, type ContainerSummaryItem, type ContainerType, type WaterProduct } from '@kunlun/shared';
import { ConfirmDialog, Field, FormDialog, Icon, useApi, useDialogs, useRun, useToast } from '@kunlun/ui';
import { useAdminData } from '../data';

const CONTAINERS: Record<ContainerType, string> = { BUCKET: '周转桶', BAG: '周转水袋' };

export function Products() {
  const { products, containers, loaded, refresh } = useAdminData();
  const api = useApi();
  const dialogs = useDialogs();
  const run = useRun();
  const toast = useToast();
  const edit = (product?: WaterProduct) => dialogs.open(close => <ProductDialog product={product} onClose={close} onDone={refresh} />);
  const remove = (p: WaterProduct) => run(async () => {
    const deleted = await dialogs.open<boolean>(close => <ConfirmDialog title="删除水品" confirmLabel="确认删除" onClose={close}
      message={<>确定删除 <b>{p.name}</b> 吗？只有还没建过充值套餐、没有水票和水单的水品才能删除，例如刚才加错的水品。</>}
      onConfirm={() => api.deleteProduct(p.waterType).then(() => undefined)} />);
    if (!deleted) return;
    await refresh();
    toast(`已删除水品 ${p.name}`);
  })();
  return <>
    <div className="page-head">
      <div><h2>水品与押金标准</h2><p>维护在售水品和桶袋押金；每种水品的水票单独计算，不能互相抵用</p></div>
      <div className="head-actions"><button type="button" className="btn primary" onClick={() => edit()}><Icon name="plus" />新增水品</button></div>
    </div>
    <h3 className="product-section-title">押金标准</h3>
    <div className="product-config-grid">
      {(['BUCKET', 'BAG'] as const).map(type => {
        const deposit = containers.find(c => c.containerType === type);
        const users = products.filter(p => p.containerType === type).map(p => p.name);
        return (
          <article key={type} className="setting-card">
            <div className="product-deposit-summary">
              <div><small>{CONTAINERS[type]}押金</small><strong>{deposit ? <>¥{money(deposit.unitDeposit)} <span>/ 个</span></> : '未设置'}</strong></div>
              <button type="button" className="btn sm" disabled={!deposit} onClick={() => deposit && dialogs.open(close => <DepositPriceDialog config={deposit} onClose={close} onDone={refresh} />)}>修改押金</button>
            </div>
            <p className="product-deposit-note">{users.length ? `用于：${users.join('、')}。` : '暂无水品使用。'}押金单价修改仅影响新收押金，历史押金按原收款单价退款。</p>
          </article>
        );
      })}
    </div>
    <h3 className="product-section-title">水品</h3>
    <div className="product-config-grid">
      {!loaded ? <p>正在加载…</p> : products.length === 0 ? <p>还没有水品，请先新增水品。</p> : products.map(p => {
        const unit = containerUnit(p.containerType);
        return (
          <article key={p.waterType} className="setting-card product-config-card">
            <div className="product-config-heading">
              <h3>{p.name}</h3>
              <div className="head-actions">
                <button type="button" className="btn sm" aria-label={`编辑水品 ${p.name}`} onClick={() => edit(p)}>编辑水品</button>
                <button type="button" className="btn sm" aria-label={`删除水品 ${p.name}`} onClick={() => remove(p)}>删除</button>
              </div>
            </div>
            <div className="setting-row"><span>用什么装</span><b>{CONTAINERS[p.containerType]}（押金按{unit}收）</b></div>
            <div className="setting-row"><span>规格</span><b>{p.capacityLiters} 升 / {unit}</b></div>
            <div className="setting-row"><span>包装</span><b>{p.packaging}</b></div>
            <div className="setting-row"><span>零售价</span><b>{p.retailPrice == null ? '未设置' : `¥${money(p.retailPrice)} / ${unit}`}</b></div>
            <div className="setting-row"><span>配送要求</span><b>{p.deliveryMinimum}{unit}起送 · {p.deliveryFee === 0 ? '免费' : `配送费 ¥${money(p.deliveryFee)}`}</b></div>
          </article>
        );
      })}
    </div>
  </>;
}

function ProductDialog({ product: p, onClose, onDone }: { product?: WaterProduct; onClose: () => void; onDone: () => Promise<void> }) {
  const api = useApi();
  const toast = useToast();
  const [name, setName] = useState(p?.name ?? '');
  const [container, setContainer] = useState<ContainerType | null>(p?.containerType ?? null);
  const [capacity, setCapacity] = useState(p ? String(p.capacityLiters) : '');
  const [packaging, setPackaging] = useState(p?.packaging ?? '');
  const [retail, setRetail] = useState(p?.retailPrice == null ? '' : String(p.retailPrice));
  const [minimum, setMinimum] = useState(String(p?.deliveryMinimum ?? 1));
  const unit = container ? containerUnit(container) : '份';
  return (
    <FormDialog title={p ? '编辑水品资料' : '新增水品'} submitLabel={p ? '保存' : '添加水品'} onClose={onClose} onSubmit={async () => {
      const body = { name, capacityLiters: Number(capacity), packaging, retailPrice: retail === '' ? null : Number(retail), deliveryMinimum: Number(minimum) };
      if (p) await api.updateProduct(p.waterType, body);
      else if (!container) throw new Error('请选择这种水用周转桶还是周转水袋装');
      else await api.createProduct({ ...body, containerType: container });
      await onDone();
      toast(p ? '水品资料已保存' : `已添加水品 ${name.trim()}`);
    }}>
      <Field label="水品名称" htmlFor="productName"><input id="productName" className="input" required maxLength={80} placeholder="例如 18.9L 矿泉水" value={name} onChange={e => setName(e.target.value)} /></Field>
      {p ? <p className="membership-note">用什么装：{CONTAINERS[p.containerType]}（添加后不能修改）</p> : <>
        <label id="productContainerLabel">用什么装（决定收哪种押金、算哪种桶袋库存，添加后不能修改）</label>
        <div className="choice-row" role="group" aria-labelledby="productContainerLabel">
          {(['BUCKET', 'BAG'] as const).map(type => (
            <button key={type} type="button" className={`choice${container === type ? ' active' : ''}`} aria-pressed={container === type} onClick={() => setContainer(type)}>
              {CONTAINERS[type]}<small>按{containerUnit(type)}计，收{CONTAINERS[type]}押金</small>
            </button>
          ))}
        </div>
      </>}
      <Field label={`每${unit}容量（升）`} htmlFor="productCapacity"><input id="productCapacity" className="input" type="number" required min={0.01} max={1000} step={0.01} value={capacity} onChange={e => setCapacity(e.target.value)} /></Field>
      <Field label="包装说明" htmlFor="productPackaging"><input id="productPackaging" className="input" required maxLength={80} value={packaging} onChange={e => setPackaging(e.target.value)} /></Field>
      <Field label="零售价（元；留空表示未设置）" htmlFor="productRetail"><input id="productRetail" className="input" type="number" min={0.01} max={99999999} step={0.01} value={retail} onChange={e => setRetail(e.target.value)} /></Field>
      <Field label="配送起送数量" htmlFor="productMinimum"><input id="productMinimum" className="input" type="number" required min={1} max={10000} step={1} value={minimum} onChange={e => setMinimum(e.target.value)} /></Field>
      <p className="membership-note">{p
        ? '修改用于后续业务和新导出的价目表，历史单据保留原有快照。'
        : '添加后到「充值套餐」为它建套餐。它的水票单独计算，不能和其他水品互相抵用。'}</p>
    </FormDialog>
  );
}

function DepositPriceDialog({ config, onClose, onDone }: { config: ContainerSummaryItem; onClose: () => void; onDone: () => Promise<void> }) {
  const api = useApi();
  const toast = useToast();
  const [value, setValue] = useState(String(config.unitDeposit));
  return (
    <FormDialog title="修改桶袋押金" onClose={onClose} onSubmit={async () => {
      await api.updateUnitDeposit(config.containerType, Number(value));
      await onDone();
      toast('押金标准已保存');
    }}>
      <Field label="新收押金单价（元/个）" htmlFor="unitDeposit"><input id="unitDeposit" className="input" type="number" required min={0.01} step={0.01} value={value} onChange={e => setValue(e.target.value)} /></Field>
      <p className="membership-note">只影响新收押金；历史押金仍按原收款单价退款。</p>
    </FormDialog>
  );
}
