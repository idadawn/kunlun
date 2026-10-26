/* Deterministic, data-driven price-list PNG. No prices are baked into the artwork. */
import type { FulfillMode, RechargePlan, WaterProduct, WaterType } from './types';

const ORDER: ReadonlyArray<[WaterType, FulfillMode, '袋' | '桶']> = [
  ['BAG_7_5L', 'PICKUP', '袋'],
  ['BUCKET_18_9L', 'PICKUP', '桶'],
  ['BAG_7_5L', 'DELIVERY', '袋'],
  ['BUCKET_18_9L', 'DELIVERY', '桶'],
];
const amount = (n: number) => (Number.isInteger(Number(n)) ? String(Number(n)) : Number(n).toFixed(2));

export interface PosterRow { id: string; price: number; paidQty: number; giftQty: number; totalQty: number; line: string; giftNote: string }
export interface PosterGroup { waterType: WaterType; mode: FulfillMode; unit: string; title: string; rows: PosterRow[] }
export interface PosterModel { store: string; groups: PosterGroup[]; retailRows: string[]; planCount: number; date: string }

export function buildPosterModel({ plans, products, store = '绿麒麟水站', generatedAt = new Date() }: {
  plans: RechargePlan[];
  products: WaterProduct[];
  store?: string;
  generatedAt?: Date | string;
}): PosterModel {
  const active = plans.filter(p => p.status === 'ACTIVE');
  if (!active.length) throw new Error('没有启用中的充值套餐，无法生成价目表');
  const index = new Map(products.map(p => [p.waterType, p]));
  for (const p of active) {
    const product = index.get(p.waterType);
    if (!product || !ORDER.some(([type, mode]) => type === p.waterType && mode === p.fulfillMode)) throw new Error('套餐水品或领取方式不完整');
    if (!Number.isFinite(p.price) || p.price <= 0 || !Number.isSafeInteger(p.buyQty) || p.buyQty <= 0 || !Number.isSafeInteger(p.giftQty) || p.giftQty < 0)
      throw new Error('套餐价格或数量无效，请先维护套餐');
    if (!Number.isFinite(product.capacityLiters) || product.capacityLiters <= 0 || !Number.isSafeInteger(product.deliveryMinimum) || product.deliveryMinimum < 1 || !Number.isFinite(product.deliveryFee) || product.deliveryFee < 0)
      throw new Error('水品规格或配送规则无效');
  }
  const groups = ORDER.map(([type, mode, unit]): PosterGroup | null => {
    const product = index.get(type)!;
    const rows = active
      .filter(p => p.waterType === type && p.fulfillMode === mode)
      .sort((a, b) => a.price - b.price || a.buyQty - b.buyQty || a.id.localeCompare(b.id));
    if (!rows.length) return null;
    const kind = unit + '装水';
    const title = mode === 'PICKUP'
      ? `来门店自提${kind}`
      : `${product.deliveryFee === 0 ? '免费上门送' : '上门配送'}${kind}（${product.deliveryMinimum}${unit}起送${product.deliveryFee === 0 ? '' : `，配送费${amount(product.deliveryFee)}元`}）`;
    return {
      waterType: type, mode, unit, title,
      rows: rows.map(p => ({
        id: p.id, price: p.price, paidQty: p.buyQty, giftQty: p.giftQty, totalQty: p.buyQty + p.giftQty,
        line: `办理${amount(p.price)}元水卡：可得${p.buyQty + p.giftQty}${unit}水（${amount(product.capacityLiters)}升/${unit}）`,
        giftNote: p.giftQty ? `其中购买 ${p.buyQty}${unit}，赠送 ${p.giftQty}${unit}` : '',
      })),
    };
  }).filter((g): g is PosterGroup => g !== null);
  const retailRows = products.filter(p => p.retailPrice != null).map(p => {
    if (!Number.isFinite(p.retailPrice) || p.retailPrice! <= 0) throw new Error('零售价无效');
    const unit = p.waterType === 'BAG_7_5L' ? '袋' : '桶';
    return `${p.packaging || p.name} · 零售每${unit}${amount(p.retailPrice!)}元`;
  });
  const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(generatedAt));
  return { store, groups, retailRows, planCount: active.length, date };
}

export function renderPoster(model: PosterModel, canvas: HTMLCanvasElement = document.createElement('canvas')): HTMLCanvasElement {
  const width = 1800, panelX = 90, panelW = 1620, panelTop = 360;
  const retailHeight = model.retailRows.length ? 50 + model.retailRows.length * 80 : 0;
  const heights = model.groups.map(g => 195 + g.rows.reduce((h, r) => h + 140 + (r.giftNote ? 48 : 0), 0));
  const panelBottom = panelTop + retailHeight + heights.reduce((s, h) => s + h, 0);
  const height = Math.ceil(Math.max(2000, panelBottom + 180) / 100) * 100;
  canvas.width = width; canvas.height = height;
  const c = canvas.getContext('2d')!;
  const font = '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';
  const fit = (text: string, x: number, y: number, max: number, size = 60, weight = 500, color = '#203b3d', align: CanvasTextAlign = 'center') => {
    c.textAlign = align; c.textBaseline = 'alphabetic'; c.fillStyle = color;
    while (size > 24) { c.font = `${weight} ${size}px ${font}`; if (c.measureText(text).width <= max) break; size -= 1; }
    c.fillText(text, x, y, max);
  };
  const round = (x: number, y: number, w: number, h: number, r: number) => {
    c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
  };
  const gradient = c.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, '#e9f3ed'); gradient.addColorStop(0.46, '#d9eff0'); gradient.addColorStop(1, '#8dcde0');
  c.fillStyle = gradient; c.fillRect(0, 0, width, height);
  // Water motifs sit outside the text panel, preserving readability at print size.
  for (let i = 0; i < 4; i++) {
    c.beginPath(); c.moveTo(0, height - 180 + i * 35);
    c.bezierCurveTo(470, height - 420 + i * 55, 1100, height + 60 - i * 20, width, height - 250 + i * 48);
    c.lineTo(width, height); c.lineTo(0, height); c.closePath();
    c.fillStyle = ['#48a5ca33', '#f7ffff99', '#317fa722', '#c4f0f188'][i]; c.fill();
  }
  for (const [x, y, r] of [[70, 350, 36], [1720, 220, 60], [1750, height - 480, 42], [70, height - 270, 55], [1650, height - 80, 26]]) {
    const bubble = c.createRadialGradient(x - r * 0.3, y - r * 0.3, 3, x, y, r);
    bubble.addColorStop(0, '#ffffff99'); bubble.addColorStop(0.7, '#ffffff00'); bubble.addColorStop(0.95, '#ffffff99'); bubble.addColorStop(1, '#7fb6c144');
    c.fillStyle = bubble; c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
  }
  c.strokeStyle = '#ffffffbb'; c.lineWidth = 5; c.strokeRect(30, 30, width - 60, height - 60);
  fit(model.store, 900, 112, 1400, 42, 600, '#285958');
  c.font = `800 154px ${font}`; c.textAlign = 'center'; c.lineWidth = 18; c.strokeStyle = '#f8fffa';
  c.strokeText('价  格  表', 900, 285); c.fillStyle = '#225b49'; c.fillText('价  格  表', 900, 285);
  c.fillStyle = '#ffffffd9'; c.fillRect(panelX, panelTop, panelW, panelBottom - panelTop);
  c.strokeStyle = '#365c60'; c.lineWidth = 3; c.strokeRect(panelX, panelTop, panelW, panelBottom - panelTop);
  let top = panelTop;
  if (retailHeight) {
    model.retailRows.forEach((line, i) => fit(line, 900, top + 82 + i * 80, 1480, 52, 500));
    top += retailHeight; c.beginPath(); c.moveTo(panelX, top); c.lineTo(panelX + panelW, top); c.stroke();
  }
  model.groups.forEach((group, index) => {
    c.fillStyle = '#de8173'; round(310, top + 38, 1180, 102, 30); c.fill(); fit(group.title, 900, top + 108, 1090, 56, 700, '#ffffff');
    let rowY = top + 237;
    group.rows.forEach(row => {
      fit(row.line, 900, rowY, 1460, 61, 500);
      if (row.giftNote) { fit(row.giftNote, 900, rowY + 52, 1400, 34, 400, '#5c7272'); rowY += 48; }
      rowY += 140;
    });
    top += heights[index];
    if (index < model.groups.length - 1) { c.beginPath(); c.moveTo(panelX, top); c.lineTo(panelX + panelW, top); c.stroke(); }
  });
  fit(`${model.store} · ${model.date.replaceAll('-', '.')}`, 900, height - 66, 1400, 31, 500, '#35676a');
  return canvas;
}
