const {
  app,
  BrowserWindow,
  BrowserView,
  session,
  ipcMain,
  globalShortcut,
  shell,
  dialog,
} = require('electron');
const path = require('path');
const { setupInterceptors, handlers } = require('./ipc-handlers');
const SimpleStore = require('./storage');
const discordRPC = require('./discord-rpc');

const ROOT = path.join(__dirname, '..', '..');
const PRELOAD = path.join(__dirname, '..', 'preload');
const RENDERER = path.join(__dirname, '..', 'renderer');
const SETTINGS = path.join(__dirname, '..', 'settings');

const DEFAULT_URL = 'https://pstream.net';

const store = new SimpleStore({
  configName: 'pstream-local-prefs',
  defaults: {
    streamUrl: DEFAULT_URL,
    hardwareAcceleration: true,
  },
});

let settingsWindow = null;
let mainBrowserView = null;
let frontendProcess = null;

}

const PASSKEY_PERMISSIONS = new Set(['publickey-credentials-create', 'publickey-credentials-get']);

function createWindow() {
  const TITLE_BAR_HEIGHT = 40;
  const isMac = process.platform === 'darwin';

  const mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    autoHideMenuBar: true,
    backgroundColor: '#1a1b1e',
    fullscreenable: true,
    frame: false,
    titleBarStyle: isMac ? 'hiddenInset' : undefined,
    trafficLightPosition: isMac ? { x: 12, y: 12 } : undefined,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(PRELOAD, 'preload-titlebar.js'),
    },
    title: 'P-Stream',
  });

  mainWindow.setMenu(null);
  mainWindow.loadFile(path.join(RENDERER, 'index.html'));

  const view = new BrowserView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      persistSessionCookies: true,
      preload: path.join(PRELOAD, 'preload.js'),
    },
  });

  mainBrowserView = view;

  // Set up CORS bypass
  setupInterceptors(view.webContents.session, {
    getStreamHostname: () => {
      try {
        const url = store.get('streamUrl') || DEFAULT_URL;
        return new URL(url.startsWith('http') ? url : `http://${url}`).hostname;
      } catch {
        return null;
      }
    },
  });

  // Permissions
  view.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'fullscreen') return callback(true);
    if (PASSKEY_PERMISSIONS.has(permission)) return callback(true);
    callback(false);
  });

  view.webContents.session.setPermissionCheckHandler((webContents, permission) => {
    if (permission === 'fullscreen') return true;
    if (PASSKEY_PERMISSIONS.has(permission)) return true;
    return false;
  });

  mainWindow.setBrowserView(view);

  const resizeView = () => {
    const { width, height } = mainWindow.getContentBounds();
    const isFullscreen = mainWindow.isFullScreen();
    if (isFullscreen) {
      view.setBounds({ x: 0, y: 0, width, height });
    } else {
      view.setBounds({ x: 0, y: TITLE_BAR_HEIGHT, width, height: height - TITLE_BAR_HEIGHT });
    }
  };

  resizeView();
  view.setAutoResize({ width: true, height: true });

  mainWindow.on('resize', resizeView);
  mainWindow.on('maximize', () => mainWindow.webContents.send('window-maximized', true));
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('window-maximized', false));
  mainWindow.on('focus', () => {
    if (view && view.webContents) view.webContents.focus();
  });

  // Fullscreen handling
  mainWindow.on('enter-full-screen', () => {
    mainWindow.webContents.send('window-fullscreen', true);
    resizeView();
  });
  mainWindow.on('leave-full-screen', () => {
    mainWindow.webContents.send('window-fullscreen', false);
    resizeView();
  });
  view.webContents.on('enter-html-full-screen', () => {
    mainWindow.setFullScreen(true);
    mainWindow.webContents.send('window-fullscreen', true);
    setTimeout(resizeView, 50);
  });
  view.webContents.on('leave-html-full-screen', () => {
    mainWindow.setFullScreen(false);
    mainWindow.webContents.send('window-fullscreen', false);
    setTimeout(resizeView, 50);
  });

  // Subtitle fullscreen fix
  const injectSubtitleFix = () => {
    const script = `
      (function() {
        if (window.__pstreamSubFixInjected) return;
        window.__pstreamSubFixInjected = true;
        const style = document.createElement('style');
        style.textContent = \`
          video::-webkit-media-text-track-container,
          video::-webkit-media-text-track-display { display: block !important; visibility: visible !important; }
        \`;
        (document.head || document.documentElement).appendChild(style);
      })();
    `;
    view.webContents.executeJavaScript(script).catch(() => {});
  };

  // Media watcher — sends play/pause/title to Discord RPC
  const injectMediaWatcher = () => {
    const script = `
      (function() {
        if (window.__pstreamMediaWatcherInjected) return;
        window.__pstreamMediaWatcherInjected = true;
        let lastMetadata = null;
        let lastProgress = null;
        const isSame = (a, b) => JSON.stringify(a) === JSON.stringify(b);
        const getAbsoluteUrl = (url) => {
          if (!url) return null;
          try {
            if (url.startsWith('http') || url.startsWith('data:')) return url;
            return new URL(url, window.location.href).href;
          } catch { return url; }
        };
        const sendUpdate = () => {
          try {
            const metadata = navigator.mediaSession?.metadata;
            const video = document.querySelector('video');
            let currentTime = null, duration = null, isPlaying = false;
            if (video && !isNaN(video.currentTime) && !isNaN(video.duration)) {
              currentTime = video.currentTime;
              duration = video.duration;
              isPlaying = !video.paused;
            }
            let posterUrl = null;
            if (metadata?.artwork?.length > 0) posterUrl = getAbsoluteUrl(metadata.artwork[0].src);
            const currentMetadata = metadata ? {
              title: metadata.title || null,
              artist: metadata.artist || null,
              poster: posterUrl,
            } : null;
            const currentProgress = { currentTime, duration, isPlaying, playbackState: navigator.mediaSession?.playbackState };
            if (!isSame(currentMetadata, lastMetadata) || !isSame(currentProgress, lastProgress)) {
              lastMetadata = currentMetadata;
              lastProgress = currentProgress;
              window.postMessage({ name: 'updateMediaMetadata', body: { metadata: currentMetadata, progress: currentProgress } }, '*');
            }
          } catch(e) {}
        };
        if (navigator.mediaSession) {
          let _meta = navigator.mediaSession.metadata;
          Object.defineProperty(navigator.mediaSession, 'metadata', {
            get: () => _meta,
            set: (v) => { _meta = v; setTimeout(sendUpdate, 100); },
            configurable: true, enumerable: true,
          });
          setInterval(sendUpdate, 2000);
          ['play','pause','timeupdate','loadedmetadata','seeked'].forEach(e => document.addEventListener(e, sendUpdate, true));
          setTimeout(sendUpdate, 1000);
        }
      })();
    `;
    view.webContents.executeJavaScript(script).catch(() => {});
  };

  view.webContents.on('did-finish-load', () => {
    injectSubtitleFix();
    injectMediaWatcher();
  });
  view.webContents.on('did-navigate', () => {
    setTimeout(injectSubtitleFix, 200);
    setTimeout(injectMediaWatcher, 1000);
  });

  // Keyboard shortcut: Cmd+R reloads view
  mainWindow.webContents.on('before-input-event', (event, input) => {
    const isReload =
      (process.platform === 'darwin' && input.meta && input.key.toLowerCase() === 'r') ||
      (process.platform !== 'darwin' && input.control && input.key.toLowerCase() === 'r');
    if (isReload && input.type === 'keyDown') {
      view.webContents.reload();
      event.preventDefault();
    }
  });

  // Open external links in browser
  view.webContents.setWindowOpenHandler(({ url }) => {
    const streamUrl = store.get('streamUrl') || DEFAULT_URL;
    try {
      const streamHost = new URL(streamUrl.startsWith('http') ? streamUrl : `http://${streamUrl}`).hostname;
      const targetHost = new URL(url).hostname;
      if (streamHost !== targetHost) {
        shell.openExternal(url);
        return { action: 'deny' };
      }
    } catch {}
    view.webContents.loadURL(url);
    return { action: 'deny' };
  });

  // Update title
  view.webContents.on('page-title-updated', (event, title) => {
    event.preventDefault();
    const cleanTitle = title.replace(' • P-Stream', '');
    mainWindow.setTitle(cleanTitle === 'P-Stream' ? 'P-Stream' : `${cleanTitle} • P-Stream`);
    mainWindow.webContents.send('title-changed', mainWindow.getTitle());
    discordRPC.setCurrentActivityTitle(cleanTitle === 'P-Stream' ? null : cleanTitle);
    if (!discordRPC.getCurrentMediaMetadata()) {
      discordRPC.setActivity(cleanTitle === 'P-Stream' ? null : cleanTitle);
    }
  });

  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.send('title-changed', mainWindow.getTitle());
    mainWindow.webContents.send('window-maximized', mainWindow.isMaximized());
    mainWindow.webContents.send('window-fullscreen', mainWindow.isFullScreen());
    mainWindow.webContents.send('platform-changed', process.platform);
  });

  // Settings shortcut
  const shortcut = process.platform === 'darwin' ? 'Command+,' : 'Control+,';
  mainWindow.on('focus', () => globalShortcut.register(shortcut, openSettingsWindow));
  mainWindow.on('blur', () => globalShortcut.unregister(shortcut));
  mainWindow.on('closed', () => globalShortcut.unregister(shortcut));

  // Load the stream URL
  const streamUrl = store.get('streamUrl') || DEFAULT_URL;
  const fullUrl = streamUrl.startsWith('http') ? streamUrl : `http://${streamUrl}`;
  view.webContents.loadURL(fullUrl);

  // Error page on load failure
  view.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    view.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
      <!DOCTYPE html>
      <html>
      <head><style>
        body { background: #1a1b1e; color: #e4e4e7; font-family: -apple-system, sans-serif;
               display: flex; align-items: center; justify-content: center; min-height: 100vh;
               margin: 0; text-align: center; }
        .box { max-width: 400px; }
        h1 { font-size: 20px; margin-bottom: 12px; }
        p { color: #a1a1aa; font-size: 14px; line-height: 1.6; }
        .url { color: #6366f1; font-size: 13px; margin: 12px 0; word-break: break-all; }
        button { margin-top: 20px; padding: 10px 24px; background: #6366f1; color: white;
                 border: none; border-radius: 8px; font-size: 14px; cursor: pointer; }
        button:hover { background: #4f46e5; }
      </style></head>
      <body>
        <div class="box">
          <h1>⚠️ Could not connect</h1>
          <p>Failed to load P-Stream.</p>
          <p class="url">${url}</p>
          <p>Check your internet connection or try a different URL in Settings.</p>
          <button onclick="location.reload()">Retry</button>
        </div>
      </body>
      </html>
    `)}`);
  });
}

function openSettingsWindow() {
  if (settingsWindow) { settingsWindow.focus(); return; }

  settingsWindow = new BrowserWindow({
    width: 500,
    height: 600,
    minWidth: 400,
    minHeight: 400,
    resizable: true,
    autoHideMenuBar: true,
    backgroundColor: '#1a1b1e',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(PRELOAD, 'preload-settings.js'),
    },
    title: 'Settings',
    show: false,
  });

  settingsWindow.setMenu(null);
  settingsWindow.loadFile(path.join(SETTINGS, 'settings.html'));
  settingsWindow.once('ready-to-show', () => settingsWindow.show());
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

app.whenReady().then(() => {
  app.setName('P-Stream');

  // Initialize Discord RPC
  discordRPC.initialize(store);

  // Register IPC handlers (CORS bypass)
  Object.entries(handlers).forEach(([channel, handler]) => {
    ipcMain.handle(channel, async (event, ...args) => handler(...args));
  });

  ipcMain.handle('openControlPanel', openSettingsWindow);

  // Window controls
  ipcMain.on('window-minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize());
  ipcMain.on('window-maximize-toggle', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return;
    win.isMaximized() ? win.unmaximize() : win.maximize();
  });
  ipcMain.on('window-close', (e) => BrowserWindow.fromWebContents(e.sender)?.close());
  ipcMain.on('open-settings', openSettingsWindow);
  ipcMain.on('open-embed-devtools', () => mainBrowserView?.webContents.toggleDevTools());

  // Stream URL handlers
  ipcMain.handle('get-stream-url', () => store.get('streamUrl') || DEFAULT_URL);
  ipcMain.handle('set-stream-url', async (event, url) => {
    const normalized = url.trim().replace(/\/$/, '');
    if (!normalized) throw new Error('URL cannot be empty');
    store.set('streamUrl', normalized);
    console.log('[set-stream-url] saving:', normalized);
    const fullUrl = normalized.startsWith('http') ? normalized : `https://${normalized}`;

    // Try mainBrowserView, then scan all windows
    if (mainBrowserView && mainBrowserView.webContents) {
      mainBrowserView.webContents.loadURL(fullUrl);
    } else {
      BrowserWindow.getAllWindows().forEach((win) => {
        const bv = win.getBrowserView();
        if (bv && bv.webContents) bv.webContents.loadURL(fullUrl);
      });
    }
    return true;
  });

  // Hardware acceleration
  ipcMain.handle('get-hardware-acceleration', () => store.get('hardwareAcceleration', true));
  ipcMain.handle('set-hardware-acceleration', async (event, enabled) => {
    store.set('hardwareAcceleration', enabled);
    return { success: true };
  });

  ipcMain.handle('get-app-version', () => app.getVersion());

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
