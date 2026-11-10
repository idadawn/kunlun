import { useState } from 'react';
import { containerUnit, money, type ContainerKind, type WaterProduct } from '@kunlun/shared';
import { ConfirmDialog, Field, FormDialog, Icon, useApi, useDialogs, useRun, useToast } from '@kunlun/ui';
import { useAdminData } from '../data';

const CONTAINERS: Record<ContainerKind, string> = { BUCKET: '周转桶', BAG: '周转水袋' };

export function Products() {
  const { products, loaded, refresh } = useAdminData();
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
      <div><h2>水品与押金标准</h2><p>每种水品配套自己的桶或袋，水票、押金和库存分别记账</p></div>
      <div className="head-actions"><button type="button" className="btn primary" onClick={() => edit()}><Icon name="plus" />新增水品</button></div>
    </div>
    <div className="product-config-grid">
      {!loaded ? <p>正在加载…</p> : products.length === 0 ? <p>还没有水品，请先新增水品。</p> : products.map(p => {
        const unit = containerUnit(p.containerType);
        return (
          <article key={p.waterType} className="setting-card product-config-card">
            <div className="product-config-heading">
              <h3>{p.name}</h3>
              <div className="head-actions">
                <button type="button" className="btn sm" aria-label={`编辑水品 ${p.name}`} onClick={() => edit(p)}>编辑水品与押金</button>
                <button type="button" className="btn sm" aria-label={`删除水品 ${p.name}`} onClick={() => remove(p)}>删除</button>
              </div>
            </div>
            <div className="product-matched-content"><div>
            <div className="setting-row"><span>配套容器</span><b>{CONTAINERS[p.containerType]}（押金按{unit}收）</b></div>
            <div className="setting-row"><span>规格</span><b>{p.capacityLiters} 升 / {unit}</b></div>
            <div className="setting-row"><span>包装</span><b>{p.packaging}</b></div>
            <div className="setting-row"><span>零售价</span><b>{p.retailPrice == null ? '未设置' : `¥${money(p.retailPrice)} / ${unit}`}</b></div>
            <div className="setting-row"><span>配送要求</span><b>{p.deliveryMinimum}{unit}起送 · {p.deliveryFee === 0 ? '免费' : `配送费 ¥${money(p.deliveryFee)}`}</b></div>
            </div><div className="product-container-account">
              <small>{p.capacityLiters}L {CONTAINERS[p.containerType]} · 仅供本水品使用</small>
              <strong>¥{money(p.unitDeposit)} <span>/ 个</span></strong>
              <p>新收押金标准</p>
              <p className="product-deposit-note">独立库存、领还和押金账户。历史押金按原实收单价退还。</p>
            </div></div>
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
  const [container, setContainer] = useState<ContainerKind | null>(p?.containerType ?? null);
  const [capacity, setCapacity] = useState(p ? String(p.capacityLiters) : '');
  const [packaging, setPackaging] = useState(p?.packaging ?? '');
  const [retail, setRetail] = useState(p?.retailPrice == null ? '' : String(p.retailPrice));
  const [deposit, setDeposit] = useState(p ? String(p.unitDeposit) : '');
  const [minimum, setMinimum] = useState(String(p?.deliveryMinimum ?? 1));
  const unit = container ? containerUnit(container) : '份';
  return (
    <FormDialog title={p ? '编辑水品与配套押金' : '新增水品与配套桶袋'} submitLabel={p ? '保存' : '添加水品'} onClose={onClose} onSubmit={async () => {
      const body = { name, capacityLiters: Number(capacity), packaging, retailPrice: retail === '' ? null : Number(retail), deliveryMinimum: Number(minimum), unitDeposit: Number(deposit) };
      if (p) await api.updateProduct(p.waterType, body);
      else if (!container) throw new Error('请选择这种水用周转桶还是周转水袋装');
      else await api.createProduct({ ...body, containerType: container });
      await onDone();
      toast(p ? '水品资料已保存' : `已添加水品 ${name.trim()}`);
    }}>
      <Field label="水品名称" htmlFor="productName"><input id="productName" className="input" required maxLength={80} placeholder="例如 18.9L 矿泉水" value={name} onChange={e => setName(e.target.value)} /></Field>
      {p ? <p className="membership-note">用什么装：{CONTAINERS[p.containerType]}（添加后不能修改）</p> : <>
        <label id="productContainerLabel">配套容器类型（为本水品单独管理，添加后不能修改）</label>
        <div className="choice-row" role="group" aria-labelledby="productContainerLabel">
          {(['BUCKET', 'BAG'] as const).map(type => (
            <button key={type} type="button" className={`choice${container === type ? ' active' : ''}`} aria-pressed={container === type} onClick={() => setContainer(type)}>
              {CONTAINERS[type]}<small>按{containerUnit(type)}计，单独收押金、记库存</small>
            </button>
          ))}
        </div>
      </>}
      <Field label={`每${unit}容量（升）`} htmlFor="productCapacity"><input id="productCapacity" className="input" type="number" disabled={!!p} required min={0.01} max={1000} step={0.01} value={capacity} onChange={e => setCapacity(e.target.value)} /></Field>
      <Field label="包装说明" htmlFor="productPackaging"><input id="productPackaging" className="input" required maxLength={80} value={packaging} onChange={e => setPackaging(e.target.value)} /></Field>
      <Field label="配套桶袋押金（元/个）" htmlFor="productDeposit"><input id="productDeposit" className="input" type="number" required min={0.01} max={99999999} step={0.01} value={deposit} onChange={e => setDeposit(e.target.value)} /></Field>
      <Field label="零售价（元；留空表示未设置）" htmlFor="productRetail"><input id="productRetail" className="input" type="number" min={0.01} max={99999999} step={0.01} value={retail} onChange={e => setRetail(e.target.value)} /></Field>
      <Field label="配送起送数量" htmlFor="productMinimum"><input id="productMinimum" className="input" type="number" required min={1} max={10000} step={1} value={minimum} onChange={e => setMinimum(e.target.value)} /></Field>
      <p className="membership-note">{p
        ? '押金修改只影响本水品后续收款；历史押金按原收款单价退还。'
        : '配套桶袋库存从零开始，到「袋桶库存」登记入库，再到「充值套餐」建套餐。各水品的水票、桶袋和押金都不能互相抵用。'}</p>
    </FormDialog>
  );
}
