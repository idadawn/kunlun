/* Membership transactions: fixed packages, issued coupons and original-price refunds. */
(() => {
  const live = () => window.KunlunLive;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money = value => Number(value).toFixed(2);
  const can = action => live().session?.permissions.includes(`kunlun.waterstation:${action}`);
  const unit = water => water === 'BAG_7_5L' ? '袋' : '桶';
  const mode = value => value === 'PICKUP' ? '自提' : '配送';
  const payments = '<option value="CASH">现金</option><option value="WECHAT">微信收款码</option><option value="ALIPAY">支付宝收款码</option><option value="BANK">银行转账</option>';
  const run = fn => (...args) => Promise.resolve(fn(...args)).catch(e => window.GQ?.toast(e.message));
  const field = (label, name, input) => `<label for="${name}">${label}</label>${input}`;
  const input = (name, value='', type='text', extra='') => `<input class="input" id="${name}" name="${name}" type="${type}" value="${esc(value)}" ${extra}>`;
  const select = (name, options) => `<select class="select" id="${name}" name="${name}">${options}</select>`;
  const option = (id, label) => `<option value="${esc(id)}">${esc(label)}</option>`;
  const data = form => Object.fromEntries(new FormData(form));
  const planOptions = plans => plans.map(p => option(p.id, `${p.name} · ¥${money(p.price)} / ${p.buyQty}${unit(p.waterType)}`)).join('');
  function dialog(title, body, submit, button='保存') {
    const d=document.createElement('dialog');d.className='membership-dialog';
    d.innerHTML=`<form><header><h2>${esc(title)}</h2><button type="button" class="btn sm" data-close aria-label="关闭">关闭</button></header><div class="membership-fields">${body}</div><p role="alert" class="account-error"></p>${submit?`<footer><button class="btn primary" type="submit">${button}</button></footer>`:''}</form>`;
    d.querySelector('[data-close]').onclick=()=>d.close();d.addEventListener('close',()=>d.remove());
    d.querySelector('form').onsubmit=async e=>{
      e.preventDefault();if(!submit)return;const btn=d.querySelector('[type=submit]');if(btn.disabled)return;
      btn.disabled=true;d.querySelector('[role=alert]').textContent='';
      try{await submit(e.target);d.close();}catch(err){d.querySelector('[role=alert]').textContent=err.message;}finally{btn.disabled=false;}
    };
    document.body.append(d);d.showModal();return d;
  }
  async function refresh() {
    if(live().refreshPage)await live().refreshPage();
    if(document.getElementById('membershipSettings'))await renderSettings();
    if(document.getElementById('drawerMask')?.classList.contains('open')&&live().selectedMember)window.openMember(live().selectedMember.name);
  }
  async function recharge(memberId) {
    if(!can('recharge:create'))throw new Error('当前账号没有充值权限');
    const plans=(await live().req('/api/plans')).filter(p=>p.status==='ACTIVE');
    if(!plans.length)throw new Error('请先配置并启用充值套餐');
    const key=crypto.randomUUID();let coupons=[];
    const members=live().members;
    if(!members.length)throw new Error('请先建立会员档案');
    const d=dialog('水费充值登记',
      field('会员','chargeMember',select('chargeMember',members.map(m=>option(m.id,`${m.name} · ${m.memberNo}`)).join('')))+
      field('充值套餐','chargePlan',select('chargePlan',planOptions(plans)))+
      field('优惠券（每笔最多一张）','chargeCoupon',select('chargeCoupon',option('','不使用优惠券')))+
      '<div id="chargeSummary" class="membership-summary"></div>'+
      field('实际收款方式','chargePay',select('chargePay',payments))+
      '<p class="membership-note">确认线下已收款后登记；押金另行办理。</p>',async form=>{
        const v=data(form);const result=await live().req('/api/recharges',{method:'POST',body:JSON.stringify({memberId:v.chargeMember,planId:v.chargePlan,couponId:v.chargeCoupon||null,payMethod:v.chargePay,idempotencyKey:key})});
        await refresh();if(document.querySelector('[data-batch-dialog]')){document.querySelector('[data-batch-dialog]').close();await showAssets(v.chargeMember);}window.GQ?.toast(`充值成功：付费 ${result.buyQty} + 赠送 ${result.giftQty}，共 ${result.totalTickets} 张水票`);
      },'确认已收款并登记');
    if(memberId&&members.some(m=>m.id===memberId))d.querySelector('#chargeMember').value=memberId;
    let version=0;
    const update=()=>{
      const plan=plans.find(p=>p.id===d.querySelector('#chargePlan').value);
      const coupon=coupons.find(c=>c.id===d.querySelector('#chargeCoupon').value);
      const gift=(plan.giftQty||0)+(coupon?.snapshot.giftQty||0);
      d.querySelector('#chargeSummary').textContent=`实收 ¥${money(plan.price)} · ${mode(plan.fulfillMode)}付费 ${plan.buyQty}${unit(plan.waterType)} + 赠送 ${gift}${unit(plan.waterType)} = 共 ${plan.buyQty+gift}${unit(plan.waterType)}`;
    };
    const loadCoupons=async()=>{
      const current=++version;const mid=d.querySelector('#chargeMember').value;const pid=d.querySelector('#chargePlan').value;
      const list=await live().req(`/api/members/${mid}/coupons`);if(current!==version||!d.isConnected)return;
      coupons=list.filter(c=>c.status==='AVAILABLE'&&c.snapshot.planId===pid&&c.snapshot.price===plans.find(p=>p.id===pid).price&&c.snapshot.fixedQty===plans.find(p=>p.id===pid).buyQty&&c.snapshot.fulfillMode===plans.find(p=>p.id===pid).fulfillMode&&c.snapshot.waterType===plans.find(p=>p.id===pid).waterType&&new Date(c.snapshot.startsAt)<=new Date()&&new Date(c.snapshot.expiresAt)>new Date());
      d.querySelector('#chargeCoupon').innerHTML=option('','不使用优惠券')+coupons.map(c=>option(c.id,`${c.snapshot.name} · 赠 ${c.snapshot.giftQty}${unit(plans.find(p=>p.id===pid).waterType)}`)).join('');update();
    };
    d.querySelector('#chargeMember').onchange=run(loadCoupons);d.querySelector('#chargePlan').onchange=run(loadCoupons);d.querySelector('#chargeCoupon').onchange=update;
    await loadCoupons();
  }
  async function editPlan(plan) {
    const d=dialog(plan?'修改充值套餐':'新建充值套餐',
      field('套餐名称','planName',input('planName',plan?.name,'text','required maxlength="80"'))+
      field('水品','planWater',select('planWater',option('BUCKET_18_9L','18.9L 桶装水')+option('BAG_7_5L','7.5L 袋装水')))+
      field('领取方式','planMode',select('planMode',option('PICKUP','自提')+option('DELIVERY','配送')))+
      field('充值金额（元）','planPrice',input('planPrice',plan?.price||100,'number','required min="0.01" max="99999999" step="0.01"'))+
      field('固定到账数量（全部为付费票）','planQty',input('planQty',plan?.buyQty||16,'number','required min="1" max="100000" step="1"'))+
      field('状态','planStatus',select('planStatus',option('ACTIVE','启用')+option('DISABLED','停用')))+
      '<p class="membership-note">修改只影响后续充值。额外赠水通过优惠券设置。</p>',async form=>{
        const v=data(form);await live().req(`/api/plans${plan?'/'+plan.id:''}`,{method:plan?'PUT':'POST',body:JSON.stringify({name:v.planName,waterType:v.planWater,fulfillMode:v.planMode,price:Number(v.planPrice),buyQty:Number(v.planQty),giftQty:0,status:v.planStatus})});await refresh();window.GQ?.toast('套餐已保存');
      });
    if(plan){d.querySelector('#planWater').value=plan.waterType;d.querySelector('#planMode').value=plan.fulfillMode;d.querySelector('#planStatus').value=plan.status;}
  }
  const localDate = value => {const date=new Date(value);return new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,16);};
  async function editCoupon(template) {
    const plans=await live().req('/api/plans');
    const d=dialog(template?'修改赠水优惠券':'新建赠水优惠券',
      field('优惠券名称','couponName',input('couponName',template?.name||'充值赠 1 桶','text','required maxlength="80"'))+
      field('适用充值套餐','couponPlan',select('couponPlan',planOptions(plans)))+
      field('赠水数量','couponGift',input('couponGift',template?.giftQty||1,'number','required min="1" max="10000" step="1"'))+
      field('可使用开始时间','couponStart',input('couponStart',localDate(template?.startsAt||Date.now()),'datetime-local','required'))+
      field('可使用截止时间','couponEnd',input('couponEnd',localDate(template?.expiresAt||Date.now()+30*86400000),'datetime-local','required'))+
      field('每人最多领取次数','couponLimit',input('couponLimit',template?.perMemberLimit||1,'number','required min="1" max="1000" step="1"'))+
      field('状态','couponStatus',select('couponStatus',option('ACTIVE','启用')+option('DISABLED','停用')))+
      '<p class="membership-note">修改和停用影响后续发券；已发券按领取时规则使用。兑换后的赠票不单设有效期，不折现。</p>',async form=>{
        const v=data(form);await live().req(`/api/coupon-templates${template?'/'+template.id:''}`,{method:template?'PUT':'POST',body:JSON.stringify({name:v.couponName,planId:v.couponPlan,giftQty:Number(v.couponGift),startsAt:new Date(v.couponStart).toISOString(),expiresAt:new Date(v.couponEnd).toISOString(),perMemberLimit:Number(v.couponLimit),status:v.couponStatus})});await refresh();window.GQ?.toast('优惠券已保存');
      });
    if(template){d.querySelector('#couponPlan').value=template.planId;d.querySelector('#couponStatus').value=template.status;}
  }
  async function issueCoupon(memberId) {
    const templates=(await live().req('/api/coupon-templates')).filter(c=>c.status==='ACTIVE'&&new Date(c.expiresAt)>new Date());
    if(!templates.length)throw new Error('暂无可发放优惠券，请先在业务设置中创建');
    if(!live().members.length)throw new Error('请先建立会员档案');
    const key=crypto.randomUUID();
    const d=dialog('发放充值赠水券',field('会员','issueMember',select('issueMember',live().members.map(m=>option(m.id,`${m.name} · ${m.memberNo}`)).join('')))+field('优惠券','issueTemplate',select('issueTemplate',templates.map(c=>option(c.id,`${c.name} · 赠 ${c.giftQty} 张 · 每人限 ${c.perMemberLimit} 次`)).join(''))),async form=>{
      const v=data(form);await live().req(`/api/coupon-templates/${v.issueTemplate}/issue`,{method:'POST',body:JSON.stringify({memberId:v.issueMember,idempotencyKey:key})});if(document.querySelector('[data-batch-dialog]')){document.querySelector('[data-batch-dialog]').close();await showAssets(v.issueMember);}window.GQ?.toast('优惠券已到账，符合套餐的下次充值可使用');
    },'确认发券');if(memberId)d.querySelector('#issueMember').value=memberId;
  }
  async function refund(batch,memberId) {
    const key=crypto.randomUUID();
    dialog('退清本次充值剩余权益',`<div class="membership-summary"><b>${esc(batch.name)}</b><p>原实付 ¥${money(batch.paidAmount)} ÷ 固定 ${batch.fixedQty}${unit(batch.waterType)}</p><p>退付费票 ${batch.remainingBuy}，收回赠票 ${batch.remainingGift}</p><strong>应退 ¥${money(batch.refundableAmount)}</strong></div>`+
      field('实际退款方式','refundPay',select('refundPay',payments))+field('退款原因','refundReason',input('refundReason','','text','required maxlength="500"'))+
      '<p class="membership-note">本操作登记线下退款，不发起支付平台转账。桶押金独立结算。</p>',async form=>{
        const v=data(form);const result=await live().req(`/api/ticket-batches/${batch.id}/refund`,{method:'POST',body:JSON.stringify({idempotencyKey:key,payMethod:v.refundPay,reason:v.refundReason})});await refresh();window.GQ?.toast(`退款登记成功：¥${money(result.refundAmount)}，赠票已收回`);
        document.querySelector('[data-batch-dialog]')?.close();await showAssets(memberId);
      },'确认已退款并登记');
  }
  function batchCards(batches,allowRefund=false) {
    return batches.length?batches.map(b=>`<article class="membership-card"><div class="membership-card-head"><b>${esc(b.name)}</b><span class="tag ${b.status==='REFUNDED'?'gray':'green'}">${b.status==='REFUNDED'?'已退款':mode(b.fulfillMode)}</span></div><small>${esc(b.rechargeNo||'历史余额')} · ${b.waterType==='BAG_7_5L'?'7.5L 袋装':'18.9L 桶装'}</small><p>剩余付费 ${b.source==='LEGACY'?'待核对':b.remainingBuy} · 剩余赠票 ${b.source==='LEGACY'?'待核对':b.remainingGift} · 预占 ${b.reservedBuy+b.reservedGift}</p>${b.source==='LEGACY'?`<p class="membership-note">历史余量 ${b.remainingBuy+b.remainingGift} 张；可继续使用，原价及购赠来源待核对。</p>`:`<p>原实付 ¥${money(b.paidAmount)} / 固定 ${b.fixedQty}${unit(b.waterType)}${b.status==='REFUNDED'?` · 已退 ¥${money(b.refundedAmount)}`:''}</p>`}${allowRefund&&b.source==='PURCHASE'&&b.status==='ACTIVE'&&b.remainingBuy+b.remainingGift>0?`<button class="btn sm" data-refund="${b.id}" ${b.reservedBuy+b.reservedGift?'disabled':''}>${b.reservedBuy+b.reservedGift?'订单占用中':`退清剩余权益 · ¥${money(b.refundableAmount)}`}</button>`:''}</article>`).join(''):'<p class="membership-note">暂无充值水票</p>';
  }
  function couponCards(coupons) {
    return coupons.length?coupons.map(c=>{const expired=new Date(c.snapshot.expiresAt)<=new Date();const pending=new Date(c.snapshot.startsAt)>new Date();return `<article class="membership-card"><b>${esc(c.snapshot.name)}</b><span class="tag ${c.status==='USED'||expired?'gray':'gold'}">${c.status==='USED'?'已使用':expired?'已过期':pending?'未生效':'可使用'}</span><p>额外赠 ${c.snapshot.giftQty} 张水票</p><small>有效期至 ${esc(new Date(c.snapshot.expiresAt).toLocaleString('zh-CN'))}</small></article>`;}).join(''):'<p class="membership-note">暂无优惠券</p>';
  }
  async function showAssets(memberId) {
    const id=memberId||live().session.subjectId;
    const [batches,coupons]=await Promise.all([live().req(`/api/members/${id}/ticket-batches`),live().req(`/api/members/${id}/coupons`)]);
    const member=live().members.find(m=>m.id===id)||live().selectedMember;
    const d=dialog(`${member?.name||'我的'} · 水票与优惠券`,`${can('recharge:create')?'<div class="membership-actions"><button type="button" class="btn primary" data-recharge>充值</button><button type="button" class="btn" data-issue>发券</button></div>':''}<h3>充值批次</h3>${batchCards(batches,can('recharge:refund'))}<h3>我的优惠券</h3>${couponCards(coupons)}`);
    d.dataset.batchDialog='true';d.querySelector('[data-recharge]')?.addEventListener('click',run(()=>recharge(id)));d.querySelector('[data-issue]')?.addEventListener('click',run(()=>issueCoupon(id)));
    d.querySelectorAll('[data-refund]').forEach(btn=>btn.onclick=run(()=>refund(batches.find(b=>b.id===btn.dataset.refund),id)));
  }
  async function renderSettings() {
    const root=document.getElementById('settingsContent');if(!root)return;
    const [plans,templates]=await Promise.all([live().req('/api/plans'),live().req('/api/coupon-templates')]);
    root.innerHTML=`<div id="membershipSettings"><div class="membership-heading"><h3>固定数量充值套餐</h3><button class="btn primary sm" data-new-plan>新增套餐</button></div><div class="setting-grid">${plans.map(p=>`<article class="setting-card"><span class="tag ${p.status==='ACTIVE'?'green':'gray'}">${p.status==='ACTIVE'?'启用':'停用'}</span><div class="plan-price">¥ ${money(p.price)}</div><h3>${esc(p.name)}</h3><p>${mode(p.fulfillMode)} · 固定 ${p.buyQty}${unit(p.waterType)}</p><button class="btn sm" data-edit-plan="${p.id}">编辑套餐</button></article>`).join('')}</div><div class="membership-heading"><h3>充值赠水优惠券</h3><div class="membership-actions"><button class="btn sm" data-issue>向会员发券</button><button class="btn primary sm" data-new-coupon>新建优惠券</button></div></div><div class="setting-grid">${templates.length?templates.map(c=>`<article class="setting-card"><span class="tag ${c.status==='ACTIVE'?'gold':'gray'}">${c.status==='ACTIVE'?'启用':'停用'}</span><h3>${esc(c.name)}</h3><p>${esc(plans.find(p=>p.id===c.planId)?.name||'原套餐')} · 赠 ${c.giftQty} 张</p><p>每人限 ${c.perMemberLimit} 次</p><small>截止 ${esc(new Date(c.expiresAt).toLocaleDateString('zh-CN'))}</small><p><button class="btn sm" data-edit-coupon="${c.id}">编辑优惠券</button></p></article>`).join(''):'<p class="membership-note">暂无优惠券，创建后可发放给会员。</p>'}</div></div>`;
    root.querySelector('[data-new-plan]').onclick=run(()=>editPlan());root.querySelector('[data-new-coupon]').onclick=run(()=>editCoupon());root.querySelector('[data-issue]').onclick=run(()=>issueCoupon());
    root.querySelectorAll('[data-edit-plan]').forEach(b=>b.onclick=run(()=>editPlan(plans.find(p=>p.id===b.dataset.editPlan))));
    root.querySelectorAll('[data-edit-coupon]').forEach(b=>b.onclick=run(()=>editCoupon(templates.find(c=>c.id===b.dataset.editCoupon))));
  }
  function orderCard(o, kind) {
    const state={PENDING:o.fulfillMode==='PICKUP'?'待自提':'待接单',DISPATCHED:'配送中',COMPLETED:'已完成',CANCELLED:'已取消'}[o.status];
    const active=['PENDING','DISPATCHED'].includes(o.status);
    const name=kind==='staff'?(live().members.find(m=>m.id===o.memberId)?.name||o.addressSnapshot?.contactName||'会员'):mode(o.fulfillMode);
    return `<div class="h5-order" data-order-card="${o.id}"><div class="h5-order-top"><div><b>${esc(name)}</b><small>${esc(o.orderNo)}</small></div><span class="tag ${active?'orange':'gray'}">${state}</span></div><div class="h5-product"><div><b>${o.waterType==='BAG_7_5L'?'7.5L 袋装':'18.9L 桶装'} × ${o.orderQty}</b><small>${esc(o.addressSnapshot?.address||'到店自提')}</small></div></div><div class="h5-order-foot"><small>${active?'预占 '+o.reservedQty+' 张':'实取 '+(o.actualQty||0)+' 张'}</small>${active?(kind==='member'?`${o.pickupCode?`<button class="btn sm" data-code="${o.id}">取水码 ${esc(o.pickupCode)}</button>`:''}<button class="btn sm" data-cancel="${o.id}">取消订单</button>`:`${o.status==='PENDING'&&o.fulfillMode==='DELIVERY'?`<button class="btn sm" data-accept="${o.id}">接单</button>`:''}<button class="btn primary sm" data-fulfill="${o.id}">${o.fulfillMode==='PICKUP'?'核销自提':'确认交付'}</button>`):''}</div></div>`;
  }
  function renderOrders(kind) {
    const root=document.querySelector(`#${kind}-orders .h5-body`);if(!root)return;
    root.innerHTML=live().orders.map(o=>orderCard(o,kind)).join('')||'<p class="membership-note">暂无水单</p>';
    if(kind==='member') {
      const home=document.getElementById('homeActiveOrder');
      const active=live().orders.find(o=>['PENDING','DISPATCHED'].includes(o.status));
      if(home)home.innerHTML=active?orderCard(active,kind):'<p class="membership-note">暂无进行中的水单</p>';
    }
    if(kind==='staff') {
      const all=document.querySelector('#staff-home .h5-section-head a');if(all)all.textContent=`全部 ${live().orders.length} 单 ›`;
      const home=document.querySelector('#staff-home .h5-body');
      home?.querySelectorAll('.h5-order').forEach(x=>x.remove());
      if(home){let queue=home.querySelector('[data-live-orders]');if(!queue){queue=document.createElement('div');queue.dataset.liveOrders='true';home.append(queue);}queue.innerHTML=live().orders.filter(o=>['PENDING','DISPATCHED'].includes(o.status)).slice(0,3).map(o=>orderCard(o,kind)).join('');}
      const refreshBtn=document.querySelector('#staff-orders .mobile-top button');if(refreshBtn)refreshBtn.onclick=run(refresh);
    }
    document.querySelectorAll('[data-cancel]').forEach(b=>b.onclick=run(async()=>{await live().req(`/api/orders/${b.dataset.cancel}/cancel`,{method:'POST',body:JSON.stringify({cancelReason:'会员取消订单'})});await refresh();}));
    document.querySelectorAll('[data-code]').forEach(b=>b.onclick=()=>{const o=live().orders.find(o=>o.id===b.dataset.code);window.showPickupQr(o.orderNo,o.pickupCode);});
    document.querySelectorAll('[data-accept]').forEach(b=>b.onclick=run(async()=>{await live().req(`/api/orders/${b.dataset.accept}/accept`,{method:'POST'});await refresh();}));
    document.querySelectorAll('[data-fulfill]').forEach(b=>b.onclick=run(()=>fulfill(live().orders.find(o=>o.id===b.dataset.fulfill))));
  }
  async function fulfill(order) {
    const pickup=!order||order.fulfillMode==='PICKUP';
    dialog(pickup?'自提核销':'确认配送交付',`${order?`<p>${esc(order.orderNo)} · 下单 ${order.orderQty}${unit(order.waterType)}</p>`:''}`+
      (pickup?field('会员出示的六位取水码','pickupCode',input('pickupCode','','text','required pattern="[0-9]{6}" inputmode="numeric" maxlength="6"')):'')+
      field('实际交付数量','fulfillQty',input('fulfillQty',order?.orderQty||1,'number','min="1" step="1" required'))+
      field('满桶领出','fullOut',input('fullOut',order?.orderQty||1,'number','min="0" step="1" required'))+
      field('空桶收回','emptyIn',input('emptyIn',order?.orderQty||1,'number','min="0" step="1" required'))+
      field('数量不一致时填写原因','diffReason',input('diffReason','','text','maxlength="500"')),async form=>{
        const v=data(form);await live().req(order?`/api/orders/${order.id}/fulfill`:'/api/orders/pickup-verify',{method:'POST',body:JSON.stringify({actualQty:Number(v.fulfillQty),fullOutN:Number(v.fullOut),emptyInM:Number(v.emptyIn),pickupCode:v.pickupCode||null,diffReason:v.diffReason||null})});await refresh();window.GQ?.toast('交付成功，已按批次扣除水票');
      },'确认交付并扣票');
  }
  async function staffOrder() {
    const key=crypto.randomUUID();
    const d=dialog('代会员开水单',field('会员','orderMember',select('orderMember',live().members.map(m=>option(m.id,`${m.name} · ${m.memberNo}`)).join('')))+
      field('水品','orderWater',select('orderWater',option('BUCKET_18_9L','18.9L 桶装')+option('BAG_7_5L','7.5L 袋装')))+
      field('领取方式','orderMode',select('orderMode',option('PICKUP','自提')+option('DELIVERY','配送')))+
      field('数量','orderQty',input('orderQty',1,'number','min="1" step="1" required'))+
      field('配送地址','orderAddress',input('orderAddress',live().selectedMember?.defaultAddress||'')),async form=>{
        const v=data(form);const o=await live().req('/api/orders',{method:'POST',body:JSON.stringify({memberId:v.orderMember,waterType:v.orderWater,fulfillMode:v.orderMode,orderQty:Number(v.orderQty),addressOverride:v.orderAddress,idempotencyKey:key})});await refresh();window.GQ?.toast(`水单已创建${o.pickupCode?'，取水码 '+o.pickupCode:''}`);
      },'提交并预占水票');
    if(live().selectedMember)d.querySelector('#orderMember').value=live().selectedMember.id;
    d.querySelector('#orderMember').onchange=()=>{d.querySelector('#orderAddress').value=live().members.find(m=>m.id===d.querySelector('#orderMember').value)?.defaultAddress||'';};
  }
  async function staffNewMember() {
    dialog('新建会员',field('会员姓名','newName',input('newName','','text','required maxlength="64"'))+field('联系电话','newPhone',input('newPhone','','tel','required pattern="1[0-9]{10}"'))+field('配送地址','newAddress',input('newAddress')),async form=>{
      const v=data(form);const m=await live().req('/api/members',{method:'POST',body:JSON.stringify({name:v.newName,phone:v.newPhone,defaultAddress:v.newAddress})});await refresh();live().selectedMember=live().members.find(x=>x.id===m.id);live().setMemberCredentials(m.id);
    });
  }
  async function renderDeposits() {
    const root=document.querySelector('#member-assets .h5-body');if(!root)return;
    const rows=await live().req(`/api/members/${live().session.subjectId}/deposit-summary`);
    const cards=root.querySelectorAll('.h5-card');
    cards[0].querySelector('.num').textContent='¥ '+money(rows.reduce((sum,r)=>sum+r.paidAmount,0));
    cards[0].lastElementChild.innerHTML=rows.map(r=>`<span>${r.containerType==='BUCKET'?'桶押金':'袋押金'} ¥${money(r.paidAmount)}（${r.paidQty}个）</span>`).join('');
    rows.forEach((r,i)=>{const values=cards[i+1].querySelectorAll('.detail-row b');values[0].textContent=`${r.paidQty} 个 / ¥${money(r.paidAmount)}`;values[1].textContent=`${r.heldQty} 个`;values[2].textContent=`${r.refundableQty} 个 / ¥${money(r.refundableAmount)}`;cards[i+1].querySelector('.detail-row span').textContent='已交未退押金（按原收款批次）';});
    root.querySelectorAll('.h5-section-head .tag').forEach((tag,i)=>{tag.textContent=rows[i].heldQty<=rows[i].paidQty?'押金已覆盖':'需补交押金';});
  }
  function memberOptions() { return live().members.map(m=>option(m.id,`${m.name} · ${m.memberNo}`)).join(''); }
  async function depositForm() {
    if(!can('deposit:collect')&&!can('deposit:refund_approve')&&!can('deposit:refund_apply'))throw new Error('当前账号没有押金办理权限');
    const key=crypto.randomUUID();
    const d=dialog('押金收退登记',field('会员','depositMember',select('depositMember',memberOptions()))+
      field('容器','depositContainer',select('depositContainer',option('BUCKET','18.9L 周转桶')+option('BAG','7.5L 配套容器')))+
      field('业务类型','depositAction',select('depositAction',(can('deposit:collect')?option('collect','收取押金'):'')+(can('deposit:refund_approve')||can('deposit:refund_apply')?option('refund','退还押金'):'')))+
      field('数量','depositQuantity',input('depositQuantity',1,'number','min="1" step="1" required'))+
      field('实际收付方式','depositPayment',select('depositPayment',payments))+'<div id="depositPreview" class="membership-summary"></div>',async form=>{
        const v=data(form);const result=await live().req(`/api/deposits/${v.depositAction}`,{method:'POST',body:JSON.stringify({memberId:v.depositMember,containerType:v.depositContainer,quantity:Number(v.depositQuantity),payMethod:v.depositPayment,idempotencyKey:key})});
        await refresh();window.GQ.toast(`押金登记成功：¥${money(result.refundAmount??result.totalAmount)}`);
      },'确认线下已收付并登记');
    if(live().selectedMember)d.querySelector('#depositMember').value=live().selectedMember.id;
    let version=0;const preview=async()=>{const mine=++version;const v=data(d.querySelector('form'));const rows=await live().req(`/api/members/${v.depositMember}/deposit-summary`);if(mine!==version||!d.isConnected)return;const row=rows.find(x=>x.containerType===v.depositContainer);const cfg=live().containers.find(x=>x.containerType===v.depositContainer);d.querySelector('#depositPreview').textContent=v.depositAction==='collect'?`当前单价 ¥${money(cfg.unitDeposit)} / 个；本次应收 ¥${money(cfg.unitDeposit*Number(v.depositQuantity))}`:`已交未退 ${row.paidQty} 个，持有 ${row.heldQty} 个，最多可退 ${row.refundableQty} 个；退清可退押金 ¥${money(row.refundableAmount)}，退款按原收款单价计算。`;};
    d.querySelectorAll('select,input').forEach(el=>el.onchange=run(preview));await preview();
  }
  async function movementForm() {
    if(!can('container:register')&&!can('order:fulfill'))throw new Error('当前账号没有容器登记权限');
    const key=crypto.randomUUID();
    const d=dialog('容器领还登记',field('会员','moveMember',select('moveMember',memberOptions()))+
      field('容器类型','moveContainer',select('moveContainer',option('BUCKET','18.9L 周转桶')+option('BAG','7.5L 配套容器')))+
      field('满桶领出','moveOut',input('moveOut',0,'number','min="0" step="1" required'))+
      field('空桶收回','moveIn',input('moveIn',1,'number','min="0" step="1" required'))+
      '<p class="membership-note">按实际交接登记，同时更新会员持有和水站库存；押金另行结算。</p>',async form=>{
        const v=data(form);const r=await live().req('/api/containers/movements',{method:'POST',body:JSON.stringify({memberId:v.moveMember,containerType:v.moveContainer,fullOutN:Number(v.moveOut),emptyInM:Number(v.moveIn),idempotencyKey:key})});await refresh();window.GQ.toast(`领还已登记，会员当前持有 ${r.currentHeld} 个`);
      },'确认登记');if(live().selectedMember)d.querySelector('#moveMember').value=live().selectedMember.id;
  }
  async function depositSettings() {
    const configs=await live().req('/api/containers/summary');const root=document.getElementById('settingsContent');
    root.innerHTML='<div class="setting-grid">'+configs.map(c=>`<div class="setting-card"><h3>${c.containerType==='BUCKET'?'18.9L 周转桶':'7.5L 配套容器'}</h3><div class="setting-row"><span>押金单价</span><b>¥${money(c.unitDeposit)}</b></div><div class="setting-row"><span>站内 / 总量</span><b>${c.inStationQty} / ${c.totalQty}</b></div><div class="setting-row"><span>低库存预警</span><b>${c.warnThreshold} 个</b></div><button class="btn sm" data-deposit-setting="${c.containerType}">修改押金单价</button></div>`).join('')+'</div>';
    root.querySelectorAll('[data-deposit-setting]').forEach(b=>b.onclick=()=>{const c=configs.find(c=>c.containerType===b.dataset.depositSetting);dialog('修改押金单价',field('新收押金单价（元/个）','unitDeposit',input('unitDeposit',c.unitDeposit,'number','required min="0.01" step="0.01"'))+'<p class="membership-note">只影响新收押金；历史押金仍按原收款单价退款。</p>',async form=>{await live().req(`/api/containers/${c.containerType}/unit-deposit?newUnitDeposit=${encodeURIComponent(data(form).unitDeposit)}`,{method:'PUT'});await refresh();await depositSettings();});});
  }
  function showRecharge(no) {
    const r=live().recharges.find(x=>x.rechargeNo===no);if(!r)throw new Error('未找到充值记录，请刷新');
    dialog('充值记录详情',`<div class="membership-summary"><b>${esc(r.memberName)} · ${esc(r.memberNo)}</b><p>${esc(r.rechargeNo)}</p><p>${esc(r.planName)}</p><p>实收 ¥${money(r.paidAmount)} · 付费 ${r.buyQty} + 赠票 ${r.giftQty}</p><p>${esc(mode(r.planSnapshot.fulfillMode))} · ${r.planSnapshot.waterType==='BAG_7_5L'?'7.5L 袋装':'18.9L 桶装'}</p><small>${esc(new Date(r.createdAt).toLocaleString('zh-CN'))} · ${esc(r.operatorName)}</small></div>`);
  }
  function showOrder(id) {
    const o=live().orders.find(o=>o.id===id);if(!o)throw new Error('未找到水单，请刷新');
    dialog('水单详情',orderCard(o,'member').replace(/<button[\s\S]*?<\/button>/g,'')+`<p>满桶领出 ${o.fullOutQty??'—'} · 空桶收回 ${o.emptyInQty??'—'}</p><p>${esc(o.diffReason||o.cancelReason||'')}</p>`);
  }
  async function staffAccounts() {
    const accounts=await live().req('/api/staff');const root=document.getElementById('settingsContent');
    root.innerHTML=`<div class="table-card"><div class="table-toolbar"><b>员工账号与权限</b><button class="btn primary sm" data-new-staff>添加员工</button></div><table><thead><tr><th>员工</th><th>用户名</th><th>角色</th><th>状态</th><th>操作</th></tr></thead><tbody>${accounts.map(s=>`<tr><td>${esc(s.name)}<br><small>${esc(s.phone)}</small></td><td>${esc(s.username)}</td><td>${esc(s.role)}</td><td>${s.status==='ACTIVE'?'启用':'停用'}</td><td><button class="link" data-status="${s.id}">${s.status==='ACTIVE'?'停用':'启用'}</button> <button class="link" data-reset="${s.id}">设置账号 / 重置密码</button></td></tr>`).join('')}</tbody></table></div>`;
    root.querySelector('[data-new-staff]').onclick=()=>dialog('添加员工账号',field('姓名','staffName',input('staffName','','text','required maxlength="64"'))+field('手机号','staffPhone',input('staffPhone','','tel','required pattern="1[0-9]{10}"'))+field('用户名','staffUsername',input('staffUsername','','text','required pattern="[A-Za-z0-9][A-Za-z0-9_.-]{2,31}" autocomplete="off"'))+field('初始密码','staffPassword',input('staffPassword','','password','required minlength="8" maxlength="128" autocomplete="new-password"'))+field('角色','staffRole',select('staffRole',option('CLERK','店员')+option('COURIER','送水员')+option('ADMIN','管理员'))),async form=>{
      const v=data(form);await live().req('/api/staff',{method:'POST',body:JSON.stringify({name:v.staffName,phone:v.staffPhone,username:v.staffUsername,password:v.staffPassword,role:v.staffRole})});await staffAccounts();window.GQ?.toast('员工账号已创建');
    });
    root.querySelectorAll('[data-status]').forEach(b=>b.onclick=run(async()=>{const s=accounts.find(s=>s.id===b.dataset.status);await live().req(`/api/staff/${s.id}/status`,{method:'PATCH',body:JSON.stringify({status:s.status==='ACTIVE'?'DISABLED':'ACTIVE'})});await staffAccounts();}));
    root.querySelectorAll('[data-reset]').forEach(b=>b.onclick=()=>{
      const s=accounts.find(s=>s.id===b.dataset.reset);
      dialog('设置员工登录账号',field('用户名','resetUsername',input('resetUsername',s.username,'text','required pattern="[A-Za-z0-9][A-Za-z0-9_.-]{2,31}"'))+field('新密码','resetPassword',input('resetPassword','','password','required minlength="8" maxlength="128" autocomplete="new-password"')),async form=>{
        const v=data(form);await live().req(`/api/accounts/STAFF/${s.id}/credentials`,{method:'PUT',body:JSON.stringify({username:v.resetUsername,password:v.resetPassword})});await staffAccounts();
      });
    });
  }
  function applyListFilters() {
    const text = id => document.querySelector(`#${id} .field-search input`)?.value.trim().toLowerCase()||'';
    const withinDate=(time,filter)=>{if(!filter||filter==='全部时间')return true;const day=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());let start=new Date((filter==='本月'?day.slice(0,8)+'01':day)+'T00:00:00+08:00');if(filter==='近 7 天')start=new Date(start.getTime()-6*86400000);return new Date(time)>=start;};
    const orderSelects=document.querySelectorAll('#page-orders .filter-card select');
    document.querySelectorAll('#orderTable tr').forEach((row,i)=>{const o=live().orders[i];if(!o)return;const modeFilter=orderSelects[0]?.value;const state=document.querySelector('#page-orders .tabs .tab.active')?.firstChild?.textContent.trim();row.classList.toggle('hide',(state&&state!=='全部水单'&&row.dataset.status!==state)||!row.textContent.toLowerCase().includes(text('page-orders'))||(modeFilter!=='全部领取方式'&&mode(o.fulfillMode)!==modeFilter)||!withinDate(o.createdAt,orderSelects[1]?.value));});
    const finance=window._currentFinanceTab==='押金记录'?live().deposits:live().recharges;
    document.querySelectorAll('#financeBody tr').forEach((row,i)=>{const r=finance[i];if(!r)return;row.classList.toggle('hide',!row.textContent.toLowerCase().includes(text('page-finance'))||!withinDate(r.createdAt,document.querySelector('#page-finance .filter-card select')?.value));});
    const containerFilter=document.querySelector('#page-assets .table-toolbar select')?.selectedIndex;
    document.querySelectorAll('#page-assets table tbody tr').forEach((row,i)=>{const r=live().containerLedgers[i];if(r)row.classList.toggle('hide',containerFilter>0&&r.containerType!==(containerFilter===1?'BUCKET':'BAG'));});
    const membersSelect=document.querySelectorAll('#page-members .filter-card select');
    document.querySelectorAll('#memberTable tr').forEach((row,i)=>{const m=live().members[i];if(!m)return;const water=membersSelect[0]?.selectedIndex,state=membersSelect[1]?.selectedIndex;row.classList.toggle('hide',(water===1&&m.bucketPickupTickets+m.bucketDeliveryTickets===0)||(water===2&&m.bagPickupTickets+m.bagDeliveryTickets===0)||(state===1&&m.status!=='ACTIVE')||(state===2&&m.status==='ACTIVE'));});
  }
  function mount(kind) {
    if(kind==='admin') {
      document.querySelectorAll('#page-orders .filter-card select,#page-finance .filter-card select').forEach(s=>{if(s.options[0].textContent==='今天')s.insertAdjacentHTML('afterbegin','<option selected>全部时间</option>');});
      document.querySelectorAll('.filter-card select,#page-assets .table-toolbar select').forEach(s=>s.onchange=applyListFilters);
      document.querySelectorAll('#page-orders .field-search input,#page-finance .field-search input').forEach(i=>i.oninput=applyListFilters);
      const originalFinance=window.financeTab;window.financeTab=(btn,type)=>{originalFinance(btn,type);applyListFilters();};
      const originalOrderFilter=window.filterOrders;window.filterOrders=(btn,state)=>{originalOrderFilter(btn,state);applyListFilters();};
      const originalPage=window.showPage;window.showPage=page=>{originalPage(page);run(refresh)();};
      window.openRecharge=run(()=>recharge(live().selectedMember?.id));window.openPlan=run(()=>editPlan());window.openDeposit=run(depositForm);window.openContainer=run(movementForm);window.openOrder=run(staffOrder);window.openFulfill=run((no,name,water,qty,id)=>fulfill(live().orders.find(o=>o.id===id||o.orderNo===no)));
      const originalSettings=window.settingsTab;
      window.settingsTab=(btn,type)=>{originalSettings(btn,type);if(type==='plans')run(renderSettings)();if(type==='staff')run(staffAccounts)();if(type==='deposit')run(depositSettings)();};
      run(renderSettings)();
      const originalMember=window.openMember;
      window.openMember=(name)=>{originalMember(name);
        const cards=document.querySelectorAll('#drawerMask .detail-card');
        if(cards[2]){const m=live().selectedMember;const entries=live().recharges.filter(r=>r.memberNo===m.memberNo);cards[2].innerHTML='<h4>最近充值流水</h4>'+(entries.length?entries.slice(0,5).map(r=>`<p>${esc(r.planName)} · 实收 ¥${money(r.paidAmount)} · 付费 ${r.buyQty} + 赠票 ${r.giftQty}</p>`).join(''):'<p class="membership-note">暂无充值记录</p>');}
        const foot=document.querySelector('#drawerMask .drawer-foot')||document.querySelector('#drawerMask .drawer-body');if(foot&&!document.getElementById('memberBatchButton')){const b=document.createElement('button');b.id='memberBatchButton';b.className='btn primary';b.textContent='水票批次 / 优惠券 / 退款';b.onclick=run(()=>showAssets(live().selectedMember.id));foot.append(b);}};
      const heads=document.querySelector('#page-members .page-head');if(heads&&!document.getElementById('issueCouponButton')){const b=document.createElement('button');b.id='issueCouponButton';b.className='btn';b.textContent='发放优惠券';b.onclick=run(()=>issueCoupon());heads.append(b);}
    } else if(kind==='staff') {
      const originalNav=window.staffNav;window.staffNav=page=>{originalNav(page);run(refresh)();};
      const original=window.openSheet;
      window.openSheet=(type,...args)=>{
        if(type==='recharge')return run(()=>recharge(live().selectedMember?.id))();
        if(type==='pickupCode')return run(()=>fulfill())();
        if(type==='order')return run(staffOrder)();
        if(type==='newMember')return run(staffNewMember)();
        if(type==='deposit')return run(depositForm)();
        if(type==='container')return run(movementForm)();
        if(type==='pickMember')return run(()=>recharge())();
        if(type==='memberDetail'){const m=live().members.find(m=>m.id===args[0]||m.name===args[0]);if(m){live().selectedMember=m;return run(()=>showAssets(m.id))();}}
        return original(type,...args);
      };
    } else {
      window.openEditAddress=()=>dialog('修改默认配送地址',field('配送地址','memberAddress',input('memberAddress',live().selectedMember?.defaultAddress||'','text','required maxlength="500"')),async form=>{await live().req(`/api/members/${live().session.subjectId}/address`,{method:'PUT',body:JSON.stringify({address:data(form).memberAddress})});await refresh();});
      const original=window.memberNav;window.memberNav=(page)=>{original(page);if(page==='orders'||page==='home')run(refresh)();if(page==='assets')run(renderDeposits)();if(page==='records')run(async()=>{
        const [batches,coupons]=await Promise.all([live().req(`/api/members/${live().session.subjectId}/ticket-batches`),live().req(`/api/members/${live().session.subjectId}/coupons`)]);
        document.querySelector('#member-records .h5-body').innerHTML=`<h3>充值与退款记录</h3>${batchCards(batches)}<h3>我的优惠券</h3>${couponCards(coupons)}`;
      })();};
      const anchor=document.querySelector('.wallet-head a');if(anchor){anchor.textContent='水票 / 优惠券 ›';anchor.onclick=run(()=>showAssets());anchor.removeAttribute('href');}
    }
  }
  window.KunlunMembership={mount,renderOrders,applyListFilters,showRecharge:run(showRecharge),showOrder:run(showOrder),recharge:run(recharge),showAssets:run(showAssets)};
})();
