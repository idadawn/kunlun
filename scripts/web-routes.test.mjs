import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import net from 'node:net';
import {WEB_ROUTES,resolveRoute,pathFor} from '../packages/shared/src/routes.ts';
import {filterPlans} from '../packages/shared/src/plans.ts';
import {pageCount,pageWindow} from '../packages/shared/src/paging.ts';
import {dateFilterFrom} from '../packages/shared/src/format.ts';
import {KunlunApi} from '../packages/shared/src/api.ts';
import {newNotices} from '../apps/admin-pc/src/alert-events.ts';
const root=fileURLToPath(new URL('..',import.meta.url));
const APPS={'admin-pc':['admin'],'mobile-h5':['member','staff']};
const allPaths=area=>[`/${area}`,...WEB_ROUTES[area].pages.map(p=>`/${area}/${p}`),...Object.keys(WEB_ROUTES[area].aliases||{}).map(p=>`/${area}/${p}`)];

test('admin alerts ignore history and detect new reviews even when another is resolved', () => {
 const before = {orderTotal: 12, pendingReviewIds: ['old']};
 const after = {orderTotal: 14, pendingReviewIds: ['new']};
 assert.deepEqual(newNotices(null, before), []);
 assert.deepEqual(newNotices(before, after).map(n => [n.page, n.text]), [['orders', '收到 2 张新水单'], ['refunds', '新增 1 笔待审核申请']]);
 assert.deepEqual(newNotices(after, after), []);
 assert.deepEqual(newNotices(after, {orderTotal: 14, pendingReviewIds: []}), []);
});

test('clean URLs resolve pages and aliases; .html and hash links are not routes',()=>{
 assert.deepEqual(resolveRoute('/admin/plans'),{area:'admin',page:'plans',path:'/admin/plans'});
 assert.equal(resolveRoute('/admin/settings').path,'/admin/plans');
 assert.equal(resolveRoute('/admin/deposit-settings').path,'/admin/products');
 assert.equal(resolveRoute('/member/home/').path,'/member');
 assert.deepEqual(resolveRoute('/member/records'),{area:'member',page:'records',path:'/member/records'});
 // Retired pages keep old links working: coupons and member self-ordering are gone.
 assert.equal(resolveRoute('/admin/coupons').path,'/admin/plans');
 assert.equal(resolveRoute('/member/order').path,'/member');
 assert.equal(resolveRoute('/member/addresses').path,'/member/profile');
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

test('the Android and iOS staff apps open exactly the declared staff pages from their bundles',()=>{
 const staffPages=['/staff',...WEB_ROUTES.staff.pages.map(p=>`/staff/${p}`)].sort();
 const java=readFileSync(join(root,'apps/android-staff/app/src/main/java/cn/idalee/kunlun/staff/StaffUrls.java'),'utf8');
 const android=[...java.match(/PAGES = new HashSet<>\(Arrays\.asList\(([^)]*)\)/)[1].matchAll(/"([^"]+)"/g)].map(m=>m[1]).sort();
 assert.deepEqual(android,staffPages);
 const swift=readFileSync(join(root,'apps/ios-staff/Core/StaffRoutes.swift'),'utf8');
 const ios=[...swift.match(/static let pages: Set<String> = \[([^\]]*)\]/)[1].matchAll(/"([^"]+)"/g)].map(m=>m[1]).sort();
 assert.deepEqual(ios,staffPages);
});

test('the Android member app opens exactly the declared member pages and their aliases from its bundle',()=>{
 const java=readFileSync(join(root,'apps/android-member/app/src/main/java/cn/idalee/kunlun/member/MemberUrls.java'),'utf8');
 const android=[...java.match(/PAGES = new HashSet<>\(Arrays\.asList\(([^)]*)\)/)[1].matchAll(/"([^"]+)"/g)].map(m=>m[1]).sort();
 assert.deepEqual(android,allPaths('member').sort());
});

test('the Windows admin app keeps every declared admin page in its window and nothing from the other areas',async()=>{
 const {DEFAULT_ORIGIN:origin,isAppUrl}=await import('../apps/windows-admin/src/rules.js');
 for(const path of allPaths('admin'))assert.ok(isAppUrl(origin,origin+path),path);
 for(const path of [...allPaths('staff'),...allPaths('member'),'/admin.html','/api/auth/me'])assert.equal(isAppUrl(origin,origin+path),false,path);
});

test('package classification and search never expose disabled packages',()=>{
 const plans=[{id:'a',name:'袋装自提100',waterType:'BAG_7_5L',fulfillMode:'PICKUP',price:100,buyQty:50,status:'ACTIVE'},{id:'b',name:'袋装自提499',waterType:'BAG_7_5L',fulfillMode:'PICKUP',price:499,buyQty:300,status:'ACTIVE'},{id:'c',name:'桶装配送100',waterType:'BUCKET_18_9L',fulfillMode:'DELIVERY',price:100,buyQty:13,status:'ACTIVE'},{id:'d',name:'停用袋装100',waterType:'BAG_7_5L',fulfillMode:'PICKUP',price:100,buyQty:50,status:'DISABLED'}];
 assert.equal(filterPlans(plans).length,3);
 assert.deepEqual(filterPlans(plans,'BAG_7_5L:PICKUP','499').map(p=>p.id),['b']);
 assert.deepEqual(filterPlans(plans,'BUCKET_18_9L:DELIVERY').map(p=>p.id),['c']);
 assert.equal(filterPlans(plans,'ALL','停用').length,0);
});

test('pager shows first, last and neighbouring pages; date filters start at station midnight',()=>{
 assert.equal(pageCount(0,20),1);assert.equal(pageCount(40,20),2);assert.equal(pageCount(41,20),3);
 assert.deepEqual(pageWindow(1,1),[1]);
 assert.deepEqual(pageWindow(1,10),[1,2,null,10]);
 assert.deepEqual(pageWindow(4,10),[1,2,3,4,5,null,10]);
 assert.deepEqual(pageWindow(5,10),[1,null,4,5,6,null,10]);
 assert.deepEqual(pageWindow(10,10),[1,null,9,10]);
 const morning=new Date('2026-10-27T01:30:00Z'),justAfterMidnight=new Date('2026-10-26T16:30:00Z');
 assert.equal(dateFilterFrom('ALL',morning),undefined);
 assert.equal(dateFilterFrom('TODAY',morning),'2026-10-26T16:00:00.000Z');
 assert.equal(dateFilterFrom('TODAY',justAfterMidnight),'2026-10-26T16:00:00.000Z');
 assert.equal(dateFilterFrom('WEEK',morning),'2026-10-20T16:00:00.000Z');
 assert.equal(dateFilterFrom('MONTH',morning),'2026-09-30T16:00:00.000Z');
});

test('paged client calls always send page and drop empty filters; legacy list calls stay unpaged',async()=>{
 const urls=[],real=globalThis.fetch;
 globalThis.fetch=async url=>{urls.push(url);return new Response('{}',{status:200});};
 try{
  const api=new KunlunApi();
  await api.membersPage({q:' 陈 ',status:undefined,water:'BUCKET',pageSize:50});
  await api.ordersPage({mode:'PICKUP',from:'2026-10-26T16:00:00.000Z',q:'',page:3});
  await api.rechargeLedger();
  await api.rechargeRefundLedger({payMethod:'BANK',q:' '});
  await api.depositLedger({flowType:'REFUND',containerType:'BAG',pageSize:20});
  await api.containerLedger({containerType:'BAG'});
  await api.refundRequests({status:'PENDING',kind:undefined,q:' 陈 '});
  await api.listMembers('  ');
  await api.listOrders({memberId:'m1'});
 }finally{globalThis.fetch=real;}
 assert.deepEqual(urls,[
  '/api/members?q=%E9%99%88&water=BUCKET&pageSize=50&page=1',
  '/api/orders?mode=PICKUP&from=2026-10-26T16%3A00%3A00.000Z&page=3',
  '/api/ledgers/recharges?page=1',
  '/api/ledgers/recharge-refunds?payMethod=BANK&page=1',
  '/api/ledgers/deposits?flowType=REFUND&containerType=BAG&pageSize=20&page=1',
  '/api/ledgers/containers?containerType=BAG&page=1',
  '/api/refund-requests?status=PENDING&q=%E9%99%88&page=1',
  '/api/members',
  '/api/orders?memberId=m1',
 ]);
});

test('browser and native transport failures get a readable message without masking HTTP errors or cancellation',async()=>{
 const real=globalThis.fetch,api=new KunlunApi({baseUrl:'https://kunlun-test.idalee.cn'});
 try{
  for(const failure of [new TypeError('Failed to fetch'),new Error('Unable to resolve host "kunlun-test.idalee.cn"')]){
   globalThis.fetch=async url=>{assert.equal(url,'https://kunlun-test.idalee.cn/api/auth/member/login');throw failure;};
   await assert.rejects(api.memberLogin('test','test'),{name:'ApiError',status:0,message:'网络连接失败，请检查网络后重试'});
  }
  const aborted=new DOMException('Cancelled','AbortError');
  globalThis.fetch=async()=>{throw aborted;};
  await assert.rejects(api.memberLogin('test','test'),error=>error===aborted);
  globalThis.fetch=async()=>new Response(JSON.stringify({error:'用户名或密码错误，或账号已停用'}),{status:401});
  await assert.rejects(api.memberLogin('test','test'),{name:'ApiError',status:401,message:'用户名或密码错误，或账号已停用'});
 }finally{globalThis.fetch=real;}
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
