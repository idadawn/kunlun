/* Reusable bucket/bag inventory operations. Monetary deposits are settled separately. */
(() => {
  const live=()=>window.KunlunLive;
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const names={BUCKET:'周转桶',BAG:'周转水袋'};
  const actions={RECEIVE:'采购入库',DAMAGE:'破损登记',REPAIR:'修复入库',SCRAP:'确认报废',COUNT:'库存盘点'};
  const sources={AVAILABLE:'门店可用',TRANSIT:'配送在途',INSPECTING:'待检',ABNORMAL:'异常待处理',MEMBER:'会员归还（破损）',DAMAGED:'破损待处理',EXTERNAL:'外部入库'};
  const columns={AVAILABLE:'inStationQty',TRANSIT:'inTransitQty',INSPECTING:'inspectingQty',ABNORMAL:'abnormalQty',MEMBER:'memberHeldQty',DAMAGED:'damagedQty'};
  const permitted=()=>live().session?.permissions.includes('kunlun.waterstation:container:inventory_manage');
  const run=fn=>(...args)=>Promise.resolve(fn(...args)).catch(e=>window.GQ.toast(e.message));
  let filter='';
  async function render(){
    const root=document.getElementById('inventorySummary');if(!root)return;
    const configs=await live().req('/api/containers/summary');live().containers=configs;
    root.innerHTML=`<div class="inventory-grid">${configs.map(c=>`<article class="inventory-card"><header><div><h3>${names[c.containerType]}</h3><small>可回收周转 · 押金 ¥${Number(c.unitDeposit).toFixed(2)} / 个</small></div><span class="tag ${c.identityValid?'green':'orange'}">${c.identityValid?'台账平衡':'需核对台账'}</span></header><div class="inventory-total"><span>现存总量</span><b>${c.totalQty}<small>个</small></b><button class="btn primary sm" data-manage="${c.containerType}" ${permitted()?'':'disabled'}>维护数量</button></div><div class="inventory-metrics">${[['门店可用',c.inStationQty],['会员持有',c.memberHeldQty],['在途',c.inTransitQty],['待检',c.inspectingQty],['异常',c.abnormalQty],['破损待处理',c.damagedQty||0]].map(([label,value])=>`<div class="${label==='破损待处理'?'inventory-damaged':''}"><span>${label}</span><b>${value}</b></div>`).join('')}</div><footer><span>累计报废 <b>${c.scrappedQty||0}</b> 个（不计入现存总量）</span><span>${c.lowStockWarning?'可用库存低于预警值 '+c.warnThreshold:'可用库存正常'}</span></footer></article>`).join('')}</div>`;
    root.querySelectorAll('[data-manage]').forEach(b=>b.onclick=run(()=>open(b.dataset.manage)));
    const history=document.getElementById('inventoryHistory');if(!permitted()){history.innerHTML='';return;}
    const rows=await live().req('/api/containers/inventory-operations'+(filter?'?containerType='+filter:''));
    history.innerHTML=`<div class="table-card inventory-ledger"><div class="table-toolbar"><div><b>库存维护流水</b><small>最近 100 笔 · 入库、破损、修复、报废与盘点</small></div><div class="membership-actions"><select class="select" aria-label="库存流水容器类型"><option value="">全部容器</option><option value="BUCKET">周转桶</option><option value="BAG">周转水袋</option></select><button class="btn sm" data-export>导出全部流水</button></div></div><div class="inventory-table-scroll"><table><thead><tr><th>时间 / 单号</th><th>容器</th><th>业务</th><th>数量</th><th>位置变化</th><th>原因 / 关联会员</th><th>操作人</th></tr></thead><tbody>${rows.length?rows.map(({operation:o,memberName})=>{const source=o.action==='RECEIVE'?'AVAILABLE':o.sourceState,col=columns[source];return `<tr><td>${esc(new Date(o.createdAt).toLocaleString('zh-CN'))}<br><small>${esc(o.operationNo)}</small></td><td>${names[o.containerType]}</td><td>${actions[o.action]}</td><td>${o.action==='COUNT'&&o.quantity>0?'+':''}${o.quantity}</td><td>${sources[source]} ${o.before[col]} → ${o.after[col]}<br><small>总量 ${o.before.totalQty} → ${o.after.totalQty}${o.action==='DAMAGE'?` · 破损 ${o.before.damagedQty} → ${o.after.damagedQty}`:''}</small></td><td class="inventory-reason">${esc(o.reason)}${memberName?`<br><small>${esc(memberName)}</small>`:''}</td><td>${esc(o.operatorName)}</td></tr>`;}).join(''):'<tr><td colspan="7" class="inventory-empty">暂无库存维护记录</td></tr>'}</tbody></table></div></div>`;
    const select=history.querySelector('select');select.value=filter;select.onchange=run(async e=>{filter=e.target.value;await render();});history.querySelector('[data-export]').onclick=run(exportOperations);
  }
  async function open(type='BUCKET'){
    if(!permitted())throw new Error('需要管理员库存维护权限');
    const [configs,members]=await Promise.all([live().req('/api/containers/summary'),live().req('/api/members')]);
    const key=crypto.randomUUID(),d=document.createElement('dialog');d.className='membership-dialog inventory-dialog';
    d.innerHTML=`<form><header><h2>桶袋库存维护</h2><button class="btn sm" type="button" data-close aria-label="关闭库存维护">关闭</button></header><div class="membership-fields"><label for="inventoryType">容器类型</label><select id="inventoryType" class="select">${Object.entries(names).map(([id,name])=>`<option value="${id}">${name}</option>`).join('')}</select><label for="inventoryAction">业务类型</label><select id="inventoryAction" class="select">${Object.entries(actions).map(([id,name])=>`<option value="${id}">${name}</option>`).join('')}</select><div data-source class="inventory-field"><label for="inventorySource">来源位置</label><select id="inventorySource" class="select"></select></div><div data-member class="inventory-field"><label for="inventoryMember">已归还破损容器的会员</label><select id="inventoryMember" class="select"><option value="">请选择会员</option>${members.map(m=>`<option value="${m.id}">${esc(m.name+' · '+m.memberNo)}</option>`).join('')}</select></div><label for="inventoryQuantity" data-quantity-label>操作数量</label><input id="inventoryQuantity" class="input" type="number" min="1" max="1000000" step="1" value="1" required><div class="membership-summary" data-preview></div><label for="inventoryReason">原因 / 备注</label><textarea id="inventoryReason" class="input" rows="3" maxlength="500" required placeholder="填写入库来源、破损原因、报废依据或盘点说明"></textarea><p class="membership-note" data-note></p></div><p class="account-error" role="alert"></p><footer><button class="btn primary" type="submit">确认登记</button></footer></form>`;
    d.querySelector('[data-close]').onclick=()=>d.close();d.addEventListener('close',()=>d.remove());
    const field=id=>d.querySelector('#inventory'+id);field('Type').value=type;
    const config=()=>configs.find(c=>c.containerType===field('Type').value);
    const sourceQty=()=>config()[columns[field('Source').value]]||0;
    const refreshPreview=()=>{
      const c=config(),action=field('Action').value,qty=Number(field('Quantity').value),source=field('Source').value;
      d.querySelector('[data-member]').hidden=!(action==='DAMAGE'&&source==='MEMBER');
      field('Member').required=action==='DAMAGE'&&source==='MEMBER';
      let text=`现存 ${c.totalQty} 个 · 可用 ${c.inStationQty} 个 · 破损待处理 ${c.damagedQty||0} 个。`;
      if(action==='RECEIVE')text+=` 本次入库 ${qty} 个，可用和现存总量各增加 ${qty} 个。`;
      else if(action==='COUNT'){const delta=qty-sourceQty();text+=` ${sources[source]}账面 ${sourceQty()} 个，实盘 ${qty} 个，${delta>0?'盘盈 '+delta:delta<0?'盘亏 '+(-delta):'账实一致'}。`;}
      else if(action==='DAMAGE'){
        const m=members.find(m=>m.id===field('Member').value),available=source==='MEMBER'?(m?.[c.containerType==='BUCKET'?'heldBuckets':'heldBags']??'—'):sourceQty();
        text+=` 来源当前 ${available} 个，本次 ${qty} 个转入破损待处理，现存总量不变。`;
      }else if(action==='REPAIR')text+=` 修复 ${qty} 个后转回可用库存，现存总量不变。`;
      else text+=` 报废 ${qty} 个，现存总量减少 ${qty} 个，累计报废增加 ${qty} 个。`;
      d.querySelector('[data-preview]').textContent=text;
      d.querySelector('[data-note]').textContent=action==='COUNT'?'提交时核对账面数量；库存已变化时需重新打开并盘点。':action==='DAMAGE'&&source==='MEMBER'?'确认实物已收回后登记；会员持有会减少，押金和赔偿另行结算。':'库存操作不自动改变水票或押金余额，每笔保留操作记录。';
      d.querySelector('[type=submit]').textContent=action==='SCRAP'?'确认报废':action==='COUNT'?'确认盘点':'确认登记';
    };
    const refreshFields=()=>{
      const action=field('Action').value;
      const choices=action==='COUNT'?['AVAILABLE','INSPECTING','DAMAGED','ABNORMAL','TRANSIT']:['AVAILABLE','INSPECTING','ABNORMAL','TRANSIT','MEMBER'];
      field('Source').innerHTML=choices.map(s=>`<option value="${s}">${sources[s]}</option>`).join('');
      d.querySelector('[data-source]').hidden=!['DAMAGE','COUNT'].includes(action);
      d.querySelector('[data-source] label').textContent=action==='COUNT'?'盘点位置':'来源位置';
      d.querySelector('[data-quantity-label]').textContent=action==='COUNT'?'实盘数量':'操作数量';field('Quantity').min=action==='COUNT'?'0':'1';field('Quantity').value=action==='COUNT'?sourceQty():1;refreshPreview();
    };
    field('Type').onchange=refreshFields;field('Action').onchange=refreshFields;field('Source').onchange=()=>{if(field('Action').value==='COUNT')field('Quantity').value=sourceQty();refreshPreview();};field('Member').onchange=refreshPreview;field('Quantity').oninput=refreshPreview;
    d.querySelector('form').onsubmit=async e=>{
      e.preventDefault();const button=d.querySelector('[type=submit]');if(button.disabled)return;button.disabled=true;
      try{
        const action=field('Action').value,source=field('Source').value,qty=Number(field('Quantity').value);
        const req={containerType:field('Type').value,action,reason:field('Reason').value.trim(),idempotencyKey:key,quantity:action==='COUNT'?0:qty,sourceState:['DAMAGE','COUNT'].includes(action)?source:'AVAILABLE',memberId:action==='DAMAGE'&&source==='MEMBER'?(field('Member').value||null):null,countedQuantity:action==='COUNT'?qty:null,expectedQuantity:action==='COUNT'?sourceQty():null};
        const result=await live().req('/api/containers/inventory',{method:'POST',body:JSON.stringify(req)});
        await live().refreshPage();await render();d.close();window.GQ.toast(`${actions[action]}已登记：${result.operationNo}`);
      }catch(err){d.querySelector('[role=alert]').textContent=err.message;}finally{button.disabled=false;}
    };
    refreshFields();document.body.append(d);d.showModal();
  }
  async function exportOperations(){
    const res=await fetch(live().baseUrl+'/api/exports/inventory-operations',{headers:{Authorization:'Bearer '+live().token}});
    if(!res.ok)throw new Error('库存流水导出失败，请重新登录后重试');
    const url=URL.createObjectURL(await res.blob()),a=document.createElement('a');a.href=url;a.download='桶袋库存维护流水.csv';a.click();URL.revokeObjectURL(url);
  }
  window.KunlunInventory={render,open:run(open)};
})();
