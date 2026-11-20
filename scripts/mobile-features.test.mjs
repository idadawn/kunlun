import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

// The shared sources import each other without extensions, as the bundler expects; let Node find the .ts files too.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && !/\.\w+$/.test(specifier) && context.parentURL?.endsWith('.ts')) return next(`${specifier}.ts`, context);
    return next(specifier, context);
  },
});
const { MOBILE_FEATURES, MOBILE_TAB_LIMIT, mobileLayout, mobilePermissions } = await import('../packages/shared/src/mobile.ts');
const { KUNLUN_PERMISSIONS: P } = await import('../packages/shared/src/permissions.ts');

test('the console catalog grants exactly what the server grants for every mobile feature', () => {
  const source = readFileSync(new URL('../services/Kunlun.WaterStation/Auth/MobileFeatures.cs', import.meta.url), 'utf8');
  const catalog = source.slice(source.indexOf('Catalog ='), source.indexOf('];', source.indexOf('Catalog =')));
  const server = [...catalog.matchAll(/\("(\w+)", \[([^\]]*)\]\)/g)].map(([, key, names]) => ({
    key,
    permissions: names.split(',').map(name => {
      const code = P[name.trim()];
      assert.ok(code, `unknown permission ${name.trim()} for ${key}`);
      return code;
    }),
  }));
  assert.deepEqual(server.map(f => f.key), MOBILE_FEATURES.map(f => f.key));
  for (const f of server) assert.deepEqual([...f.permissions].sort(), [...MOBILE_FEATURES.find(x => x.key === f.key).permissions].sort(), f.key);
});

test('workbench layout: the first pages become tabs, cards are not shortcuts, unknown and repeated keys are ignored', () => {
  const layout = mobileLayout(['recharge', 'order', 'orders', 'overview', 'members', 'inventory', 'teleport', 'order']);
  assert.equal(MOBILE_TAB_LIMIT, 3);
  assert.deepEqual(layout.features.map(f => f.key), ['recharge', 'order', 'orders', 'overview', 'members', 'inventory']);
  assert.deepEqual(layout.tabs.map(f => f.key), ['order', 'orders', 'members']);
  assert.deepEqual(layout.shortcuts.map(f => f.key), ['recharge', 'inventory']);
  assert.ok(layout.has('overview'));
  assert.ok(!layout.has('pickup'));
  assert.deepEqual(mobileLayout(null).features, []);
  // Moving a page later in the order hands its tab to the next page.
  assert.deepEqual(mobileLayout(['members', 'inventory', 'orders', 'order']).tabs.map(f => f.key), ['members', 'inventory', 'orders']);
});

test('a role holds the union of its features’ permissions in the canonical order', () => {
  assert.deepEqual(mobilePermissions(['pickup']), [P.OrderFulfill, P.PickupVerify]);
  assert.deepEqual(mobilePermissions(['newMember', 'members']), [P.MemberRead, P.MemberWrite]);
  assert.deepEqual(mobilePermissions(['teleport']), []);
  // The original clerk permissions are exactly the clerk's default workbench.
  assert.deepEqual(
    mobilePermissions(['order', 'orders', 'members', 'recharge', 'depositCollect', 'depositRefund', 'pickup', 'movement', 'newMember']),
    [P.MemberRead, P.MemberWrite, P.RechargeCreate, P.DepositCollect, P.DepositRefundApply, P.OrderCreate, P.OrderAccept, P.OrderFulfill, P.PickupVerify, P.ContainerRegister],
  );
});

test('remembered H5 sessions survive closing a tab and stay scoped to the login area and API', async t => {
  const { loginStorage, tokenExpired } = await import('../packages/ui/src/login-storage.ts');
  const createStore = () => {
    const values = new Map();
    return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  };
  globalThis.window = { location: new URL('https://test.invalid/staff'), sessionStorage: createStore(), localStorage: createStore(), navigator: {} };
  t.after(() => { delete globalThis.window; });
  const staff = loginStorage('staff', '');
  const member = loginStorage('member', '');
  const login = { accessToken: 'token', account: 'test', password: 'test-password' };
  window.sessionStorage.setItem('kunlun_staff_session', JSON.stringify({ accessToken: 'old', subjectType: 'STAFF' }));
  assert.equal((await staff.read()).accessToken, 'old');
  await staff.save(login, true);
  assert.equal(window.sessionStorage.getItem('kunlun_staff_session'), null);
  assert.deepEqual(JSON.parse(window.localStorage.getItem('kunlun_staff_session')), { accessToken: login.accessToken, account: login.account });
  window.sessionStorage = createStore();
  assert.equal((await staff.read()).accessToken, login.accessToken);
  assert.equal(await member.read(), null);
  assert.equal(await loginStorage('staff', 'https://another.invalid').read(), null);
  await member.save({ ...login, accessToken: 'member' }, true);
  await staff.clear();
  assert.equal(await staff.read(), null);
  assert.equal((await member.read()).accessToken, 'member');
  await member.save(login, false);
  window.sessionStorage = createStore();
  assert.equal(await member.read(), null);

  const token = exp => 'header.' + Buffer.from(JSON.stringify({ exp })).toString('base64url') + '.signature';
  assert.equal(tokenExpired(token(1)), true);
  assert.equal(tokenExpired(token(Date.now() / 1000 + 3600)), false);
  assert.equal(tokenExpired('invalid'), false);
});
