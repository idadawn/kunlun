/* Stock and member circulation have separate screens and transactional APIs. */
(() => {
  const live=()=>window.KunlunLive;
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money=v=>Number(v||0).toFixed(2);
  const time=v=>new Date(v).toLocaleString('zh-CN',{hour12:false});
  const names={BAG:'周转水袋',BUCKET:'周转桶'};
  const sources={AVAILABLE:'门店可用',INSPECTING:'待检',ABNORMAL:'异常待处理',DAMAGED:'门店破损'};
  const columns={AVAILABLE:'inStationQty',INSPECTING:'inspectingQty',ABNORMAL:'abnormalQty',DAMAGED:'damagedQty'};
  const permission=p=>live().session?.permissions.includes('kunlun.waterstation:'+p);
  const manage=()=>permission('container:inventory_manage');
  const canScrap=()=>manage()&&permission('deposit:refund_approve');
  const run=fn=>(...args)=>Promise.resolve(fn(...args)).catch(e=>window.GQ.toast(e.message));
  let tab='holdings',page=1,query='',type='',damageStatus='PENDING',renderVersion=0;
  const empty=(n,text)=>`<tr><td colspan="${n}" class="inventory-empty">${text}</td></tr>`;
  const badge=(label,color='green')=>`<span class="tag ${color}">${label}</span>`;
  const pager=data=>`<footer class="container-pager"><span>共 ${data.total} 条 · 第 ${data.page} / ${Math.max(1,Math.ceil(data.total/20))} 页</span><div><button class="btn sm" data-prev ${page<=1?'disabled':''}>上一页</button><button class="btn sm" data-next ${page*20>=data.total?'disabled':''}>下一页</button></div></footer>`;
  function dialog(title,body,label,submit){
    const d=document.createElement('dialog');d.className='membership-dialog inventory-dialog';
    d.innerHTML=`<form><header><h2>${title}</h2><button type="button" class="btn sm" data-close aria-label="关闭">关闭</button></header><div class="membership-fields">${body}</div><p class="account-error" role="alert"></p><footer><button class="btn primary" type="submit">${label}</button></footer></form>`;
    d.querySelector('[data-close]').onclick=()=>d.close();d.onclose=()=>d.remove();
    const key=crypto.randomUUID();
    d.querySelector('form').onsubmit=async e=>{
      e.preventDefault();const b=d.querySelector('[type=submit]');if(b.disabled)return;b.disabled=true;
      try{await submit(d,key);d.close();await live().refreshPage();await render();}catch(err){if(d.isConnected)d.querySelector('[role=alert]').textContent=err.message;else window.GQ.toast(err.message);}finally{b.disabled=false;}
    };
    document.body.append(d);d.showModal();return d;
  }
  const reasonField=(value='')=>`<label for="operationReason">原因 / 备注</label><textarea id="operationReason" class="input" maxlength="500" rows="3" required placeholder="填写来源或处理原因">${esc(value)}</textarea>`;
  async function render(){
    if(document.getElementById('page-inventory')?.classList.contains('active'))await renderInventory();
    else if(document.getElementById('page-assets')?.classList.contains('active'))await renderLedger();
  }
  async function renderInventory(){
    const root=document.getElementById('inventoryContent');if(!root)return;
    const [configs,history]=await Promise.all([live().req('/api/containers/summary'),manage()?live().req('/api/containers/inventory-operations'):Promise.resolve([])]);
    live().containers=configs;
    root.innerHTML=`<div class="table-card"><div class="table-toolbar"><div><b>袋桶库存</b><small>按实物数量登记入库与报废</small></div></div><div class="inventory-table-scroll"><table><thead><tr><th>容器</th><th>现存总量</th><th>门店可用</th><th>会员持有</th><th>在途</th><th>待检 / 异常</th><th>待处理破损</th><th>累计报废</th><th>操作</th></tr></thead><tbody>${configs.map(c=>`<tr><td><b>${names[c.containerType]}</b><br><small>押金 ¥${money(c.unitDeposit)} / 个</small></td><td><b>${c.totalQty}</b></td><td>${c.inStationQty}</td><td>${c.memberHeldQty}</td><td>${c.inTransitQty}</td><td>${c.inspectingQty} / ${c.abnormalQty}</td><td>${c.damagedQty}</td><td>${c.scrappedQty}</td><td><div class="container-row-actions"><button class="text-btn" data-receive="${c.containerType}" ${manage()?'':'disabled'}>入库</button><button class="text-btn danger" data-stock-scrap="${c.containerType}" ${manage()?'':'disabled'}>报废</button></div></td></tr>`).join('')}</tbody></table></div></div><p class="membership-note">现存总量不包含已报废数量。会员归还的破损袋桶，请在「袋桶台账」确认报废并扣押金。</p>${manage()?`<div class="table-card"><div class="table-toolbar"><div><b>入库与报废记录</b><small>最近 100 笔，包含会员报废联动记录</small></div><button class="btn sm" data-export-stock>导出全部记录</button></div><div class="inventory-table-scroll"><table><thead><tr><th>时间 / 单号</th><th>容器</th><th>业务</th><th>数量</th><th>现存总量</th><th>关联会员 / 原因</th><th>操作人</th></tr></thead><tbody>${history.length?history.map(({operation:o,memberName})=>`<tr><td>${time(o.createdAt)}<br><small>${esc(o.operationNo)}</small></td><td>${names[o.containerType]}</td><td>${badge(o.action==='RECEIVE'?'入库':'报废',o.action==='RECEIVE'?'green':'orange')}</td><td>${o.action==='RECEIVE'?'+':'−'}${o.quantity}</td><td>${o.before.totalQty} → ${o.after.totalQty}</td><td class="inventory-reason">${memberName?`<b>${esc(memberName)}</b><br>`:''}${esc(o.reason)}</td><td>${esc(o.operatorName)}</td></tr>`).join(''):empty(7,'暂无入库或报废记录')}</tbody></table></div></div>`:''}`;
    root.querySelectorAll('[data-receive]').forEach(b=>b.onclick=run(()=>stock(b.dataset.receive,'RECEIVE')));
    root.querySelectorAll('[data-stock-scrap]').forEach(b=>b.onclick=run(()=>stock(b.dataset.stockScrap,'SCRAP')));
    const exp=root.querySelector('[data-export-stock]');if(exp)exp.onclick=run(()=>exportCsv('inventory-operations','袋桶入库报废记录'));
  }
  async function stock(containerType,action){
    const configs=await live().req('/api/containers/summary'),config=configs.find(c=>c.containerType===containerType),scrap=action==='SCRAP';
    dialog(`${names[containerType]} · ${scrap?'报废':'入库'}`,`<div class="membership-summary">${scrap?'报废将扣减现存总量。会员破损请在袋桶台账办理。':'新购入的袋桶计入门店可用库存。'}</div>${scrap?`<label for="stockSource">报废来源</label><select id="stockSource" class="select">${Object.entries(sources).map(([id,name])=>`<option value="${id}">${name} · ${id==='DAMAGED'?config.damagedQty-config.pendingMemberDamageQty:config[columns[id]]} 个${id==='DAMAGED'?'（不含会员待报废部分）':''}</option>`).join('')}</select>`:''}<label for="stockQty">数量（个）</label><input id="stockQty" class="input" type="number" min="1" max="1000000" step="1" value="1" required>${reasonField()}`,scrap?'确认报废':'确认入库',async(d,key)=>{
      await live().req('/api/containers/inventory',{method:'POST',body:JSON.stringify({containerType,action,quantity:Number(d.querySelector('#stockQty').value),sourceState:scrap?d.querySelector('#stockSource').value:'AVAILABLE',reason:d.querySelector('#operationReason').value.trim(),idempotencyKey:key})});window.GQ.toast(scrap?'已报废，库存已扣减':'入库成功');
    });
  }
  async function renderLedger(){
    const root=document.getElementById('circulationContent');if(!root)return;
    const version=++renderVersion,params=new URLSearchParams({q:query,page:String(page)});
    if(tab!=='holdings'){params.set('containerType',type);if(tab==='damages')params.set('status',damageStatus);}
    const result=await live().req('/api/containers/'+({holdings:'holdings',movements:'circulation',damages:'damages'})[tab]+'?'+params);
    if(version!==renderVersion)return;
    const tool=`<div class="container-ledger-toolbar"><div class="container-tabs" role="tablist" aria-label="台账视图">${[['holdings','会员持有'],['movements','周转流水'],['damages','破损报废']].map(([id,label])=>`<button role="tab" aria-selected="${tab===id}" class="${tab===id?'active':''}" data-ledger-tab="${id}">${label}</button>`).join('')}</div><div class="container-filters"><input class="input" type="search" id="circulationSearch" aria-label="搜索会员或单号" value="${esc(query)}" placeholder="姓名、手机号、会员号或单号"><button class="btn sm" data-search>查询</button>${tab!=='holdings'?`<select class="select" id="circulationType" aria-label="容器类型"><option value="">全部容器</option><option value="BAG">周转水袋</option><option value="BUCKET">周转桶</option></select>`:''}${tab==='damages'?`<select class="select" id="damageStatus" aria-label="破损状态"><option value="PENDING">待报废</option><option value="SCRAPPED">已报废</option><option value="">全部状态</option></select>`:''}</div></div>`;
    let table;
    if(tab==='holdings')table=`<thead><tr><th>会员</th><th>手机号</th><th>持有水袋</th><th>持有桶</th><th>押金余额</th><th>待报废</th><th>操作</th></tr></thead><tbody>${result.rows.length?result.rows.map(m=>`<tr><td><b>${esc(m.name)}</b><br><small>${esc(m.memberNo)}</small></td><td>${esc(m.phone)}</td><td>${m.heldBags} 个</td><td>${m.heldBuckets} 个</td><td>¥${money(m.depositAmount)}</td><td>${m.pendingDamageQty} 个<br><small>占用押金 ¥${money(m.pendingDamageAmount)}</small></td><td><button class="text-btn" data-damage-member="${m.id}" ${manage()&&m.heldBags+m.heldBuckets>0?'':'disabled'}>登记破损</button></td></tr>`).join(''):empty(7,'暂无持有袋桶或待报废的会员')}</tbody>`;
    else if(tab==='movements')table=`<thead><tr><th>时间 / 单号</th><th>会员</th><th>容器 / 业务</th><th>领出 / 归还 / 报废</th><th>持有变化 / 结余</th><th>扣押金</th><th>关联单号 / 原因</th><th>操作人</th></tr></thead><tbody>${result.rows.length?result.rows.map(r=>`<tr><td>${time(r.createdAt)}<br><small>${esc(r.ledgerNo)}</small></td><td><b>${esc(r.memberName)}</b><br><small>${esc(r.memberNo)}</small></td><td>${names[r.containerType]}<br>${badge(({TURNOVER:'领还周转',DAMAGE_RETURN:'破损归还',SCRAP:'报废扣押金'})[r.businessType]||'领还周转',r.businessType==='SCRAP'?'orange':'green')}</td><td>${r.fullOutQty} / ${r.emptyInQty} / ${r.scrappedQty}</td><td>${r.deltaHeld>0?'+':''}${r.deltaHeld}<br><small>持有 ${r.heldAfter} 个</small></td><td>${r.depositDeductedAmount?'−¥'+money(r.depositDeductedAmount):'—'}</td><td class="inventory-reason"><small>${esc(r.referenceNo)}</small><br>${esc(r.remark)}</td><td>${esc(r.operatorName)}</td></tr>`).join(''):empty(8,'暂无周转记录')}</tbody>`;
    else table=`<thead><tr><th>时间 / 破损单号</th><th>会员</th><th>容器 / 数量</th><th>原实收押金</th><th>状态</th><th>原因</th><th>操作</th></tr></thead><tbody>${result.rows.length?result.rows.map(r=>`<tr><td>${time(r.createdAt)}<br><small>${esc(r.damageNo)}</small></td><td><b>${esc(r.memberName)}</b><br><small>${esc(r.memberNo)}</small></td><td>${names[r.containerType]} × ${r.quantity}</td><td>¥${money(r.depositAmount)}<br><small>${r.status==='PENDING'?'待报废时扣除':'已扣除'}</small></td><td>${badge(r.status==='PENDING'?'待报废':'已报废',r.status==='PENDING'?'orange':'gray')}</td><td class="inventory-reason">${esc(r.reason)}${r.scrapReason?`<br><small>报废：${esc(r.scrapReason)}</small>`:''}</td><td>${r.status==='PENDING'?`<button class="text-btn danger" data-confirm-scrap="${r.id}" ${canScrap()?'':'disabled'}>报废并扣押金</button>`:`<small class="container-reference" title="${esc(r.scrapNo)}">${esc(r.scrapNo)}</small>`}</td></tr>`).join(''):empty(7,'暂无符合条件的破损记录')}</tbody>`;
    root.innerHTML=`${tool}<div class="table-card"><div class="inventory-table-scroll"><table>${table}</table></div>${pager(result)}</div>`;
    root.querySelectorAll('[data-ledger-tab]').forEach(b=>b.onclick=run(async()=>{tab=b.dataset.ledgerTab;page=1;await renderLedger();}));
    const search=run(async()=>{query=root.querySelector('#circulationSearch').value.trim();page=1;await renderLedger();});root.querySelector('[data-search]').onclick=search;
    root.querySelector('#circulationSearch').onkeydown=e=>{if(e.key==='Enter')search();};
    const select=root.querySelector('#circulationType');if(select){select.value=type;select.onchange=run(async()=>{type=select.value;page=1;await renderLedger();});}
    const status=root.querySelector('#damageStatus');if(status){status.value=damageStatus;status.onchange=run(async()=>{damageStatus=status.value;page=1;await renderLedger();});}
    root.querySelector('[data-prev]').onclick=run(async()=>{page--;await renderLedger();});root.querySelector('[data-next]').onclick=run(async()=>{page++;await renderLedger();});
    root.querySelectorAll('[data-damage-member]').forEach(b=>b.onclick=run(()=>reportDamage(result.rows.find(r=>r.id===b.dataset.damageMember))));
    root.querySelectorAll('[data-confirm-scrap]').forEach(b=>b.onclick=()=>confirmScrap(result.rows.find(r=>r.id===b.dataset.confirmScrap)));
  }
  async function reportDamage(member){
    if(!manage())throw new Error('需要袋桶维护权限');
    let members=member?[member]:await live().req('/api/members');
    const d=dialog('登记破损归还',`<div class="membership-summary">实物收回后登记。减少会员持有、转入待报废；此时不扣押金，对应押金暂不可退款或用于新领用。</div><label for="damageMemberSearch">查找会员</label><div class="container-search"><input class="input" id="damageMemberSearch" placeholder="姓名、手机号或会员号"><button type="button" class="btn sm" data-find-member>查询</button></div><label for="damageMember">会员</label><select id="damageMember" class="select" required></select><label for="damageType">容器类型</label><select id="damageType" class="select"><option value="BAG">周转水袋</option><option value="BUCKET">周转桶</option></select><p class="membership-note" data-held></p><label for="damageQuantity">已收回破损数量（个）</label><input id="damageQuantity" class="input" type="number" min="1" max="10000" step="1" value="1" required>${reasonField()}`,'登记破损归还',async(form,key)=>{
      await live().req('/api/containers/damages',{method:'POST',body:JSON.stringify({memberId:form.querySelector('#damageMember').value,containerType:form.querySelector('#damageType').value,quantity:Number(form.querySelector('#damageQuantity').value),reason:form.querySelector('#operationReason').value.trim(),idempotencyKey:key})});tab='damages';damageStatus='PENDING';query='';page=1;window.GQ.toast('破损已登记，押金尚未扣除');
    });
    const update=()=>{const m=members.find(m=>m.id===d.querySelector('#damageMember').value),isBag=d.querySelector('#damageType').value==='BAG';d.querySelector('[data-held]').textContent=m?`当前持有${isBag?'水袋':'桶'} ${m[isBag?'heldBags':'heldBuckets']} 个 · 押金余额 ¥${money(m.depositAmount)}`:'请选择会员';};
    const populate=()=>{d.querySelector('#damageMember').innerHTML='<option value="">请选择会员</option>'+members.map(m=>`<option value="${m.id}">${esc(m.name+' · '+m.memberNo)}</option>`).join('');if(member){d.querySelector('#damageMember').value=member.id;d.querySelector('#damageType').value=member.heldBags>0?'BAG':'BUCKET';}update();};
    const find=run(async()=>{members=await live().req('/api/members?q='+encodeURIComponent(d.querySelector('#damageMemberSearch').value.trim()));member=null;populate();});
    d.querySelector('[data-find-member]').onclick=find;d.querySelector('#damageMemberSearch').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();find();}};
    d.querySelector('#damageMember').onchange=update;d.querySelector('#damageType').onchange=update;populate();
  }
  function confirmScrap(r){
    dialog('确认报废并扣押金',`<div class="scrap-confirmation"><b>${esc(r.memberName)} · ${names[r.containerType]} ${r.quantity} 个</b><p>本次扣除押金 <strong>¥${money(r.depositAmount)}</strong></p><small>按原实收批次结算：${r.lotBreakdown.map(l=>`${l.quantity} 个 × ¥${money(l.unitPrice)}`).join(' + ')}</small></div><p class="membership-note">确认后减少现存库存，增加累计报废，并扣除会员押金余额；不会再减少会员持有数量。</p>${reasonField(r.reason)}`,'确认报废并扣押金',async(d,key)=>{
      const receipt=await live().req('/api/containers/damages/'+r.id+'/scrap',{method:'POST',body:JSON.stringify({reason:d.querySelector('#operationReason').value.trim(),idempotencyKey:key})});window.GQ.toast('报废完成，已扣押金 ¥'+money(receipt.deductedAmount));
    });
  }
  async function exportCsv(dataset,name){
    const res=await fetch(live().baseUrl+'/api/exports/'+dataset,{headers:{Authorization:'Bearer '+live().token}});if(!res.ok)throw new Error('导出失败，请稍后重试');
    const url=URL.createObjectURL(await res.blob()),a=document.createElement('a');a.href=url;a.download=name+'.csv';a.click();URL.revokeObjectURL(url);
  }
  window.KunlunInventory={render,reportDamage:run(reportDamage),exportLedger:run(()=>exportCsv('container-ledgers','袋桶周转台账'))};
})();
