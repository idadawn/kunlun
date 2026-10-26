import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import net from 'node:net';
const root=fileURLToPath(new URL('..',import.meta.url));
const require=createRequire(import.meta.url);
const router=require('../assets/app-router.js');
const picker=require('../assets/plan-picker.js');
const routes=JSON.parse(readFileSync(join(root,'config/web-routes.json'),'utf8'));
test('clean URLs normalize legacy links, hashes and directory entries',()=>{
 assert.deepEqual(router.resolve('/admin.html','#plans'),{area:'admin',page:'plans',path:'/admin/plans'});
 assert.equal(router.resolve('/admin#plans'.split('#')[0],'#plans').path,'/admin/plans');
 assert.equal(router.resolve('/member.html','#records').path,'/member/records');
 assert.equal(router.resolve('/staff/orders/index.html').path,'/staff/orders');
 assert.equal(router.resolve('/admin/settings').path,'/admin/plans');
 assert.equal(router.resolve('/','', 'member').path,'/member');
 assert.equal(router.resolve('/member/home/').path,'/member');
 assert.equal(router.resolve('/admin/not-a-page'),null);
 assert.equal(router.resolve('/admin/%xx'),null);
});
test('every declared page has a canonical route and a built static entry',()=>{
 for(const [area,route] of Object.entries(routes))for(const page of route.pages){
  const path=router.pathFor(area,page);assert.ok(!path.includes('.html')&&!path.includes('#'));
  assert.equal(router.resolve(path).page,page);
  for(const app of ['admin-pc','mini-app']){
   const file=join(root,`apps/${app}/dist${path}/index.html`);
   const html=readFileSync(file,'utf8');assert.ok(html.includes(`data-app-area="${area}"`));assert.ok(html.includes('src="/assets/app-router.js"'));assert.ok(!/(?:src|href)="assets\//.test(html));
  }
 }
});
test('package classification and search never expose disabled packages',()=>{
 const plans=[{id:'a',name:'袋装自提100',waterType:'BAG_7_5L',fulfillMode:'PICKUP',price:100,buyQty:50,status:'ACTIVE'},{id:'b',name:'袋装自提499',waterType:'BAG_7_5L',fulfillMode:'PICKUP',price:499,buyQty:300,status:'ACTIVE'},{id:'c',name:'桶装配送100',waterType:'BUCKET_18_9L',fulfillMode:'DELIVERY',price:100,buyQty:13,status:'ACTIVE'},{id:'d',name:'停用袋装100',waterType:'BAG_7_5L',fulfillMode:'PICKUP',price:100,buyQty:100,status:'DISABLED'}];
 assert.equal(picker.filterPlans(plans).length,3);
 assert.deepEqual(picker.filterPlans(plans,'BAG_7_5L:PICKUP','499').map(p=>p.id),['b']);
 assert.deepEqual(picker.filterPlans(plans,'BUCKET_18_9L:DELIVERY').map(p=>p.id),['c']);
 assert.equal(picker.filterPlans(plans,'ALL','停用').length,0);
});
async function freePort(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));return port;}
for(const app of ['admin-pc','mini-app'])for(const mode of ['dev','preview']){
 test(`${app} ${mode}: direct navigation, refresh and assets use the correct app`,async()=>{
  const appRoot=join(root,'apps',app),r=createRequire(join(appRoot,'package.json')),pkg=r.resolve('vite/package.json');
  const entry=JSON.parse(readFileSync(pkg,'utf8')).exports['.'].import;
  const vite=await import(pathToFileURL(resolve(dirname(pkg),entry)).href);
  const port=await freePort();
  const config={root:appRoot,configFile:join(appRoot,'vite.config.ts'),logLevel:'silent',optimizeDeps:{noDiscovery:true,include:[],entries:[]},server:{host:'127.0.0.1',port,strictPort:true},preview:{host:'127.0.0.1',port,strictPort:true}};
  let server;
  try{
   server=mode==='dev'?await vite.createServer(config):await vite.preview(config);if(mode==='dev')await server.listen();
   const base=`http://127.0.0.1:${port}`;
   for(const [area,route] of Object.entries(routes))for(const page of route.pages){
    const path=router.pathFor(area,page);const response=await fetch(base+path);assert.equal(response.status,200,path);
    const html=await response.text();assert.ok(html.includes(`data-app-area="${area}"`),path);
   }
   const redirect=await fetch(base+'/admin.html',{redirect:'manual'});assert.equal(redirect.status,308);assert.equal(redirect.headers.get('location'),'/admin');
   const home=await fetch(base+'/',{redirect:'manual'});assert.equal(home.headers.get('location'),app==='admin-pc'?'/admin':'/member');
   assert.equal((await fetch(base+'/admin/no-such-page')).status,404);
   for(const asset of ['brand.css','app-router.js','route-config.js','plan-picker.js'])assert.equal((await fetch(base+'/assets/'+asset)).status,200,asset);
  }finally{if(server){if(mode==='dev')await server.close();else{server.httpServer.closeAllConnections?.();await new Promise(r=>server.httpServer.close(r));}}}
 });
}
