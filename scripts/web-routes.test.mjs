import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import net from 'node:net';
import {WEB_ROUTES,resolveRoute,pathFor} from '../packages/shared/src/routes.ts';
import {filterPlans} from '../packages/shared/src/plans.ts';
const root=fileURLToPath(new URL('..',import.meta.url));
const APPS={'admin-pc':['admin'],'mini-app':['member','staff']};
const allPaths=area=>[`/${area}`,...WEB_ROUTES[area].pages.map(p=>`/${area}/${p}`),...Object.keys(WEB_ROUTES[area].aliases||{}).map(p=>`/${area}/${p}`)];

test('clean URLs resolve pages and aliases; .html and hash links are not routes',()=>{
 assert.deepEqual(resolveRoute('/admin/plans'),{area:'admin',page:'plans',path:'/admin/plans'});
 assert.equal(resolveRoute('/admin/settings').path,'/admin/plans');
 assert.equal(resolveRoute('/admin/deposit-settings').path,'/admin/products');
 assert.equal(resolveRoute('/member/home/').path,'/member');
 assert.deepEqual(resolveRoute('/member/addresses'),{area:'member',page:'addresses',path:'/member/addresses'});
 for(const bad of ['/admin.html','/member.html','/index.html','/admin/index.html','/staff/orders/index.html','/admin/not-a-page','/admin/plans/extra','/admin/%xx','/'])assert.equal(resolveRoute(bad),null,bad);
 for(const [area,route] of Object.entries(WEB_ROUTES))for(const page of route.pages){const path=pathFor(area,page);assert.ok(!path.includes('.html'));assert.equal(resolveRoute(path).page,page);}
});

test('nginx serves exactly the declared routes from the right app',()=>{
 const conf=readFileSync(join(root,'deploy/nginx.conf'),'utf8');
 const blocks=[...conf.matchAll(/location ~ (\S+) \{\s*root \/srv\/kunlun\/([\w-]+);/g)].map(([,regex,app])=>({app,regex:new RegExp(regex)}));
 assert.deepEqual(blocks.map(b=>b.app).sort(),Object.keys(APPS).sort());
 for(const [app,areas] of Object.entries(APPS))for(const area of areas)for(const path of allPaths(area)){
  assert.deepEqual(blocks.filter(b=>b.regex.test(path)).map(b=>b.app),[app],path);
 }
 for(const bad of ['/admin.html','/member/index.html','/admin/nope','/staff/addresses','/static/admin/x.js'])assert.ok(!blocks.some(b=>b.regex.test(bad)),bad);
});

test('package classification and search never expose disabled packages',()=>{
 const plans=[{id:'a',name:'袋装自提100',waterType:'BAG_7_5L',fulfillMode:'PICKUP',price:100,buyQty:50,status:'ACTIVE'},{id:'b',name:'袋装自提499',waterType:'BAG_7_5L',fulfillMode:'PICKUP',price:499,buyQty:300,status:'ACTIVE'},{id:'c',name:'桶装配送100',waterType:'BUCKET_18_9L',fulfillMode:'DELIVERY',price:100,buyQty:13,status:'ACTIVE'},{id:'d',name:'停用袋装100',waterType:'BAG_7_5L',fulfillMode:'PICKUP',price:100,buyQty:50,status:'DISABLED'}];
 assert.equal(filterPlans(plans).length,3);
 assert.deepEqual(filterPlans(plans,'BAG_7_5L:PICKUP','499').map(p=>p.id),['b']);
 assert.deepEqual(filterPlans(plans,'BUCKET_18_9L:DELIVERY').map(p=>p.id),['c']);
 assert.equal(filterPlans(plans,'ALL','停用').length,0);
});

async function freePort(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));return port;}
for(const [app,areas] of Object.entries(APPS))for(const mode of ['dev','preview']){
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
   let html='';
   for(const area of areas)for(const path of allPaths(area)){
    const response=await fetch(base+path);assert.equal(response.status,200,path);
    html=await response.text();assert.ok(html.includes('<div id="root"></div>'),path);
   }
   for(const other of Object.keys(WEB_ROUTES).filter(a=>!areas.includes(a)))assert.equal((await fetch(base+'/'+other)).status,404,other);
   for(const legacy of ['/admin.html','/staff.html','/member.html','/index.html',`/${areas[0]}/index.html`])assert.equal((await fetch(base+legacy,{redirect:'manual'})).status,404,legacy);
   const home=await fetch(base+'/',{redirect:'manual'});assert.equal(home.status,308);assert.equal(home.headers.get('location'),'/'+areas[0]);
   assert.equal((await fetch(base+`/${areas[0]}/no-such-page`)).status,404);
   const script=html.match(/<script type="module"[^>]* src="([^"]+)"/)[1];
   assert.ok(script.startsWith('/'),'entry script uses an absolute path');
   if(mode==='preview')assert.match(script,/^\/static\/(admin|h5)\//);
   assert.equal((await fetch(base+script)).status,200,script);
  }finally{if(server){if(mode==='dev')await server.close();else{server.httpServer.closeAllConnections?.();await new Promise(r=>server.httpServer.close(r));}}}
 });
}
