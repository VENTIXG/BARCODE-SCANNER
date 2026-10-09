/**
 * Builds the Windows installer (release/Warehouse-IMS-Setup-<version>.exe).
 *
 * On Windows this is a plain electron-builder run. On Linux/macOS electron-builder
 * would need Wine to extract the NSIS uninstaller; instead we enable its built-in
 * pure-JavaScript extractor (the one it already uses on macOS Catalina and later).
 *
 * Optional: ELECTRON_DIST=<folder with electron-vX-win32-x64.zip> to use a
 * pre-downloaded Electron instead of downloading it.
 *
 * Output: release/Warehouse-IMS-Setup.exe and release/latest.yml (version and SHA-512 of the
 * installer, read by the auto-updater of installed copies).
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
  // Writes latest.yml (read by the auto-updater) but uploads nothing: the release workflow publishes.
  publish: 'never',
  // Only overrides: electron-builder reads the "build" field of package.json itself (passing it
  // again merges its arrays, such as "publish", into a broken shape).
  config: {
    ...(process.env.ELECTRON_DIST ? { electronDist: process.env.ELECTRON_DIST } : {}),
    // IMS_BUILD_OUTPUT=<folder>: a second build next to the first (the update test builds an older copy).
    ...(process.env.IMS_BUILD_OUTPUT ? { directories: { ...pkg.build.directories, output: process.env.IMS_BUILD_OUTPUT } } : {}),
  },
})
  .then((files) => {
    console.log('\nBuilt:');
    for (const f of files) console.log(`  ${path.relative(process.cwd(), f)}`);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
