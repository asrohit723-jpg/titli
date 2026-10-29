// CI only: a stand-in for "another app in full screen" (run with the plain Electron binary: npx electron <this file>).
// Titli's panel then has to open on top of it and stay open.
const { app, BrowserWindow } = require('electron');

app.whenReady().then(() => {
  const w = new BrowserWindow({ width: 900, height: 600, backgroundColor: '#1d3557', show: true });
  w.loadURL('data:text/html,' + encodeURIComponent('<body style="margin:0;height:100vh;display:grid;place-items:center;background:#1d3557;color:#fff;font:600 44px -apple-system">Another app, full screen</body>'));
  w.on('enter-full-screen', () => console.log('[helper] entered full screen'));
  w.on('leave-full-screen', () => console.log('[helper] left full screen'));
  setTimeout(() => w.setFullScreen(true), 800);
  setInterval(() => console.log(`[helper] fullScreen=${w.isFullScreen()} focused=${w.isFocused()}`), 1000);
});
