const test = require('node:test'); const assert = require('node:assert/strict'); const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const { spawnSync } = require('node:child_process');
test('API build removes fixtures and refuses missing HTTPS origin or AppID', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kunlun-mini-build-'));
  try {
    const root = path.resolve(__dirname, '..');
    for (const name of ['src','scripts','project.config.json']) fs.cpSync(path.join(root, name), path.join(tmp, name), { recursive: true });
    const build = env => spawnSync(process.execPath, ['scripts/build.cjs'], { cwd: tmp, env: Object.assign({}, process.env, { KUNLUN_MINI_MODE: 'api', KUNLUN_MINI_APPID: '', KUNLUN_MINI_API_BASE: '' }, env), encoding: 'utf8' });
    assert.notEqual(build({}).status, 0);
    assert.notEqual(build({ KUNLUN_MINI_API_BASE: 'https://test.example.invalid' }).status, 0);
    // Syntactically valid fixture AppID, used only in this temporary local build.
    const ok = build({ KUNLUN_MINI_APPID: 'wx0000000000000000', KUNLUN_MINI_API_BASE: 'https://test.example.invalid' });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(fs.existsSync(path.join(tmp, 'dist/miniprogram/lib/demo.js')), false);
    assert.equal(fs.readFileSync(path.join(tmp, 'dist/miniprogram/lib/api.js'), 'utf8').includes("require('./demo')"), false);
    // The server handshake enables retail only after validating the destination.
    const config = fs.readFileSync(path.join(tmp, 'dist/miniprogram/config.js'), 'utf8');
    assert.match(config, /"retail":false/);
    assert.match(config, /"paymentMode":"disabled"/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
