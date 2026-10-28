const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
function files(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]); }
const app = JSON.parse(fs.readFileSync(path.join(root, 'src/app.json'), 'utf8'));
for (const page of app.pages) for (const ext of ['js', 'json', 'wxml', 'wxss']) {
  if (!fs.existsSync(path.join(root, 'src', page + '.' + ext))) throw new Error('Missing page file: ' + page + '.' + ext);
}
for (const file of files(path.join(root, 'src'))) {
  if (file.endsWith('.js')) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.status) throw new Error(result.stderr);
    const content = fs.readFileSync(file, 'utf8');
    for (const match of content.matchAll(/require\(['"](\.[^'"]+)['"]\)/g)) {
      if (!fs.existsSync(path.resolve(path.dirname(file), match[1] + '.js'))) throw new Error('Missing require ' + match[1]);
    }
  }
  if (file.endsWith('.json')) JSON.parse(fs.readFileSync(file, 'utf8'));
  if (file.endsWith('.wxml')) {
    const markup = fs.readFileSync(file, 'utf8');
    if (/<(div|span|br|small|svg)\b/.test(markup)) throw new Error('Web-only markup: ' + file);
    // HTML formatters can split quoted strings in WXML bindings. Parse each
    // expression without evaluating it; native DevTools compilation is still required.
    for (const match of markup.matchAll(/\{\{([\s\S]*?)\}\}/g)) new vm.Script('(' + match[1] + ')', { filename: file });
  }
}
console.log('Mini program source validation passed (' + app.pages.length + ' pages)');
