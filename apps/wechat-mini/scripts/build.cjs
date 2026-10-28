require('./check.cjs');
const fs = require('node:fs'); const path = require('node:path');
const root = path.resolve(__dirname, '..'); const out = path.join(root, 'dist');
const mode = process.env.KUNLUN_MINI_MODE || 'demo';
if (!['demo','api'].includes(mode)) throw new Error('KUNLUN_MINI_MODE must be demo or api');
const appid = process.env.KUNLUN_MINI_APPID || 'touristappid';
const apiBase = mode === 'api' ? process.env.KUNLUN_MINI_API_BASE : '';
if (mode === 'api') {
  if (!apiBase || !/^https:\/\//.test(apiBase)) throw new Error('API test builds require an explicit HTTPS test backend');
  if (!/^wx[a-f0-9]{16}$/i.test(appid)) throw new Error('API test builds require your actual mini program AppID');
  const url = new URL(apiBase);
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) throw new Error('API base must be a plain HTTPS origin');
}
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true }); fs.cpSync(path.join(root, 'src'), path.join(out, 'miniprogram'), { recursive: true });
fs.writeFileSync(path.join(out, 'miniprogram/config.js'), 'module.exports = ' + JSON.stringify({ mode, apiBase: apiBase ? new URL(apiBase).origin : '', paymentMode: 'mock' }) + ';\n');
if (mode === 'api') {
  fs.rmSync(path.join(out, 'miniprogram/lib/demo.js'));
  const apiPath = path.join(out, 'miniprogram/lib/api.js');
  const source = fs.readFileSync(apiPath, 'utf8')
    .replace("if (config.mode === 'demo') value = require('./demo').login(type);\n  else value =", 'value =')
    .replace("  if (config.mode === 'demo') return require('./demo').call(action, p, session());\n", '');
  if (source.includes("require('./demo')")) throw new Error('Demo removal failed');
  fs.writeFileSync(apiPath, source);
}
const project = JSON.parse(fs.readFileSync(path.join(root, 'project.config.json'), 'utf8'));
Object.assign(project, { appid, miniprogramRoot: 'miniprogram/' });
fs.writeFileSync(path.join(out, 'project.config.json'), JSON.stringify(project, null, 2) + '\n');
console.log('Built test mini program: ' + out + ' (' + mode + ')');
