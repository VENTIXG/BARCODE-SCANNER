/**
 * Builds the Windows installer (release/Warehouse-IMS-Setup-<version>.exe).
 *
 * On Windows this is a plain electron-builder run. On Linux/macOS electron-builder
 * would need Wine to extract the NSIS uninstaller; instead we enable its built-in
 * pure-JavaScript extractor (the one it already uses on macOS Catalina and later).
 *
 * Optional: ELECTRON_DIST=<folder with electron-vX-win32-x64.zip> to use a
 * pre-downloaded Electron instead of downloading it.
 */
const path = require('node:path');

if (process.platform !== 'win32') {
  const macosVersion = require('app-builder-lib/out/util/macosVersion');
  macosVersion.isMacOsCatalina = () => true;
}

const { build, Platform, Arch } = require('electron-builder');
const pkg = require(path.join(__dirname, '..', 'package.json'));

build({
  projectDir: path.join(__dirname, '..'),
  targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64),
  config: { ...pkg.build, ...(process.env.ELECTRON_DIST ? { electronDist: process.env.ELECTRON_DIST } : {}) },
})
  .then((files) => {
    console.log('\nBuilt:');
    for (const f of files) console.log(`  ${path.relative(process.cwd(), f)}`);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
