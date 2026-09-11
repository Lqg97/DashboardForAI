// AI Sub Dashboard - Electron Desktop App
// 支持：系统菜单栏常驻托盘 (Menu Bar Tray)、独立应用窗口、开机自启动、后台无感守护

import { app, BrowserWindow, Tray, Menu, nativeImage, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { startServer } from '../server/index.js';
import { PORT } from '../server/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 单实例锁：防止重复启动多个进程
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

let mainWindow = null;
let tray = null;
let serverInstance = null;
let isQuitting = false;

const SERVER_URL = `http://127.0.0.1:${PORT}`;

// 启动内置 Node 服务
function initServer() {
  try {
    serverInstance = startServer();
  } catch (err) {
    console.error('[desktop] server start error:', err);
  }
}

// 创建主应用窗口
function createMainWindow() {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return mainWindow;
  }

  const iconPath = join(__dirname, 'assets', 'icon.png');

  mainWindow = new BrowserWindow({
    width: 1260,
    height: 840,
    minWidth: 920,
    minHeight: 640,
    title: 'AI Sub Dashboard',
    icon: existsSync(iconPath) ? iconPath : undefined,
    backgroundColor: '#0b0f19',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 18, y: 18 },
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  mainWindow.loadURL(SERVER_URL);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // 保底容错：确保即使首帧渲染偶发延迟，窗口也能在 600ms 内优雅呈现
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      mainWindow.show();
    }
  }, 600);

  // 处理窗口关闭事件：macOS 上默认隐藏窗口而不是退出，保持托盘在菜单栏常驻
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  // 拦截外链并在系统默认浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  return mainWindow;
}

// 创建系统托盘 (Menu Bar / Tray)
function createTray() {
  let trayIconPath;
  if (process.platform === 'darwin') {
    trayIconPath = join(__dirname, 'assets', 'trayTemplate.png');
  } else {
    trayIconPath = join(__dirname, 'assets', 'tray.png');
  }

  let trayImg = nativeImage.createFromPath(trayIconPath);
  if (process.platform === 'darwin') {
    trayImg.setTemplateImage(true);
  }

  tray = new Tray(trayImg);
  tray.setToolTip('AI Sub Dashboard - AI 订阅与用量看板');

  function updateContextMenu() {
    const isLoginItem = app.getLoginItemSettings().openAtLogin;

    fetch(`${SERVER_URL}/api/online`)
      .then(r => (r.ok ? r.json() : null))
      .then(online => {
        const enabled = !!(online && online.enabled);
        const statusText = enabled
          ? (online.lastError ? ' · ⚠ ' + String(online.lastError).slice(0, 40) : (online.lastReportAt ? ' · 上次上报 ' + new Date(online.lastReportAt).toLocaleTimeString('zh-CN') : ' · 首次上报中'))
          : ' · 未开启';
        tray.setToolTip('AI Sub Dashboard - AI 订阅与用量看板' + (enabled ? ' (联机上报开启)' : ''));

        const contextMenu = Menu.buildFromTemplate([          {
            label: '📊 显示看板',
            click: () => {
              if (!mainWindow) createMainWindow();
              else {
                mainWindow.show();
                mainWindow.focus();
              }
            },
          },
          {
            label: '☁️ 联机上报: ' + (enabled ? '已开启' : '未开启') + statusText,
            type: 'checkbox',
            checked: enabled,
            click: async (item) => {
              try {
                const r = await fetch(`${SERVER_URL}/api/online/toggle`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ enabled: item.checked }),
                });
                if (!r.ok) {
                  item.checked = false;
                  console.error('[desktop] 联机上报开启失败:', (await r.text()).slice(0, 120));
                }
              } catch {}
              await refreshTrayMenu();
            },
          },
          {
            label: '⚙️ 联机设置(Hub 地址/令牌)...',
            click: () => {
              if (!mainWindow) createMainWindow();
              else {
                mainWindow.show();
                mainWindow.focus();
              }
              // 打开前端设置弹窗
              mainWindow.webContents.executeJavaScript(
                'typeof window.openOnlineSettings === "function" && window.openOnlineSettings()'
              ).catch(() => {});
            },
          },
          {
            label: '🏷️ 同步最新模型定价',
            click: async () => {
              try {
                await fetch(`${SERVER_URL}/api/pricing/sync`, { method: 'POST' });
                if (mainWindow && !mainWindow.isDestroyed()) {
                  mainWindow.webContents.reload();
                }
              } catch {}
            },
          },
          {
            label: '🌐 在浏览器中打开',
            click: () => {
              shell.openExternal(SERVER_URL);
            },
          },
          { type: 'separator' },
          {
            label: '🚀 开机自启动',
            type: 'checkbox',
            checked: isLoginItem,
            click: (item) => {
              app.setLoginItemSettings({
                openAtLogin: item.checked,
                openAsHidden: true,
              });
              updateContextMenu();
            },
          },
          { type: 'separator' },
          {
            label: '🚪 退出 AI Sub Dashboard',
            click: () => {
              isQuitting = true;
              app.quit();
            },
          },
        ]);

        tray.setContextMenu(contextMenu);
      });
  }

  // 动态重建托盘菜单(上报状态/开关变化后刷新)
  function refreshTrayMenu() {
    try { updateContextMenu(); } catch { /* 忽略 */ }
  }

  updateContextMenu();
  // 菜单为静态快照, 周期刷新以更新上报状态文案
  const trayTimer = setInterval(refreshTrayMenu, 30000);
  trayTimer.unref?.();

  // 左键点击托盘图标切换窗口显示/隐藏
  tray.on('click', () => {
    if (!mainWindow) {
      createMainWindow();
    } else if (mainWindow.isVisible() && mainWindow.isFocused()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// 创建系统菜单栏（支持标准复制粘贴快捷键）
function createApplicationMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{
      label: app.name,
      submenu: [
        { role: 'about', label: '关于 AI Sub Dashboard' },
        { type: 'separator' },
        {
          label: '偏好设置 / 数据刷新',
          accelerator: 'CmdOrCtrl+R',
          click: () => mainWindow?.webContents.reload(),
        },
        { type: 'separator' },
        { role: 'hide', label: '隐藏应用' },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '显示全部' },
        { type: 'separator' },
        {
          label: '退出',
          accelerator: 'CmdOrCtrl+Q',
          click: () => {
            isQuitting = true;
            app.quit();
          },
        },
      ],
    }] : []),
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'forceReload', label: '强制刷新' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '重置缩放' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '切换全屏' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        ...(process.platform === 'darwin' ? [
          { type: 'separator' },
          { role: 'front', label: '前置所有窗口' },
          {
            label: '关闭窗口',
            accelerator: 'CmdOrCtrl+W',
            click: () => mainWindow?.hide(),
          },
        ] : [
          { role: 'close', label: '关闭' },
        ]),
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '在浏览器中打开',
          click: () => shell.openExternal(SERVER_URL),
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// 应用就绪生命周期
app.whenReady().then(() => {
  initServer();
  createMainWindow();
  createTray();
  createApplicationMenu();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    } else if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
});

// 多实例再次打开时唤醒主窗口
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

// 在退出前清理
app.on('before-quit', () => {
  isQuitting = true;
});

app.on('window-all-closed', () => {
  // 保持应用在后台菜单栏托盘运行
});
