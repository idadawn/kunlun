import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import assert from 'node:assert/strict';
const forbidden=/data-proto-bar|gq-dock|客户演示中心|返回演示目录|返回三端原型|phone-notch|class="status-bar"|手动备份任务已启动|已模拟摄像头/;
for (const app of ['admin-pc','mini-app']) {
  for (const page of ['index.html','admin.html','staff.html','member.html']) {
    const path=`apps/${app}/dist/${page}`, html=readFileSync(path,'utf8');
    assert.ok(!forbidden.test(html),`${path} contains a prototype surface`);
    if(html.includes('id="adminApp"')) {
      for(const section of ['products','plans','coupons','deposit-settings','staff-accounts']) {
        assert.ok(html.includes(`data-page="${section}"`) && html.includes(`id="page-${section}"`),`${path} is missing a functional section`);
      }
      assert.ok(!html.includes('id="page-settings"'),`${path} still contains the mixed settings page`);
    }
    for (const [,script] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Script(script,{filename:path});
  }
  for (const file of ['brand.js','live-api.js','membership.js','price-poster.js','admin-ui.js']) {
    const path=`apps/${app}/dist/assets/${file}`, code=readFileSync(path,'utf8');
    assert.ok(!forbidden.test(code),`${path} contains a prototype handler`);
    new Script(code,{filename:path});
  }
}
console.log('Production page artifacts: no demo navigation, device mockups or simulated success handlers; all inline scripts parse.');
