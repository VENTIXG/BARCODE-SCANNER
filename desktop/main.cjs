/**
 * Warehouse IMS — Windows desktop app.
 *
 * Starts the built-in server (API + web app) on 127.0.0.1 only and shows it in
 * an app window. Data (database, photos, backups) lives in
 * %APPDATA%\Warehouse IMS\data and is kept when the app is updated or removed.
 */
const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const PREFERRED_PORT = 47231;

const dataDir = path.join(app.getPath('userData'), 'data');
process.env.DATA_DIR = dataDir;
process.env.NODE_ENV = 'production';

// Simple log file for support: %APPDATA%\Warehouse IMS\logs\main.log
const logDir = path.join(app.getPath('userData'), 'logs');
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
let server = null;
let quitting = false;

const importServer = (file) => import(pathToFileURL(path.join(__dirname, 'server', 'dist', file)).href);

function buildMenu() {
  const template = [
    {
      label: 'Αρχείο',
      submenu: [
        { label: 'Άνοιγμα φακέλου δεδομένων', click: () => shell.openPath(dataDir) },
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
      label: 'Βοήθεια',
      submenu: [
        {
          label: 'Σχετικά με το Warehouse IMS',
          click: () =>
            dialog.showMessageBox(mainWindow, {
              title: 'Warehouse IMS',
              message: `Warehouse IMS ${app.getVersion()}`,
              detail: `Φάκελος δεδομένων:\n${dataDir}`,
            }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow(url) {
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
    },
  });
  mainWindow.once('ready-to-show', () => {
    mainWindow.maximize();
    mainWindow.show();
  });
  // Links to other sites open in the normal browser, never inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (!target.startsWith(url)) shell.openExternal(target);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, target) => {
    if (!target.startsWith(url)) {
      event.preventDefault();
      shell.openExternal(target);
    }
  });
  mainWindow.on('closed', () => (mainWindow = null));
  mainWindow.loadURL(url);
}

ipcMain.handle('ims:choose-folder', async (_event, current) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Φάκελος backup',
    defaultPath: typeof current === 'string' ? current : undefined,
    properties: ['openDirectory', 'createDirectory'],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('ims:open-folder', async (_event, folder) => {
  if (typeof folder === 'string' && fs.existsSync(folder) && fs.statSync(folder).isDirectory()) await shell.openPath(folder);
});

async function boot() {
  buildMenu();
  try {
    const { startServer } = await importServer('server.js');
    server = await startServer({ host: '127.0.0.1', port: PREFERRED_PORT, fallbackToFreePort: true });
    console.log(`Server running on ${server.url}, data in ${dataDir}`);
    createWindow(`${server.url}/`);
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
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.whenReady().then(boot);
  app.on('window-all-closed', () => app.quit());

  // On exit: take the daily backup if it is due, then close the database cleanly.
  app.on('before-quit', async (event) => {
    if (quitting || !server) return;
    event.preventDefault();
    quitting = true;
    try {
      const backup = await importServer('lib/backup.js');
      if (backup.backupDue()) {
        const file = await backup.runBackup('auto');
        console.log(`Backup on exit: ${file.name}`);
      }
    } catch (err) {
      console.error('Backup on exit failed', err);
    }
    try {
      await server.close();
    } catch (err) {
      console.error('Server close failed', err);
    }
    app.exit(0);
  });
}
