import test from 'node:test';
import assert from 'node:assert/strict';
import {buildPosterModel as buildModel} from '../packages/shared/src/price-poster.ts';
const products=[{waterType:'BAG_7_5L',name:'5L 袋装水',capacityLiters:5,packaging:'食品级铝箔袋（10斤装）',retailPrice:5,deliveryMinimum:5,deliveryFee:0},{waterType:'BUCKET_18_9L',name:'15L 桶装水',capacityLiters:15,packaging:'桶装',retailPrice:null,deliveryMinimum:1,deliveryFee:0}];
const plans=[['BAG_7_5L','PICKUP',100,50],['BAG_7_5L','PICKUP',499,300],['BUCKET_18_9L','PICKUP',100,16],['BUCKET_18_9L','PICKUP',499,95],['BAG_7_5L','DELIVERY',100,40],['BAG_7_5L','DELIVERY',499,220],['BUCKET_18_9L','DELIVERY',100,13],['BUCKET_18_9L','DELIVERY',499,70]].map(([waterType,fulfillMode,price,buyQty],i)=>({id:String(i),waterType,fulfillMode,price,buyQty,giftQty:0,status:'ACTIVE'}));
const base={plans,products,generatedAt:'2026-10-25T16:01:00Z'};
test('poster matches the posted eight-package price list and excludes disabled packages',()=>{
 const model=buildModel({...base,plans:[{...plans[0],id:'old',status:'DISABLED',price:500},...plans].reverse()});
 assert.equal(model.planCount,8);assert.equal(model.groups.length,4);assert.equal(model.date,'2026-10-26');
 assert.deepEqual(model.groups.map(g=>g.title),['来门店自提袋装水','来门店自提桶装水','免费上门送袋装水（5袋起送）','免费上门送桶装水（1桶起送）']);
 assert.deepEqual(model.groups.flatMap(g=>g.rows.map(r=>r.line)),[
  '办理100元水卡：可得50袋水（5升/袋）','办理499元水卡：可得300袋水（5升/袋）',
  '办理100元水卡：可得16桶水（15升/桶）','办理499元水卡：可得95桶水（15升/桶）',
  '办理100元水卡：可得40袋水（5升/袋）','办理499元水卡：可得220袋水（5升/袋）',
  '办理100元水卡：可得13桶水（15升/桶）','办理499元水卡：可得70桶水（15升/桶）']);
 assert.deepEqual(model.retailRows,['食品级铝箔袋（10斤装） · 零售每袋5元']);
});
test('fresh data controls prices, volumes, retail price and delivery threshold',()=>{
 const model=buildModel({...base,plans:plans.map((p,i)=>i===0?{...p,price:129,buyQty:60}:p),products:products.map((p,i)=>i===0?{...p,capacityLiters:6,retailPrice:7,deliveryMinimum:7}:p)});
 assert.equal(model.groups[0].rows[0].line,'办理129元水卡：可得60袋水（6升/袋）');
 assert.equal(model.groups[2].title,'免费上门送袋装水（7袋起送）');assert.match(model.retailRows[0],/7元$/);
});
test('intrinsic package gifts are disclosed; unrelated coupons never inflate advertised quantities',()=>{
 const model=buildModel({...base,plans:[{...plans[0],giftQty:1}],coupons:[{giftQty:100}]});
 assert.equal(model.groups[0].rows[0].totalQty,51);assert.equal(model.groups[0].rows[0].giftNote,'其中购买 50袋，赠送 1袋');
});
test('missing products and invalid data cannot produce a misleading poster',()=>{
 assert.throws(()=>buildModel({...base,plans:[]}),/没有启用/);
 assert.throws(()=>buildModel({...base,products:[]}),/不完整/);
 assert.throws(()=>buildModel({...base,plans:[{...plans[0],price:NaN}]}),/价格或数量/);
 assert.throws(()=>buildModel({...base,products:products.map(p=>({...p,deliveryMinimum:0}))}),/配送规则/);
});
test('generation does not mutate the live configuration arrays',()=>{
 const before=JSON.stringify(base);buildModel(base);assert.equal(JSON.stringify(base),before);
});
