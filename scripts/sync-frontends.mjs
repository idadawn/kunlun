import { copyFileSync, cpSync, mkdirSync } from 'node:fs';
for (const app of ['admin-pc', 'mini-app']) {
  const root = `apps/${app}`;
  mkdirSync(`${root}/public`, { recursive: true });
  cpSync('assets', `${root}/public/assets`, { recursive: true });
  for (const file of ['admin.html', 'staff.html', 'member.html']) copyFileSync(file, `${root}/public/${file}`);
  copyFileSync(app === 'admin-pc' ? 'admin.html' : 'member.html', `${root}/index.html`);
}
