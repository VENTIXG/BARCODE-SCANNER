/**
 * Warehouse IMS: Windows desktop app.
 *
 * Two ways to work, chosen on the start screen (and changeable from the "Σύνδεση" menu):
 *  - remote: open the company server (e.g. https://apothiki.example.gr). Many PCs, one database.
 *  - local:  start the built-in server on 127.0.0.1 with this PC's own database in
 *            %APPDATA%\Warehouse IMS\data (kept when the app is updated or removed).
 *
 * The app updates itself from GitHub Releases (electron-updater): it downloads a new version in
 * the background and installs it when the app closes, or at once if the user agrees.
 */
const { app, BrowserWindow, Menu, dialog, ipcMain, net, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const PREFERRED_PORT = 47231;
const UPDATE_EVERY_MS = 4 * 3600 * 1000;

const userData = app.getPath('userData');
const dataDir = path.join(userData, 'data');
const configFile = path.join(userData, 'config.json');
process.env.DATA_DIR = dataDir;
process.env.NODE_ENV = 'production';

// Simple log file for support: %APPDATA%\Warehouse IMS\logs\main.log
const logDir = path.join(userData, 'logs');
fs.mkdirSync(logDir, { recursive: true });
const logFile = path.join(logDir, 'main.log');
for (const level of ['log', 'error', 'warn']) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    original(...args);
    try {
      fs.appendFileSync(logFile, `${new Date().toISOString()} [${level}] ${args.map((a) => (a instanceof Error ? a.stack : String(a))).join(' ')}\n`);
    } catch {
      /* logging must never crash the app */
    }
  };
}

let mainWindow = null;
let setupWindow = null;
let server = null;
let config = null;
let shuttingDown = false;
let shutdownDone = false;

const importServer = (file) => import(pathToFileURL(path.join(__dirname, 'server', 'dist', file)).href);

// ---- Settings (mode and server address) -----------------------------------------------------

function readConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    if (c.mode === 'local') return { mode: 'local' };
    if (c.mode === 'remote' && typeof c.serverUrl === 'string' && /^https?:\/\//.test(c.serverUrl)) return { mode: 'remote', serverUrl: c.serverUrl };
  } catch {
    /* no settings yet */
  }
  return null;
}

function writeConfig(c) {
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify(c, null, 2));
}

/** "apothiki.example.gr" -> "https://apothiki.example.gr" (no path, no trailing slash). */
function normalizeServerUrl(input) {
  let s = String(input ?? '').trim();
  if (!s) throw new Error('Γράψτε τη διεύθυνση του server.');
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  const u = new URL(s);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Η διεύθυνση πρέπει να ξεκινά με https://');
  return `${u.protocol}//${u.host}`;
}

/** Ask the server for /api/health: proves it is a Warehouse IMS server and reachable. */
async function probeServer(url) {
  try {
    const res = await net.fetch(`${url}/api/health`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return { ok: false, error: `Ο server απάντησε με σφάλμα ${res.status}.` };
    const body = await res.json().catch(() => null);
    if (!body || body.ok !== true || typeof body.version !== 'string') return { ok: false, error: 'Η διεύθυνση δεν είναι server Warehouse IMS.' };
    return { ok: true, version: body.version };
  } catch (e) {
    const msg = String(e?.message ?? e);
    if (/CERT|certificate|SSL/i.test(msg)) return { ok: false, error: 'Το πιστοποιητικό HTTPS του server δεν είναι έγκυρο.' };
    if (/NAME_NOT_RESOLVED/i.test(msg)) return { ok: false, error: 'Η διεύθυνση δεν βρέθηκε (DNS). Ελέγξτε ότι γράφτηκε σωστά.' };
    if (/timeout|TIMED_OUT|abort/i.test(msg)) return { ok: false, error: 'Ο server δεν απαντά (χρονικό όριο).' };
    return { ok: false, error: `Δεν έγινε σύνδεση: ${msg}` };
  }
}

// ---- Windows ---------------------------------------------------------------------------------

function buildMenu() {
  const local = config?.mode === 'local';
  const template = [
    {
      label: 'Αρχείο',
      submenu: [
        ...(local
          ? [
              { label: 'Άνοιγμα φακέλου δεδομένων', click: () => shell.openPath(dataDir) },
              { type: 'separator' },
            ]
          : []),
        { label: 'Άνοιγμα αρχείου καταγραφής', click: () => shell.openPath(logFile) },
        { type: 'separator' },
        { label: 'Έξοδος', role: 'quit' },
      ],
    },
    {
      label: 'Επεξεργασία',
      submenu: [
        { label: 'Αναίρεση', role: 'undo' },
        { label: 'Επανάληψη', role: 'redo' },
        { type: 'separator' },
        { label: 'Αποκοπή', role: 'cut' },
        { label: 'Αντιγραφή', role: 'copy' },
        { label: 'Επικόλληση', role: 'paste' },
        { label: 'Επιλογή όλων', role: 'selectAll' },
      ],
    },
    {
      label: 'Προβολή',
      submenu: [
        { label: 'Ανανέωση', role: 'reload' },
        { type: 'separator' },
        { label: 'Κανονικό μέγεθος', role: 'resetZoom' },
        { label: 'Μεγέθυνση', role: 'zoomIn' },
        { label: 'Σμίκρυνση', role: 'zoomOut' },
        { type: 'separator' },
        { label: 'Πλήρης οθόνη', role: 'togglefullscreen' },
        { label: 'Εργαλεία προγραμματιστή', role: 'toggleDevTools' },
      ],
    },
    {
      label: 'Σύνδεση',
      submenu: [
        {
          label: config?.mode === 'remote' ? `Server: ${config.serverUrl}` : 'Μόνο αυτός ο υπολογιστής',
          enabled: false,
        },
        { label: 'Αλλαγή server ή τοπικής χρήσης…', click: () => openSetup() },
      ],
    },
    {
      label: 'Βοήθεια',
      submenu: [
        { label: 'Έλεγχος για ενημερώσεις', click: () => void checkForUpdates(true) },
        { type: 'separator' },
        {
          label: 'Σχετικά με το Warehouse IMS',
          click: () =>
            dialog.showMessageBox(mainWindow ?? undefined, {
              title: 'Warehouse IMS',
              message: `Warehouse IMS ${app.getVersion()}`,
              detail:
                config?.mode === 'remote'
                  ? `Σύνδεση στον server:\n${config.serverUrl}`
                  : `Φάκελος δεδομένων:\n${dataDir}`,
            }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

const sameOrigin = (a, b) => {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
};

function createMainWindow(url) {
  const remote = config.mode === 'remote';
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'Warehouse IMS',
    icon: path.join(__dirname, 'icon.png'),
    backgroundColor: '#f5f6f8',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
      additionalArguments: [`--ims-mode=${config.mode}`, `--ims-version=${app.getVersion()}`],
    },
  });
  mainWindow.once('ready-to-show', () => {
    mainWindow.maximize();
    mainWindow.show();
  });
  // Links to other sites open in the normal browser, never inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (!sameOrigin(target, url)) void shell.openExternal(target);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, target) => {
    if (sameOrigin(target, url) || target.startsWith('file:')) return;
    event.preventDefault();
    void shell.openExternal(target);
  });
  if (remote) {
    // No connection: a local page that retries by itself.
    mainWindow.webContents.on('did-fail-load', (_e, code, description, failedUrl, isMainFrame) => {
      if (!isMainFrame || code === -3 || !sameOrigin(failedUrl, url)) return;
      console.warn(`Load failed (${code} ${description}): ${failedUrl}`);
      void mainWindow.loadFile(path.join(__dirname, 'offline.html'), { query: { url, error: description } });
    });
  }
  mainWindow.on('closed', () => (mainWindow = null));
  void mainWindow.loadURL(url);
}

function openSetup() {
  if (setupWindow) {
    setupWindow.focus();
    return;
  }
  setupWindow = new BrowserWindow({
    width: 900,
    height: 680,
    resizable: true,
    title: 'Warehouse IMS: σύνδεση',
    icon: path.join(__dirname, 'icon.png'),
    backgroundColor: '#f5f6f8',
    parent: mainWindow ?? undefined,
    modal: Boolean(mainWindow),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      additionalArguments: ['--ims-mode=setup', `--ims-version=${app.getVersion()}`],
    },
  });
  setupWindow.setMenuBarVisibility(false);
  setupWindow.on('closed', () => {
    setupWindow = null;
    // First start, closed without a choice: nothing to show.
    if (!config && !mainWindow) app.quit();
  });
  void setupWindow.loadFile(path.join(__dirname, 'setup.html'), {
    query: {
      mode: config?.mode ?? '',
      server: config?.serverUrl ?? '',
      localData: fs.existsSync(path.join(dataDir, 'inventory.db')) ? '1' : '',
    },
  });
}

// ---- Bridge (preload.cjs) -----------------------------------------------------------------------

/** IPC only from our own pages: the start screen, the offline page or the app's own origin. */
function trusted(event) {
  const url = event.senderFrame?.url ?? '';
  if (url.startsWith('file:')) return true;
  if (config?.mode === 'remote') return sameOrigin(url, config.serverUrl);
  return Boolean(server) && sameOrigin(url, server.url);
}

function handle(channel, fn) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!trusted(event)) throw new Error('Not allowed');
    return fn(...args);
  });
}

handle('ims:choose-folder', async (current) => {
  if (config?.mode !== 'local') return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Φάκελος backup',
    defaultPath: typeof current === 'string' ? current : undefined,
    properties: ['openDirectory', 'createDirectory'],
  });
  return result.canceled ? null : result.filePaths[0];
});

handle('ims:open-folder', async (folder) => {
  if (config?.mode !== 'local') return;
  if (typeof folder === 'string' && fs.existsSync(folder) && fs.statSync(folder).isDirectory()) await shell.openPath(folder);
});

handle('ims:test-server', async (input) => {
  let url;
  try {
    url = normalizeServerUrl(input);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  return { ...(await probeServer(url)), url };
});

handle('ims:use-server', async (input) => {
  const url = normalizeServerUrl(input);
  const probe = await probeServer(url);
  if (!probe.ok) return probe;
  writeConfig({ mode: 'remote', serverUrl: url });
  setTimeout(() => restartApp(), 50);
  return { ok: true };
});

handle('ims:use-local', async () => {
  writeConfig({ mode: 'local' });
  setTimeout(() => restartApp(), 50);
  return { ok: true };
});

handle('ims:change-server', async () => openSetup());
handle('ims:retry', async () => {
  if (mainWindow && config?.mode === 'remote') await mainWindow.loadURL(config.serverUrl);
});
handle('ims:update-status', async () => updateState);
handle('ims:update-check', async () => checkForUpdates(false));
handle('ims:update-install', async () => installUpdateNow());

// ---- Automatic updates ------------------------------------------------------------------------

let updater = null;
let updateState = { state: 'idle' };

function setUpdateState(patch) {
  updateState = { ...updateState, ...patch };
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('ims:update-state', updateState);
}

function initUpdater() {
  // Development copies and portable test builds have nothing to update from.
  if (!app.isPackaged && !process.env.IMS_UPDATE_URL) {
    setUpdateState({ state: 'disabled', message: 'Αντίγραφο ανάπτυξης: χωρίς αυτόματες ενημερώσεις.' });
    return;
  }
  ({ autoUpdater: updater } = require('electron-updater'));
  updater.logger = {
    info: (m) => console.log('[update]', m),
    warn: (m) => console.warn('[update]', m),
    error: (m) => console.error('[update]', m),
    debug: () => {},
  };
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  // One fixed file name on GitHub ("latest" link): download the whole installer every time.
  updater.disableDifferentialDownload = true;
  if (process.env.IMS_UPDATE_URL) updater.setFeedURL({ provider: 'generic', url: process.env.IMS_UPDATE_URL });
  updater.on('checking-for-update', () => setUpdateState({ state: 'checking', message: undefined }));
  updater.on('update-not-available', () => setUpdateState({ state: 'up-to-date', checkedAt: new Date().toISOString(), message: undefined }));
  updater.on('update-available', (info) => setUpdateState({ state: 'downloading', version: info.version, percent: 0 }));
  updater.on('download-progress', (p) => setUpdateState({ state: 'downloading', percent: p.percent }));
  updater.on('update-downloaded', (info) => {
    setUpdateState({ state: 'downloaded', version: info.version, checkedAt: new Date().toISOString() });
    if (process.env.IMS_UPDATE_AUTO_INSTALL === '1') return void installUpdateNow();
    void dialog
      .showMessageBox(mainWindow ?? undefined, {
        type: 'info',
        title: 'Warehouse IMS',
        message: `Η νέα έκδοση ${info.version} είναι έτοιμη.`,
        detail: 'Θα εγκατασταθεί με επανεκκίνηση της εφαρμογής (μερικά δευτερόλεπτα). Αν επιλέξετε «Αργότερα», θα εγκατασταθεί όταν κλείσετε την εφαρμογή.',
        buttons: ['Επανεκκίνηση τώρα', 'Αργότερα'],
        defaultId: 0,
        cancelId: 1,
      })
      .then((r) => r.response === 0 && installUpdateNow());
  });
  updater.on('error', (e) => setUpdateState({ state: 'error', message: String(e?.message ?? e).split('\n')[0].slice(0, 200), checkedAt: new Date().toISOString() }));
  setTimeout(() => void checkForUpdates(false), 15_000);
  setInterval(() => void checkForUpdates(false), UPDATE_EVERY_MS).unref();
}

async function checkForUpdates(interactive) {
  if (!updater) {
    if (interactive) await dialog.showMessageBox(mainWindow ?? undefined, { message: updateState.message ?? 'Οι αυτόματες ενημερώσεις δεν είναι διαθέσιμες.' });
    return updateState;
  }
  if (updateState.state === 'downloading' || updateState.state === 'downloaded') return updateState;
  try {
    await updater.checkForUpdates();
  } catch (e) {
    setUpdateState({ state: 'error', message: String(e?.message ?? e).split('\n')[0].slice(0, 200), checkedAt: new Date().toISOString() });
  }
  if (interactive && updateState.state === 'up-to-date') {
    await dialog.showMessageBox(mainWindow ?? undefined, { message: `Έχετε την πιο πρόσφατη έκδοση (${app.getVersion()}).` });
  }
  return updateState;
}

async function installUpdateNow() {
  if (!updater || updateState.state !== 'downloaded') return;
  console.log(`Installing update ${updateState.version}`);
  await shutdown('before-update');
  shutdownDone = true;
  // Silent install, then start the new version.
  updater.quitAndInstall(true, true);
}

// ---- Start and stop ---------------------------------------------------------------------------

/** Local mode: backup (always before an update, otherwise when the daily one is due), close the database. */
async function shutdown(reason) {
  if (!server) return;
  try {
    const backup = await importServer('lib/backup.js');
    if (reason === 'before-update' || backup.backupDue()) {
      const file = await backup.runBackup(reason === 'before-update' ? 'before-update' : 'auto');
      console.log(`Backup on ${reason}: ${file.name}`);
    }
  } catch (err) {
    console.error('Backup on exit failed', err);
  }
  try {
    await server.close();
  } catch (err) {
    console.error('Server close failed', err);
  }
  server = null;
}

function restartApp() {
  // Tests start every run themselves.
  if (process.env.IMS_NO_RELAUNCH !== '1') app.relaunch();
  app.quit();
}

async function startLocal() {
  const { startServer } = await importServer('server.js');
  server = await startServer({ host: '127.0.0.1', port: PREFERRED_PORT, fallbackToFreePort: true });
  console.log(`Server running on ${server.url}, data in ${dataDir}`);
  createMainWindow(`${server.url}/`);
}

async function boot() {
  config = readConfig();
  if (!config && process.env.IMS_MODE === 'local') config = { mode: 'local' };
  // Version 1.x kept its data on this PC: carry on with it without asking.
  if (!config && fs.existsSync(path.join(dataDir, 'inventory.db'))) {
    config = { mode: 'local' };
    writeConfig(config);
  }
  buildMenu();
  initUpdater();
  if (!config) return openSetup();
  try {
    if (config.mode === 'remote') {
      console.log(`Opening server ${config.serverUrl}`);
      createMainWindow(`${config.serverUrl}/`);
    } else {
      await startLocal();
    }
  } catch (err) {
    console.error('Startup failed', err);
    dialog.showErrorBox(
      'Warehouse IMS',
      `Η εφαρμογή δεν μπόρεσε να ξεκινήσει.\n\n${err && err.message ? err.message : err}\n\nΑρχείο καταγραφής: ${logFile}`,
    );
    app.exit(1);
  }
}

if (!app.requestSingleInstanceLock()) {
  // Already running: the first instance brings its window to the front.
  app.quit();
} else {
  app.setAppUserModelId('gr.warehouseims.app');
  app.on('second-instance', () => {
    const w = mainWindow ?? setupWindow;
    if (w) {
      if (w.isMinimized()) w.restore();
      w.focus();
    }
  });
  app.whenReady().then(boot);
  app.on('window-all-closed', () => app.quit());

  // On exit: backup if due, close the database cleanly, then let the quit continue (an
  // update downloaded earlier is installed at this point by electron-updater).
  app.on('before-quit', (event) => {
    if (shutdownDone || !server) return;
    event.preventDefault();
    if (shuttingDown) return;
    shuttingDown = true;
    void shutdown('quit').finally(() => {
      shutdownDone = true;
      app.quit();
    });
  });
}
