import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
// Production bundles are React builds: one entry document per app, hashed absolute assets, no prototype surfaces.
const forbidden=/data-proto-bar|gq-dock|客户演示中心|返回演示目录|返回三端原型|phone-notch|class="status-bar"|手动备份任务已启动|已模拟摄像头/;
const files=dir=>readdirSync(dir,{recursive:true,withFileTypes:true}).filter(e=>e.isFile()).map(e=>join(e.parentPath,e.name));
for (const [app,assets] of [['admin-pc','static/admin'],['mini-app','static/h5']]) {
  const dist=`apps/${app}/dist`, all=files(dist);
  assert.deepEqual(all.filter(f=>f.endsWith('.html')),[join(dist,'index.html')],`${dist} must contain only the React entry document`);
  const html=readFileSync(join(dist,'index.html'),'utf8');
  assert.ok(html.includes('<div id="root"></div>'),`${dist}/index.html is not a React entry`);
  for (const [,src] of html.matchAll(/(?:src|href)="([^"]+)"/g)) assert.ok(src.startsWith(`/${assets}/`),`${dist}/index.html references ${src} outside /${assets}/`);
  assert.ok(!/<script>(?!<\/script>)/.test(html),`${dist}/index.html contains inline script`);
  for (const file of all.filter(f=>/\.(js|css)$/.test(f))) {
    assert.ok(file.startsWith(join(dist,assets)),`${file} is outside ${assets}`);
    assert.ok(!forbidden.test(readFileSync(file,'utf8')),`${file} contains a prototype surface`);
  }
}
console.log('Production builds: React entry documents only, hashed assets under /static, no demo surfaces.');
