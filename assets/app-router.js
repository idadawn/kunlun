/* Shared clean routes for admin, staff and member applications. */
(function(root,factory){
  const config=typeof module==='object'&&module.exports?require('../config/web-routes.json'):root.KunlunRouteConfig;
  const router=factory(config,root);
  if(typeof module==='object'&&module.exports)module.exports=router;
  else root.KunlunRouter=router;
})(typeof window==='undefined'?null:window,function(config,win){
  const normalizePage=(area,page)=>area==='admin'&&page==='settings'?'plans':page;
  function pathFor(area,page) {
    page=normalizePage(area,page||config[area]?.home);
    if(!config[area]||!config[area].pages.includes(page))throw new Error('页面不存在');
    return '/'+area+(page===config[area].home?'':'/'+page);
  }
  function resolve(pathname,hash='',defaultArea='admin') {
    let path;
    try{path=decodeURIComponent(pathname);}catch{return null;}
    path=path.replace(/\/+$/,'')||'/';
    let area=defaultArea,page;
    const old=/^\/(admin|staff|member)\.html$/.exec(path);
    if(old){area=old[1];}
    else if(path!=='/'&&path!=='/index.html'){
      const parts=path.replace(/\/index\.html$/,'').split('/').filter(Boolean);
      area=parts[0];if(!config[area]||parts.length>2)return null;
      page=parts[1];
    }
    if(!config[area])return null;
    if(!page&&hash){try{page=decodeURIComponent(hash.replace(/^#/,''));}catch{return null;}}
    page=normalizePage(area,page||config[area].home);
    if(!config[area].pages.includes(page))return null;
    return {area,page,path:pathFor(area,page)};
  }
  let activeArea,renderPage;
  function navigate(page,{replace=false}={}) {
    const path=pathFor(activeArea,page);
    if(win.location.pathname!==path||win.location.hash){win.history[replace?'replaceState':'pushState'](null,'',path+win.location.search);}
    renderPage(normalizePage(activeArea,page));
  }
  function mount(area,render) {
    activeArea=area;renderPage=render;
    const route=resolve(win.location.pathname,win.location.hash,area);
    if(!route||route.area!==area){win.location.replace(pathFor(area,config[area].home));return;}
    navigate(route.page,{replace:true});
  }
  if(win){
    const area=win.document.documentElement.dataset.appArea;
    const initial=resolve(win.location.pathname,win.location.hash,area);
    if(initial)win.history.replaceState(null,'',initial.path+win.location.search);
    win.addEventListener('popstate',()=>{
      if(!renderPage)return;
      const route=resolve(win.location.pathname,win.location.hash,activeArea);
      if(!route||route.area!==activeArea){win.location.reload();return;}
      win.document.querySelectorAll('dialog[open]').forEach(d=>d.close());
      renderPage(route.page);
    });
    win.document.addEventListener('click',event=>{
      const link=event.target.closest?.('a[data-route-page]');
      if(!link||!renderPage||event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
      event.preventDefault();navigate(link.dataset.routePage);
    });
  }
  return {config,resolve,pathFor,navigate,mount};
});
