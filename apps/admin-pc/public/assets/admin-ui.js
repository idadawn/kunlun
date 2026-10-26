/* Presentation preferences only. Business permissions and data remain server-owned. */
(() => {
  const key='kunlun.sidebar.collapsed';
  let collapsed=false;
  try { collapsed=localStorage.getItem(key)==='true'; } catch { /* Storage can be unavailable in private browsing. */ }
  document.documentElement.classList.toggle('sidebar-collapsed',collapsed);
  const apply=(value,save=false)=>{
    collapsed=value;
    document.documentElement.classList.toggle('sidebar-collapsed',value);
    const toggle=document.getElementById('sidebarToggle');
    if(toggle){
      const label=value?'展开导航栏':'收起导航栏';
      toggle.setAttribute('aria-expanded',String(!value));
      toggle.setAttribute('aria-label',label);toggle.title=label;
    }
    if(save){try{localStorage.setItem(key,String(value));}catch{/* The control still works without persistence. */}}
  };
  document.addEventListener('DOMContentLoaded',()=>{
    const toggle=document.getElementById('sidebarToggle');
    if(!toggle)return;
    apply(collapsed);
    toggle.addEventListener('click',()=>apply(!collapsed,true));
  });
  window.addEventListener('storage',event=>{if(event.key===key)apply(event.newValue==='true');});
})();
