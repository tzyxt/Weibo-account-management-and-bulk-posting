import { app, BrowserWindow, clipboard, dialog, Menu, shell, type WebContents } from 'electron';
import { basename, extname, join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { AppDatabase } from './db/database';
import { registerIpc } from './ipc';

let mainWindow: BrowserWindow | null = null;
let db: AppDatabase | null = null;

const imageExtensionByType: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp'
};

function filenameFromImageUrl(url: string, contentType?: string | null): string {
  const extensionFromType = contentType ? imageExtensionByType[contentType.split(';')[0].trim().toLowerCase()] : '';
  try {
    const parsed = new URL(url);
    const name = basename(parsed.pathname).replace(/[<>:"/\\|?*]+/g, '_') || 'weibo-image';
    const extension = extname(name) || extensionFromType || '.jpg';
    return extname(name) ? name : `${name}${extension}`;
  } catch {
    return `weibo-image${extensionFromType || '.jpg'}`;
  }
}

async function saveImageFromUrl(url: string, contents: WebContents): Promise<void> {
  if (!url) {
    return;
  }

  let data: Buffer;
  let contentType = '';
  if (url.startsWith('data:')) {
    const match = url.match(/^data:([^;,]+)?(;base64)?,(.*)$/);
    if (!match) {
      return;
    }
    contentType = match[1] || 'image/png';
    data = Buffer.from(decodeURIComponent(match[3]), match[2] ? 'base64' : 'utf8');
  } else {
    const response = await fetch(url, {
      headers: {
        referer: contents.getURL() || 'https://weibo.com/',
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36'
      }
    });
    if (!response.ok) {
      throw new Error(`图片下载失败：${response.status}`);
    }
    contentType = response.headers.get('content-type') || '';
    data = Buffer.from(await response.arrayBuffer());
  }

  const ownerWindow = BrowserWindow.fromWebContents(contents) ?? BrowserWindow.getFocusedWindow();
  const options = {
    title: '保存图片',
    defaultPath: filenameFromImageUrl(url, contentType),
    filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'] }]
  };
  const result = ownerWindow ? await dialog.showSaveDialog(ownerWindow, options) : await dialog.showSaveDialog(options);
  if (!result.canceled && result.filePath) {
    await writeFile(result.filePath, data);
  }
}

function registerContextMenus(): void {
  app.on('web-contents-created', (_event, contents) => {
    contents.on('context-menu', (_menuEvent, params) => {
      const imageUrl = params.srcURL;
      if (params.mediaType !== 'image' || !imageUrl) {
        return;
      }
      Menu.buildFromTemplate([
        {
          label: '保存图片',
          click: () => {
            void saveImageFromUrl(imageUrl, contents).catch((error) => {
              dialog.showErrorBox('保存图片失败', error instanceof Error ? error.message : '无法保存图片');
            });
          }
        },
        {
          label: '复制图片链接',
          click: () => clipboard.writeText(imageUrl)
        },
        {
          label: '在浏览器中打开图片',
          click: () => {
            if (/^https?:\/\//i.test(imageUrl)) {
              void shell.openExternal(imageUrl);
            }
          }
        }
      ]).popup({ window: BrowserWindow.fromWebContents(contents) ?? BrowserWindow.getFocusedWindow() ?? undefined });
    });
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1120,
    minHeight: 720,
    title: '微博账号管理系统',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      webviewTag: true
    }
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.setAutoHideMenuBar(true);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(() => {
  db = new AppDatabase();
  registerContextMenus();
  createWindow();
  if (mainWindow) {
    registerIpc(db, mainWindow);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      if (mainWindow && db) {
        registerIpc(db, mainWindow);
      }
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
