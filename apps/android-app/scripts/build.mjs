import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(app, '../..');
const api = new URL(process.env.KUNLUN_ANDROID_API_URL || 'https://kunlun-test.idalee.cn');
if (api.protocol !== 'https:' || api.username || api.password || api.search || api.hash || api.pathname !== '/') {
  throw new Error('KUNLUN_ANDROID_API_URL must be an HTTPS origin without credentials, a path, query, or fragment.');
}
const env = { ...process.env, VITE_API_BASE_URL: api.origin, VITE_NATIVE_APP: 'true' };
const bundledJdk = '/Applications/Android Studio.app/Contents/jbr/Contents/Home';
if (!env.JAVA_HOME && existsSync(bundledJdk)) env.JAVA_HOME = bundledJdk;
const sdk = env.ANDROID_HOME || env.ANDROID_SDK_ROOT || (process.platform === 'darwin' ? join(homedir(), 'Library/Android/sdk') : undefined);
if (sdk) env.ANDROID_HOME = sdk;

function run(command, args, cwd = repo) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run('pnpm', ['--filter', '@kunlun/mini-app', 'exec', 'tsc', '--noEmit']);
run('pnpm', ['--filter', '@kunlun/mini-app', 'exec', 'vite', 'build', '--outDir', '../android-app/www', '--emptyOutDir']);
run('pnpm', ['exec', 'cap', 'sync', 'android'], app);
const metadata = {
  appId: 'cn.idalee.lvqilin', apiOrigin: api.origin,
  sourceCommit: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim(),
  sourceDirty: Boolean(spawnSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).stdout.trim()),
  builtAt: new Date().toISOString(),
};
mkdirSync(join(app, 'artifacts'), { recursive: true });
writeFileSync(join(app, 'artifacts/build-info.json'), JSON.stringify(metadata, null, 2) + '\n');
if (!process.argv.includes('--sync-only')) {
  run(process.platform === 'win32' ? 'gradlew.bat' : './gradlew', [':app:assembleDebug', ':app:lintDebug', '--console=plain'], join(app, 'android'));
  console.log('APK: ' + join(app, 'android/app/build/outputs/apk/debug/app-debug.apk'));
}
