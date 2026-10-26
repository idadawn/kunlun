import { useState } from 'react';
import {
  KUNLUN_BRAND, buildPosterModel, modeLabel, money, renderPoster, unitOf,
  type ActiveStatus, type FulfillMode, type RechargePlan, type WaterType,
} from '@kunlun/shared';
import { Dialog, Field, FormDialog, Icon, useApi, useDialogs, useRun, useToast } from '@kunlun/ui';
import { useAdminData } from '../data';

const GROUP_ORDER: Array<[WaterType, FulfillMode]> = [['BAG_7_5L', 'PICKUP'], ['BUCKET_18_9L', 'PICKUP'], ['BAG_7_5L', 'DELIVERY'], ['BUCKET_18_9L', 'DELIVERY']];

export function Plans() {
  const { plans: all, products, refresh } = useAdminData();
  const api = useApi();
  const dialogs = useDialogs();
  const run = useRun();
  const [status, setStatus] = useState<ActiveStatus | 'ALL'>('ACTIVE');
  const [generating, setGenerating] = useState(false);
  const plans = all.filter(p => status === 'ALL' || p.status === status);
  const groups = GROUP_ORDER.map(([water, mode]) => ({
    water, mode, product: products.find(p => p.waterType === water),
    items: plans.filter(p => p.waterType === water && p.fulfillMode === mode).sort((a, b) => a.price - b.price || a.buyQty - b.buyQty),
  })).filter(g => g.items.length);
  const statusText = status === 'ACTIVE' ? '启用' : status === 'DISABLED' ? '停用' : '';
  const edit = (plan?: RechargePlan) => dialogs.open(close => <PlanDialog plan={plan} onClose={close} onDone={refresh} />);
  const poster = run(async () => {
    setGenerating(true);
    try {
      const [freshPlans, freshProducts] = await Promise.all([api.listPlans(), api.listProducts()]);
      await document.fonts.ready;
      const model = buildPosterModel({ plans: freshPlans, products: freshProducts, store: KUNLUN_BRAND.store });
      const canvas = renderPoster(model);
      void dialogs.open(close => <PosterDialog url={canvas.toDataURL('image/png')} size={`${canvas.width} × ${canvas.height}`} planCount={model.planCount} fileName={`${model.store}-价格表-${model.date}.png`} onClose={close} />);
    } finally { setGenerating(false); }
  });

  return <>
    <div className="page-head"><div><h2>充值套餐</h2><p>按水品与领取方式分组，清晰对比每档充值权益</p></div></div>
    <div id="plansContent">
      <div className="plan-toolbar">
        <div className="plan-status-control">
          <label htmlFor="planStatusFilter" className="plan-filter-label">套餐状态</label>
          <select className="select" id="planStatusFilter" value={status} onChange={e => setStatus(e.target.value as typeof status)}>
            <option value="ACTIVE">启用中</option><option value="DISABLED">已停用</option><option value="ALL">全部</option>
          </select>
        </div>
        <div className="plan-toolbar-actions">
          <button type="button" className="btn plan-poster-button" disabled={generating} aria-busy={generating} onClick={poster}>{generating ? '正在生成…' : <><Icon name="export" />生成价目表图片</>}</button>
          <button type="button" className="btn primary" onClick={() => edit()}><Icon name="plus" />新增套餐</button>
        </div>
      </div>
      <div className="plan-list-meta"><span>共 <b>{plans.length}</b> 个{statusText}套餐</span><span>{groups.length} 个水品与领取方式组合</span></div>
      <div className="plans-grid">
        {groups.length ? groups.map(g => {
          const delivery = g.mode === 'DELIVERY';
          const unit = unitOf(g.water);
          const rule = delivery ? `${g.product?.deliveryFee === 0 ? '免费配送' : `配送费 ¥${money(g.product?.deliveryFee ?? 0)}`} · ${g.product?.deliveryMinimum ?? 1}${unit}起送` : '到店领取 · 使用自提水票';
          return (
            <article key={`${g.water}:${g.mode}`} className={`plan-group ${delivery ? 'is-delivery' : 'is-pickup'}`} aria-label={`${g.product?.name ?? g.water} · ${modeLabel(g.mode)}`}>
              <header className="plan-group-head">
                <div className="plan-product-icon"><Icon name={g.water === 'BAG_7_5L' ? 'drop' : 'box'} /></div>
                <div className="plan-product-heading"><h3>{g.product?.name ?? g.water}</h3><p>{g.product?.packaging}</p></div>
                <span className="plan-mode">{delivery ? '送水上门' : '门店自提'}</span>
              </header>
              <div className="plan-group-columns"><span>充值金额</span><span>到账水票</span><span className="sr-only">操作</span></div>
              <div className="plan-options">
                {g.items.map(p => (
                  <div key={p.id} className={`plan-option${p.status === 'DISABLED' ? ' is-disabled' : ''}`}>
                    <div className="plan-price-value"><span className="currency">¥</span>{Number.isInteger(p.price) ? p.price : money(p.price)}</div>
                    <div className="plan-quota-value">{p.buyQty + p.giftQty}<span className="unit">{unit}</span></div>
                    <button type="button" className="plan-edit" aria-label={`编辑${p.name}`} title="编辑套餐" onClick={() => edit(p)}><Icon name="edit" /></button>
                    <div className="plan-option-meta">
                      <span className="plan-option-name" title={p.name}>{p.name}{p.giftQty ? ` · 含赠 ${p.giftQty}${unit}` : ''}</span>
                      <span className="plan-option-status">{p.status === 'ACTIVE' ? '启用' : '停用'}</span>
                    </div>
                  </div>
                ))}
              </div>
              <footer className="plan-group-foot"><Icon name={delivery ? 'truck' : 'store'} size="sm" /><span>{rule}</span></footer>
            </article>
          );
        }) : <div className="plan-empty">暂无对应套餐，可切换套餐状态查看。</div>}
      </div>
    </div>
  </>;
}

function PlanDialog({ plan, onClose, onDone }: { plan?: RechargePlan; onClose: () => void; onDone: () => Promise<void> }) {
  const api = useApi();
  const toast = useToast();
  const { products } = useAdminData();
  const [name, setName] = useState(plan?.name ?? '');
  const [water, setWater] = useState<WaterType>(plan?.waterType ?? products[0]?.waterType ?? 'BUCKET_18_9L');
  const [mode, setMode] = useState<FulfillMode>(plan?.fulfillMode ?? 'PICKUP');
  const [price, setPrice] = useState(String(plan?.price ?? 100));
  const [qty, setQty] = useState(String(plan?.buyQty ?? 16));
  const [status, setStatus] = useState<ActiveStatus>(plan?.status ?? 'ACTIVE');
  return (
    <FormDialog title={plan ? '修改充值套餐' : '新建充值套餐'} onClose={onClose} onSubmit={async () => {
      await api.savePlan(plan?.id ?? null, { name, waterType: water, fulfillMode: mode, price: Number(price), buyQty: Number(qty), giftQty: 0, status });
      await onDone();
      toast('套餐已保存');
    }}>
      <Field label="套餐名称" htmlFor="planName"><input id="planName" className="input" required maxLength={80} value={name} onChange={e => setName(e.target.value)} /></Field>
      <Field label="水品" htmlFor="planWater"><select id="planWater" className="select" value={water} onChange={e => setWater(e.target.value as WaterType)}>{products.map(p => <option key={p.waterType} value={p.waterType}>{p.name}</option>)}</select></Field>
      <Field label="领取方式" htmlFor="planMode"><select id="planMode" className="select" value={mode} onChange={e => setMode(e.target.value as FulfillMode)}><option value="PICKUP">自提</option><option value="DELIVERY">配送</option></select></Field>
      <Field label="充值金额（元）" htmlFor="planPrice"><input id="planPrice" className="input" type="number" required min={0.01} max={99999999} step={0.01} value={price} onChange={e => setPrice(e.target.value)} /></Field>
      <Field label="固定到账数量（全部为付费票）" htmlFor="planQty"><input id="planQty" className="input" type="number" required min={1} max={100000} step={1} value={qty} onChange={e => setQty(e.target.value)} /></Field>
      <Field label="状态" htmlFor="planStatus"><select id="planStatus" className="select" value={status} onChange={e => setStatus(e.target.value as ActiveStatus)}><option value="ACTIVE">启用</option><option value="DISABLED">停用</option></select></Field>
      <p className="membership-note">修改只影响后续充值。额外赠水通过优惠券设置。</p>
    </FormDialog>
  );
}

function PosterDialog({ url, size, planCount, fileName, onClose }: { url: string; size: string; planCount: number; fileName: string; onClose: () => void }) {
  return (
    <Dialog title="价目表图片预览" className="poster-dialog" description={`根据当前 ${planCount} 个启用套餐生成 · ${size} 像素`} onClose={onClose}
      footer={<><span className="membership-note">PNG 高清图片，可直接打印或分享</span><a className="btn primary" href={url} download={fileName}>下载 PNG 图片</a></>}>
      <div className="membership-fields"><img className="poster-preview" src={url} alt="门店价目表预览" /></div>
    </Dialog>
  );
}
