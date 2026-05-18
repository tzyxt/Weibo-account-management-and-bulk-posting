import { app, BrowserWindow, clipboard, dialog, Menu, nativeImage, shell, type WebContents } from 'electron';
import { extname, join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { AppDatabase } from './db/database';
import { registerIpc } from './ipc';

let mainWindow: BrowserWindow | null = null;
let db: AppDatabase | null = null;

function isNavigationAbort(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const value = error as { code?: string; errno?: number; message?: string };
  return value.errno === -3 || value.code === 'ERR_ABORTED' || /ERR_ABORTED|\(-3\)/.test(value.message || '');
}

const imageExtensionByType: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp'
};

function timestampImageName(extension: string): string {
  const now = new Date();
  const pad = (value: number, length = 2): string => String(value).padStart(length, '0');
  const timestamp = [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    '-',
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
    '-',
    pad(now.getMilliseconds(), 3)
  ].join('');
  return `${timestamp}${extension}`;
}

function filenameFromImageUrl(url: string, contentType?: string | null): string {
  const extensionFromType = contentType ? imageExtensionByType[contentType.split(';')[0].trim().toLowerCase()] : '';
  try {
    const parsed = new URL(url);
    const extension = extname(parsed.pathname) || extensionFromType || '.jpg';
    return timestampImageName(extension);
  } catch {
    return timestampImageName(extensionFromType || '.jpg');
  }
}

function isCroppableContentType(contentType: string): boolean {
  const type = contentType.split(';')[0].trim().toLowerCase();
  return type !== 'image/gif';
}

function pixelChannels(bitmap: Buffer, offset: number): { red: number; green: number; blue: number; alpha: number } {
  return {
    red: bitmap[offset] ?? 255,
    green: bitmap[offset + 1] ?? 255,
    blue: bitmap[offset + 2] ?? 255,
    alpha: bitmap[offset + 3] ?? 255
  };
}

type WatermarkBounds = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

function isLightGrayWatermarkPixel(red: number, green: number, blue: number, alpha: number): boolean {
  const brightest = Math.max(red, green, blue);
  const darkest = Math.min(red, green, blue);
  const spread = brightest - darkest;
  return alpha > 20 && darkest >= 135 && brightest <= 245 && spread <= 32;
}

function detectBottomRightWatermarkBounds(bitmap: Buffer, width: number, height: number): WatermarkBounds | null {
  const bytesPerPixel = 4;
  const startX = Math.max(0, Math.round(width * 0.5));
  const endX = width;
  const startY = Math.max(0, Math.round(height * 0.72));
  const minGrayPixels = Math.max(6, Math.round((endX - startX) * 0.015));
  const watermarkRows: number[] = [];
  let left = width;
  let right = 0;

  for (let y = height - 1; y >= startY; y -= 1) {
    let grayPixels = 0;
    const rowOffset = y * width * bytesPerPixel;

    for (let x = startX; x < endX; x += 1) {
      const { red, green, blue, alpha } = pixelChannels(bitmap, rowOffset + x * bytesPerPixel);

      if (isLightGrayWatermarkPixel(red, green, blue, alpha)) {
        grayPixels += 1;
        left = Math.min(left, x);
        right = Math.max(right, x);
      }
    }

    if (grayPixels >= minGrayPixels) {
      watermarkRows.push(y);
    } else if (watermarkRows.length >= 4 && y < watermarkRows[watermarkRows.length - 1] - 4) {
      break;
    }
  }

  if (watermarkRows.length < 4) {
    return null;
  }

  const paddingX = Math.max(8, Math.round(width * 0.012));
  const paddingY = Math.max(4, Math.round(height * 0.006));
  return {
    left: Math.max(0, left - paddingX),
    top: Math.max(0, Math.min(...watermarkRows) - paddingY),
    right: Math.min(width - 1, right + paddingX),
    bottom: Math.min(height - 1, Math.max(...watermarkRows) + paddingY)
  };
}

function isWatermarkMaskPixel(red: number, green: number, blue: number, alpha: number): boolean {
  const brightest = Math.max(red, green, blue);
  const darkest = Math.min(red, green, blue);
  const luma = red * 0.299 + green * 0.587 + blue * 0.114;
  const spread = brightest - darkest;
  return alpha > 20 && (isLightGrayWatermarkPixel(red, green, blue, alpha) || (luma >= 118 && spread <= 58));
}

function maskIndex(x: number, y: number, bounds: WatermarkBounds): number {
  return (y - bounds.top) * (bounds.right - bounds.left + 1) + (x - bounds.left);
}

function dilateMask(mask: Uint8Array, bounds: WatermarkBounds, passes: number): Uint8Array {
  const maskWidth = bounds.right - bounds.left + 1;
  const maskHeight = bounds.bottom - bounds.top + 1;
  let current = mask;

  for (let pass = 0; pass < passes; pass += 1) {
    const next = new Uint8Array(current);

    for (let y = 0; y < maskHeight; y += 1) {
      for (let x = 0; x < maskWidth; x += 1) {
        if (current[y * maskWidth + x]) {
          continue;
        }

        let touchesMask = false;
        for (let dy = -1; dy <= 1 && !touchesMask; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx >= 0 && nx < maskWidth && ny >= 0 && ny < maskHeight && current[ny * maskWidth + nx]) {
              touchesMask = true;
              break;
            }
          }
        }

        if (touchesMask) {
          next[y * maskWidth + x] = 1;
        }
      }
    }

    current = next;
  }

  return current;
}

function averageUnmaskedNeighbors(
  bitmap: Buffer,
  mask: Uint8Array,
  bounds: WatermarkBounds,
  width: number,
  x: number,
  y: number
): { red: number; green: number; blue: number; alpha: number } | null {
  const bytesPerPixel = 4;
  let redTotal = 0;
  let greenTotal = 0;
  let blueTotal = 0;
  let alphaTotal = 0;
  let weightTotal = 0;

  for (let dy = -2; dy <= 2; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) {
      if (dx === 0 && dy === 0) {
        continue;
      }

      const nx = x + dx;
      const ny = y + dy;
      if (nx < bounds.left || nx > bounds.right || ny < bounds.top || ny > bounds.bottom) {
        continue;
      }

      const index = maskIndex(nx, ny, bounds);
      if (mask[index]) {
        continue;
      }

      const distance = Math.max(1, Math.abs(dx) + Math.abs(dy));
      const weight = 1 / distance;
      const color = pixelChannels(bitmap, (ny * width + nx) * bytesPerPixel);
      redTotal += color.red * weight;
      greenTotal += color.green * weight;
      blueTotal += color.blue * weight;
      alphaTotal += color.alpha * weight;
      weightTotal += weight;
    }
  }

  if (weightTotal === 0) {
    return null;
  }

  return {
    red: Math.round(redTotal / weightTotal),
    green: Math.round(greenTotal / weightTotal),
    blue: Math.round(blueTotal / weightTotal),
    alpha: Math.round(alphaTotal / weightTotal)
  };
}

function clearBottomRightWatermark(bitmap: Buffer, width: number, height: number, bounds: WatermarkBounds): Buffer {
  const bytesPerPixel = 4;
  const cleaned = Buffer.from(bitmap);
  const maskWidth = bounds.right - bounds.left + 1;
  const maskHeight = bounds.bottom - bounds.top + 1;
  let mask: Uint8Array<ArrayBufferLike> = new Uint8Array(maskWidth * maskHeight);

  for (let y = bounds.top; y <= bounds.bottom; y += 1) {
    const rowOffset = y * width * bytesPerPixel;

    for (let x = bounds.left; x <= bounds.right; x += 1) {
      const offset = rowOffset + x * bytesPerPixel;
      const { red, green, blue, alpha } = pixelChannels(bitmap, offset);

      if (isWatermarkMaskPixel(red, green, blue, alpha)) {
        mask[maskIndex(x, y, bounds)] = 1;
      }
    }
  }

  mask = dilateMask(mask, bounds, 1);

  for (let pass = 0; pass < maskWidth + maskHeight; pass += 1) {
    let changed = false;

    for (let y = bounds.top; y <= bounds.bottom; y += 1) {
      for (let x = bounds.left; x <= bounds.right; x += 1) {
        const index = maskIndex(x, y, bounds);
        if (!mask[index]) {
          continue;
        }

        const background = averageUnmaskedNeighbors(cleaned, mask, bounds, width, x, y);
        if (!background) {
          continue;
        }

        const offset = (y * width + x) * bytesPerPixel;
        cleaned[offset] = background.red;
        cleaned[offset + 1] = background.green;
        cleaned[offset + 2] = background.blue;
        cleaned[offset + 3] = background.alpha;
        mask[index] = 0;
        changed = true;
      }
    }

    if (!changed) {
      break;
    }
  }

  return cleaned;
}

function encodeImage(image: Electron.NativeImage, contentType: string): { data: Buffer; contentType: string } {
  const type = contentType.split(';')[0].trim().toLowerCase();
  if (type === 'image/jpeg' || type === 'image/jpg') {
    return { data: image.toJPEG(95), contentType: 'image/jpeg' };
  }

  return { data: image.toPNG(), contentType: 'image/png' };
}

function cropImageAboveWatermark(
  image: Electron.NativeImage,
  contentType: string,
  width: number,
  height: number,
  bounds: WatermarkBounds
): { data: Buffer; contentType: string } | null {
  const bottomTouchTolerance = Math.max(8, Math.round(height * 0.018));
  const topPadding = Math.max(3, Math.round(height * 0.006));
  const cropHeight = Math.max(1, bounds.top - topPadding);
  const trimmedHeight = height - cropHeight;
  const maxWatermarkTrim = Math.max(36, Math.round(height * 0.08));

  if (height - bounds.bottom > bottomTouchTolerance || trimmedHeight > maxWatermarkTrim) {
    return null;
  }

  return encodeImage(image.crop({ x: 0, y: 0, width, height: cropHeight }), contentType);
}

function detectBottomTextWatermarkTop(bitmap: Buffer, width: number, height: number): number | null {
  const bytesPerPixel = 4;
  const startY = Math.max(0, Math.round(height * 0.88));
  const minPixels = Math.max(8, Math.round(width * 0.006));
  const rows: number[] = [];

  for (let y = height - 1; y >= startY; y -= 1) {
    let watermarkPixels = 0;
    const rowOffset = y * width * bytesPerPixel;

    for (let x = 0; x < width; x += 1) {
      const { red, green, blue, alpha } = pixelChannels(bitmap, rowOffset + x * bytesPerPixel);
      const brightest = Math.max(red, green, blue);
      const darkest = Math.min(red, green, blue);
      const spread = brightest - darkest;
      const luma = red * 0.299 + green * 0.587 + blue * 0.114;
      const lightText = alpha > 20 && luma >= 175 && spread <= 70;
      const pinkText = alpha > 20 && red >= 190 && blue >= 135 && green <= 190 && red > green + 20;

      if (lightText || pinkText) {
        watermarkPixels += 1;
      }
    }

    if (watermarkPixels >= minPixels) {
      rows.push(y);
    } else if (rows.length >= 3 && y < rows[rows.length - 1] - 4) {
      break;
    }
  }

  if (rows.length < 3) {
    return null;
  }

  return Math.min(...rows);
}

function cropImageBottomWatermarkArea(
  data: Buffer,
  contentType: string
): { data: Buffer; contentType: string } {
  if (!isCroppableContentType(contentType)) {
    return { data, contentType };
  }

  const image = nativeImage.createFromBuffer(data);
  if (image.isEmpty()) {
    return { data, contentType };
  }

  const { width, height } = image.getSize();
  if (width < 80 || height < 80) {
    return { data, contentType };
  }

  const bitmap = image.toBitmap();
  const bottomTextWatermarkTop = detectBottomTextWatermarkTop(bitmap, width, height);
  if (bottomTextWatermarkTop) {
    const cropHeight = Math.max(1, bottomTextWatermarkTop - Math.max(3, Math.round(height * 0.006)));
    const trimmedHeight = height - cropHeight;
    const maxTrim = Math.max(32, Math.round(height * 0.08));

    if (trimmedHeight <= maxTrim) {
      return encodeImage(image.crop({ x: 0, y: 0, width, height: cropHeight }), contentType);
    }
  }

  const watermarkBounds = detectBottomRightWatermarkBounds(bitmap, width, height);
  if (!watermarkBounds) {
    return { data, contentType };
  }

  const croppedWatermark = cropImageAboveWatermark(image, contentType, width, height, watermarkBounds);
  if (croppedWatermark) {
    return croppedWatermark;
  }

  return { data, contentType };
}

function todayFolderName(): string {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

async function loadImageFromUrl(url: string, contents: WebContents): Promise<{ data: Buffer; contentType: string }> {
  let data: Buffer;
  let contentType = '';
  if (url.startsWith('data:')) {
    const match = url.match(/^data:([^;,]+)?(;base64)?,(.*)$/);
    if (!match) {
      throw new Error('无法解析图片数据');
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
  return { data, contentType };
}

async function quickSaveImageFromUrl(url: string, contents: WebContents): Promise<void> {
  if (!url) {
    return;
  }
  const loaded = await loadImageFromUrl(url, contents);
  const { data, contentType } = cropImageBottomWatermarkArea(loaded.data, loaded.contentType);
  const folder = join(app.getPath('pictures'), 'WeiboAccountManager', todayFolderName());
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, filenameFromImageUrl(url, contentType)), data);
}

async function saveImageFromUrl(url: string, contents: WebContents): Promise<void> {
  if (!url) {
    return;
  }

  const loaded = await loadImageFromUrl(url, contents);
  const { data, contentType } = cropImageBottomWatermarkArea(loaded.data, loaded.contentType);

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
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url) && contents !== mainWindow?.webContents) {
        void contents.loadURL(url).catch((error) => {
          if (!isNavigationAbort(error)) {
            console.error(error);
          }
        });
      } else if (/^https?:\/\//i.test(url)) {
        void shell.openExternal(url);
      }
      return { action: 'deny' };
    });

    contents.on('context-menu', (_menuEvent, params) => {
      const imageUrl = params.srcURL;
      if (params.mediaType !== 'image' || !imageUrl) {
        return;
      }
      Menu.buildFromTemplate([
        {
          label: '快速保存图片',
          click: () => {
            void quickSaveImageFromUrl(imageUrl, contents).catch((error) => {
              dialog.showErrorBox('快速保存图片失败', error instanceof Error ? error.message : '无法保存图片');
            });
          }
        },
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
