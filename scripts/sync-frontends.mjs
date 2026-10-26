import { copyFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const routes=JSON.parse(readFileSync('config/web-routes.json','utf8'));
writeFileSync('assets/route-config.js','// Generated from config/web-routes.json by sync-frontends.mjs\nwindow.KunlunRouteConfig='+JSON.stringify(routes)+';\n');
for (const app of ['admin-pc', 'mini-app']) {
  const root = `apps/${app}`;
  mkdirSync(`${root}/public`, { recursive: true });
  cpSync('assets', `${root}/public/assets`, { recursive: true });
  for (const [area,route] of Object.entries(routes)) {
    const file=area+'.html';
    copyFileSync(file, `${root}/public/${file}`);
    for(const page of ['',...route.pages,...Object.keys(route.aliases||{})]){
      const folder=`${root}/public/${area}${page?'/'+page:''}`;
      mkdirSync(folder,{recursive:true});copyFileSync(file,`${folder}/index.html`);
    }
  }
  copyFileSync(app === 'admin-pc' ? 'admin.html' : 'member.html', `${root}/index.html`);
}
