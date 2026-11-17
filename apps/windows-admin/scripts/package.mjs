/**
 * Builds the Windows installer (x64, Windows 10 and later) into release/.
 *   KUNLUN_DESKTOP_ORIGIN=https://kunlun-test.idalee.cn  build a copy for another https server (installs side by side)
 *   --unpacked                                          unpacked folder only, no installer
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import builder from 'electron-builder';
import { DEFAULT_ORIGIN, parseOrigin } from '../src/rules.js';

const { build, Platform, Arch } = builder;
const projectDir = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const origin = parseOrigin(process.env.KUNLUN_DESKTOP_ORIGIN || DEFAULT_ORIGIN);
const production = origin === DEFAULT_ORIGIN;
const productName = production ? pkg.productName : `${pkg.productName}（测试）`;
const appId = production ? 'cn.idalee.kunlun.admin' : 'cn.idalee.kunlun.admin.test';
const fileStem = production ? 'kunlun-admin' : 'kunlun-admin-test';

console.log(`Packaging ${productName} for ${origin}`);

await build({
  projectDir,
  targets: Platform.WINDOWS.createTarget(process.argv.includes('--unpacked') ? 'dir' : 'nsis', Arch.x64),
  publish: 'never',
  config: {
    appId,
    productName,
    executableName: fileStem,
    copyright: `© ${new Date().getFullYear()} 绿麒麟水站`,
    directories: { output: 'release', buildResources: 'build' },
    files: ['package.json', 'src/**/*', '!src/**/*.test.js'],
    // Chromium ships ~55 UI languages; dialogs here only need Chinese (English as fallback).
    electronLanguages: ['zh-CN', 'en-US'],
    // The shell reads these from its packaged package.json; an installed copy cannot be pointed elsewhere.
    extraMetadata: { productName, kunlunOrigin: origin, kunlunAppId: appId },
    win: { icon: 'build/icon.png' },
    nsis: {
      // Per-user one-click install: no administrator rights needed on the shop computer.
      oneClick: true,
      perMachine: false,
      artifactName: `${fileStem}-setup-\${version}.\${ext}`,
      shortcutName: productName,
      uninstallDisplayName: productName,
      createDesktopShortcut: 'always',
      createStartMenuShortcut: true,
      deleteAppDataOnUninstall: false,
      installerLanguages: ['zh_CN'],
      language: '2052',
    },
  },
});
