(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.KunlunPlanPicker=api;})(typeof window==='undefined'?null:window,function(){
  const categories=[{id:'ALL',label:'全部套餐'}, {id:'BAG_7_5L:PICKUP',label:'袋装自提'}, {id:'BUCKET_18_9L:PICKUP',label:'桶装自提'}, {id:'BAG_7_5L:DELIVERY',label:'袋装配送'}, {id:'BUCKET_18_9L:DELIVERY',label:'桶装配送'}];
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function filterPlans(plans,category='ALL',query=''){
    const q=query.trim().toLowerCase();
    return plans.filter(p=>p.status==='ACTIVE'&&(category==='ALL'||`${p.waterType}:${p.fulfillMode}`===category)&&(!q||`${p.name} ${p.price} ${p.buyQty}`.toLowerCase().includes(q))).sort((a,b)=>a.price-b.price||a.buyQty-b.buyQty||a.name.localeCompare(b.name));
  }
  function open({selectedId=null}={}) {
    return new Promise(resolve=>{
      const d=document.createElement('dialog');d.className='membership-dialog plan-picker-dialog';
      d.innerHTML='<header><div><h2>选择充值套餐</h2><p class="membership-note">仅显示启用中的套餐，先选择分类再确认。</p></div><button type="button" class="btn sm" data-close aria-label="关闭套餐选择">关闭</button></header><div class="picker-search"><svg class="icon"><use href="#i-search"/></svg><input type="search" aria-label="搜索启用套餐" placeholder="搜索套餐名称、金额或数量"></div><div class="picker-layout"><nav class="picker-categories" aria-label="套餐分类"></nav><div class="picker-results" role="group" aria-label="启用套餐列表"><p>正在加载套餐…</p></div></div><p class="account-error" role="alert"></p><footer><span class="picker-selection">尚未选择套餐</span><button type="button" class="btn" data-cancel>取消</button><button type="button" class="btn primary" data-confirm disabled>确认选择</button></footer>';
      let plans=[],products=[],category='ALL',query='',selected=null,result=null;
      const results=d.querySelector('.picker-results'),error=d.querySelector('[role=alert]'),confirm=d.querySelector('[data-confirm]');
      const summary=()=>{d.querySelector('.picker-selection').textContent=selected?`已选择：${selected.name}`:'尚未选择套餐';confirm.disabled=!selected;};
      const render=()=>{
        const focus=document.activeElement;const focusPlan=focus?.dataset?.plan,focusCategory=focus?.dataset?.category;
        const active=filterPlans(plans);
        d.querySelector('.picker-categories').innerHTML=categories.map(c=>`<button type="button" data-category="${c.id}" aria-pressed="${category===c.id}">${c.label}<span>${filterPlans(active,c.id).length}</span></button>`).join('');
        d.querySelectorAll('[data-category]').forEach(b=>b.onclick=()=>{category=b.dataset.category;render();});
        const filtered=filterPlans(plans,category,query);
        results.innerHTML=`<div class="picker-result-count">${filtered.length} 个可选套餐</div><div class="picker-card-grid">${filtered.length?filtered.map(p=>{const product=products.find(x=>x.waterType===p.waterType),unit=p.waterType==='BAG_7_5L'?'袋':'桶';return `<button type="button" class="picker-plan-card" data-plan="${p.id}" aria-pressed="${p.id===selected?.id}"><span class="picker-card-top"><b>${esc(product?.name||'水票套餐')}</b><span>${p.fulfillMode==='PICKUP'?'门店自提':'上门配送'}</span></span><span class="picker-card-value"><strong>¥${Number(p.price).toFixed(2)}</strong><b>${p.buyQty+p.giftQty}<small>${unit}</small></b></span><span class="picker-card-name">${esc(p.name)}</span></button>`;}).join(''):'<p class="picker-empty">没有符合条件的启用套餐</p>'}</div>`;
        results.querySelectorAll('[data-plan]').forEach(b=>b.onclick=()=>{selected=active.find(p=>p.id===b.dataset.plan);error.textContent='';render();});summary();
        if(focusPlan)d.querySelector(`[data-plan="${focusPlan}"]`)?.focus();else if(focusCategory)d.querySelector(`[data-category="${focusCategory}"]`)?.focus();
      };
      d.querySelector('input').oninput=e=>{query=e.target.value;render();};
      d.querySelector('[data-close]').onclick=d.querySelector('[data-cancel]').onclick=()=>d.close();
      d.addEventListener('close',()=>{d.remove();resolve(result);},{once:true});
      confirm.onclick=async()=>{
        if(!selected||confirm.disabled)return;const chosenId=selected.id;confirm.disabled=true;confirm.textContent='正在确认…';
        try{
          const current=await window.KunlunLive.req('/api/plans');
          if(!d.isConnected)return;if(selected?.id!==chosenId){summary();return;}
          const fresh=current.find(p=>p.id===chosenId&&p.status==='ACTIVE');
          if(!fresh){plans=current;selected=null;error.textContent='该套餐已停用，请重新选择';render();return;}
          result=fresh;d.close();
        }catch(e){error.textContent=e.message;summary();}finally{confirm.textContent='确认选择';}
      };
      document.body.append(d);d.showModal();
      Promise.all([window.KunlunLive.req('/api/plans'),window.KunlunLive.req('/api/products')]).then(([p,water])=>{if(!d.isConnected)return;plans=p;products=water;selected=filterPlans(plans).find(p=>p.id===selectedId)||null;render();}).catch(e=>{if(d.isConnected){error.textContent=e.message;results.innerHTML='<p class="picker-empty">套餐加载失败，请关闭后重试</p>';}});
    });
  }
  return {categories,filterPlans,open};
});
