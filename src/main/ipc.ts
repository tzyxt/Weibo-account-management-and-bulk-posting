import { BrowserWindow, dialog, ipcMain, session } from 'electron';
import type {
  AccountPlatform,
  AutoCommentResult,
  AutoPublishResult,
  CommentTask,
  CompleteCommentPayload,
  CompletePostPayload,
  CreatePostPayload,
  FailCommentPayload,
  FailPostPayload,
  UpdateAccountPayload
} from '../shared/types';
import { AppDatabase } from './db/database';

const WEIBO_HOME_URL = 'https://weibo.com/';
const BAIDU_PAN_HOME_URL = 'https://pan.baidu.com/';
const REQUEST_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const runningAutoPostTaskIds = new Set<number>();

interface WeiboLoginProfile {
  uid: string;
  nickname: string;
  avatar: string;
}

interface AutoPublishPayload {
  taskId: number;
  accountId: number;
  content: string;
  images: string[];
  likeAfterPublish?: boolean;
}

interface AutoCommentPayload {
  taskId: number;
  accountId: number;
  weiboUrl: string;
  content: string;
  delaySeconds: number;
  replyToContent?: string | null;
}

const fallbackTopicSuffixes = ['[超话]', '分享', '日常', '推荐', '讨论'];

function text(value: unknown): string {
  return String(value ?? '').trim();
}

function normalizeUrl(value: unknown): string {
  return text(value).replace(/\\\//g, '/');
}

function readUserField(user: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = text(user[key]);
    if (value) {
      return value;
    }
  }
  return '';
}

function normalizeProfileUser(user: unknown): WeiboLoginProfile | null {
  if (!user || typeof user !== 'object') {
    return null;
  }
  const record = user as Record<string, unknown>;
  const uid = readUserField(record, ['id', 'uid', 'idstr']);
  const nickname = readUserField(record, ['screen_name', 'screenName', 'name', 'nickname']);
  const avatar = normalizeUrl(
    readUserField(record, ['avatar_hd', 'avatarLarge', 'avatar_large', 'profile_image_url', 'profileImageUrl', 'avatar'])
  );
  if (!nickname && !avatar && !uid) {
    return null;
  }
  return { uid, nickname, avatar };
}

function mergeProfile(base: WeiboLoginProfile | null, next: WeiboLoginProfile | null): WeiboLoginProfile | null {
  if (!base) {
    return next;
  }
  if (!next) {
    return base;
  }
  return {
    uid: next.uid || base.uid,
    nickname: next.nickname || base.nickname,
    avatar: next.avatar || base.avatar
  };
}

async function readJson(url: string, cookieHeader: string, referer: string): Promise<unknown> {
  const nextUrl = new URL(url);
  nextUrl.searchParams.set('_ts', String(Date.now()));
  const response = await fetch(nextUrl.href, {
    headers: {
      accept: 'application/json, text/plain, */*',
      'cache-control': 'no-cache',
      cookie: cookieHeader,
      referer,
      'user-agent': REQUEST_UA
    }
  });
  if (!response.ok) {
    return null;
  }
  return response.json();
}

function cleanTopicName(value: unknown): string {
  const cleaned = text(value)
    .replace(/<[^>]*>/g, '')
    .replace(/&[^;]+;/g, '')
    .replace(/^#+|#+$/g, '')
    .replace(/超话\]超话$/g, '超话]')
    .replace(/\s+/g, '')
    .trim();
  if (!cleaned) {
    return '';
  }
  const withoutRepeatedSupertopic = cleaned.replace(/(?:\[超话\])+$/g, '');
  if (/\[超话\]$/.test(cleaned) || /超话$/.test(cleaned)) {
    return `${withoutRepeatedSupertopic.replace(/超话$/g, '')}[超话]`;
  }
  return withoutRepeatedSupertopic || cleaned;
}

function collectTopicNames(value: unknown, names: Set<string>, fromTopicField = false): void {
  if (!value || names.size >= 20) {
    return;
  }
  if (typeof value === 'string') {
    const cleaned = cleanTopicName(value);
    if (fromTopicField && cleaned && cleaned.length <= 30 && !/微博|搜索|用户|综合|视频|图片|http|weibo\.com/i.test(cleaned)) {
      names.add(cleaned);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectTopicNames(item, names, fromTopicField);
    }
    return;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    ['title_sub', 'title', 'name', 'card_type_name'].forEach((key) => collectTopicNames(record[key], names, true));
    ['cards', 'card_group', 'group', 'items'].forEach((key) => collectTopicNames(record[key], names, false));
  }
}

async function suggestWeiboTopics(keyword: string, accountId: number | null, db: AppDatabase): Promise<string[]> {
  const query = cleanTopicName(keyword);
  if (!query) {
    return [];
  }

  let cookieHeader = '';
  if (accountId) {
    try {
      cookieHeader = await cookieHeaderForAccount(db.getPartition(accountId));
    } catch {
      cookieHeader = '';
    }
  }

  const names = new Set<string>();
  const containerIds = [`100103type=1&q=${query}`, `100103type=98&q=${query}`];
  await Promise.all(
    containerIds.map(async (containerId) => {
      const data = await readJson(
        `https://m.weibo.cn/api/container/getIndex?containerid=${encodeURIComponent(containerId)}`,
        cookieHeader,
        'https://m.weibo.cn/'
      ).catch(() => null);
      collectTopicNames(data, names);
    })
  );

  for (const suffix of fallbackTopicSuffixes) {
    names.add(`${query}${suffix}`);
  }
  return Array.from(names)
    .filter((name) => name.includes(query))
    .slice(0, 12);
}

function waitForLoad(window: BrowserWindow, timeoutMs = 30000): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timeout);
      window.webContents.off('did-stop-loading', finish);
      window.webContents.off('did-fail-load', finish);
      resolve();
    };
    const timeout = setTimeout(finish, timeoutMs);
    window.webContents.once('did-stop-loading', finish);
    window.webContents.once('did-fail-load', finish);
  });
}

async function waitForComposer(window: BrowserWindow): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 45000) {
    const state = (await window.webContents.executeJavaScript(`
      (() => {
        const text = (value) => (value || '').replace(/\\s+/g, ' ').trim();
        const loginVisible = Array.from(document.querySelectorAll('a, button, [role="button"]')).some((element) => {
          const rect = element.getBoundingClientRect();
          if (!rect.width || !rect.height) return false;
          const value = text(element.textContent || element.getAttribute('aria-label') || element.getAttribute('title') || '');
          const disabled = element.getAttribute('aria-disabled') === 'true' || element.getAttribute('disabled') !== null || /disabled/i.test(String(element.className || ''));
          if (disabled) return false;
          if (value === '\\u53d1\\u9001' || value === '\\u53d1\\u5e03' || value.includes('\\u53d1\\u9001') || value.includes('\\u53d1\\u5e03')) return true;
          return value === '登录' || value === '登录/注册';
        });
        const composer = document.querySelector('textarea[placeholder*="新鲜事"], textarea[placeholder*="分享"], textarea');
        const editable = document.querySelector('[contenteditable="true"]');
        return { loginVisible, hasComposer: Boolean(composer || editable) };
      })()
    `)) as { loginVisible: boolean; hasComposer: boolean };
    if (state.loginVisible) {
      throw new Error('账号未登录，无法自动发帖');
    }
    if (state.hasComposer) {
      return;
    }
    await delay(900);
  }
  throw new Error('没有找到微博发帖输入框');
}

async function setUploadFiles(window: BrowserWindow, files: string[]): Promise<void> {
  if (!files.length) {
    return;
  }
  await window.webContents.executeJavaScript(`
    (() => {
      const text = (value) => (value || '').replace(/\\s+/g, ' ').trim();
      const imageButton = Array.from(document.querySelectorAll('button, [role="button"], a, div, span')).find((element) => {
        const rect = element.getBoundingClientRect();
        if (!rect.width || !rect.height) return false;
        return text(element.textContent || element.getAttribute('aria-label') || element.getAttribute('title') || '') === '图片';
      });
      imageButton?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    })()
  `);
  await delay(800);
  if (!window.webContents.debugger.isAttached()) {
    window.webContents.debugger.attach('1.3');
  }
  const evaluated = (await window.webContents.debugger.sendCommand('Runtime.evaluate', {
    expression: 'document.querySelector("input[type=file]")',
    objectGroup: 'weibo-upload'
  })) as { result?: { objectId?: string } };
  const objectId = evaluated.result?.objectId;
  if (!objectId) {
    throw new Error('没有找到图片上传控件');
  }
  const described = (await window.webContents.debugger.sendCommand('DOM.describeNode', { objectId })) as {
    node?: { backendNodeId?: number };
  };
  if (!described.node?.backendNodeId) {
    throw new Error('无法定位图片上传控件');
  }
  await window.webContents.debugger.sendCommand('DOM.setFileInputFiles', {
    backendNodeId: described.node.backendNodeId,
    files
  });
  await delay(Math.max(2500, files.length * 1200));
}

async function readLatestWeiboUrl(window: BrowserWindow, content = ''): Promise<string | null> {
  return window.webContents.executeJavaScript(`
    (() => {
      const targetContent = ${JSON.stringify(content)};
      const normalize = (value) => (value || '').replace(/\\s+/g, '').trim();
      const target = normalize(targetContent).slice(0, 36);
      const readUrls = (root) => Array.from(root.querySelectorAll('a[href]'))
        .map((anchor) => anchor.href || anchor.getAttribute('href') || '')
        .filter((href) => /weibo\\.com\\/\\d+\\/[A-Za-z0-9]+/.test(href) || /weibo\\.com\\/status\\//.test(href));
      if (target) {
        const cards = Array.from(document.querySelectorAll('article, main div, div'))
          .filter((element) => {
            const text = normalize(element.textContent || '');
            const rect = element.getBoundingClientRect();
            return rect.width > 260 && rect.height > 80 && text.includes(target);
          })
          .sort((a, b) => {
            const ar = a.getBoundingClientRect();
            const br = b.getBoundingClientRect();
            return ar.height * ar.width - br.height * br.width;
          });
        for (const card of cards) {
          const urls = readUrls(card);
          if (urls.length) return urls[0];
        }
      }
      const anchors = Array.from(document.querySelectorAll('a[href]'));
      const urls = anchors
        .map((anchor) => anchor.href || anchor.getAttribute('href') || '')
        .filter((href) => /weibo\\.com\\/\\d+\\/[A-Za-z0-9]+/.test(href) || /weibo\\.com\\/status\\//.test(href));
      return urls[0] || null;
    })()
  `) as Promise<string | null>;
}

async function submitCommentInWindow(window: BrowserWindow, content: string, replyToContent: string | null = null): Promise<void> {
  const ready = (await window.webContents.executeJavaScript(`
    (() => {
      const text = (value) => (value || '').replace(/\\s+/g, ' ').trim();
      const replyToContent = ${JSON.stringify(replyToContent)};
      if (replyToContent) {
        const visible = (element) => {
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          return rect.width && rect.height && style.display !== 'none' && style.visibility !== 'hidden';
        };
        const clickElement = (element) => {
          const rect = element.getBoundingClientRect();
          const options = { bubbles: true, cancelable: true, view: window, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
          element.dispatchEvent(new MouseEvent('mouseover', options));
          element.dispatchEvent(new MouseEvent('mousedown', options));
          element.dispatchEvent(new MouseEvent('mouseup', options));
          element.dispatchEvent(new MouseEvent('click', options));
        };
        const clickable = (element) => {
          const value = text(element.textContent || element.getAttribute('aria-label') || element.getAttribute('title') || '');
          return value === '回复' || value.includes('回复') || value === '评论' || value.includes('评论');
        };
        const candidates = Array.from(document.querySelectorAll('article, li, div'))
          .filter((element) => {
            if (!visible(element)) return false;
            const value = text(element.textContent || '');
            if (!value.includes(replyToContent)) return false;
            const rect = element.getBoundingClientRect();
            return rect.top > 80 && rect.height >= 32 && rect.height <= 220 && rect.width >= 260;
          })
          .sort((a, b) => {
            const ar = a.getBoundingClientRect();
            const br = b.getBoundingClientRect();
            return ar.height * ar.width - br.height * br.width;
          });
        for (const candidate of candidates) {
          candidate.scrollIntoView({ block: 'center', inline: 'nearest' });
          const row = candidate.getBoundingClientRect();
          const buttons = Array.from(candidate.querySelectorAll('button, [role="button"], a[href], [aria-label], [title]')).reverse();
          const replyButton = buttons.find((element) => {
            if (!visible(element)) return false;
            const rect = element.getBoundingClientRect();
            if (rect.left < row.left || rect.right > row.right + 2 || rect.top < row.top || rect.bottom > row.bottom + 2) return false;
            return clickable(element);
          });
          if (replyButton) {
            clickElement(replyButton);
            return true;
          }
          const probePoints = [
            [row.right - 70, row.bottom - 26],
            [row.right - 110, row.bottom - 26],
            [row.right - 70, row.top + row.height / 2]
          ];
          for (const [x, y] of probePoints) {
            const target = document.elementFromPoint(x, y)?.closest('button, [role="button"], a, div, span');
            if (target && candidate.contains(target)) {
              clickElement(target);
              return true;
            }
          }
        }
        const commentTextNode = Array.from(document.querySelectorAll('span, p, div'))
          .find((element) => visible(element) && text(element.textContent || '') === replyToContent);
        if (commentTextNode) {
          let node = commentTextNode.parentElement;
          for (let depth = 0; node && depth < 8; depth += 1, node = node.parentElement) {
            const buttons = Array.from(node.querySelectorAll('button, [role="button"], a[href], [aria-label], [title]')).reverse();
            const replyButton = buttons.find((element) => visible(element) && clickable(element));
            if (replyButton) {
              clickElement(replyButton);
              return true;
            }
          }
        }
        return false;
        for (const candidate of candidates) {
          candidate.scrollIntoView({ block: 'center', inline: 'nearest' });
          const buttons = Array.from(candidate.querySelectorAll('button, [role="button"], a[href], [aria-label], [title]')).reverse();
          const replyButton = buttons.find((element) => {
            if (!visible(element)) return false;
            const value = text(element.textContent || element.getAttribute('aria-label') || element.getAttribute('title') || '');
            return value === '回复' || value === '评论' || value.includes('回复');
          });
          if (replyButton) {
            replyButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
            return true;
          }
        }
        return false;
      }
      const buttons = Array.from(document.querySelectorAll('button, [role="button"], a, div, span'));
      const commentButton = buttons.find((element) => {
        const rect = element.getBoundingClientRect();
        if (!rect.width || !rect.height) return false;
        const value = text(element.textContent || element.getAttribute('aria-label') || element.getAttribute('title') || '');
        return value === '评论' || value.includes('评论');
      });
      commentButton?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return Boolean(commentButton);
    })()
  `)) as boolean;
  await delay(1200);
  if (replyToContent && !ready) {
    throw new Error('没有找到目标评论的回复入口，已停止，避免发成一级评论');
  }
  const wrote = (await window.webContents.executeJavaScript(`
    (() => {
      const content = ${JSON.stringify(content)};
      const replyToContent = ${JSON.stringify(replyToContent)};
      const isVisible = (element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width && rect.height && style.display !== 'none' && style.visibility !== 'hidden';
      };
      if (replyToContent) {
        const active = document.activeElement;
        if (active instanceof HTMLTextAreaElement && isVisible(active)) {
          const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
          setter?.call(active, content);
          active.focus();
          active.dispatchEvent(new Event('input', { bubbles: true }));
          active.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
        if (active instanceof HTMLElement && active.isContentEditable && isVisible(active)) {
          active.focus();
          active.textContent = content;
          active.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: content }));
          return true;
        }
        const focusedInput = Array.from(document.querySelectorAll('textarea, [contenteditable="true"]'))
          .reverse()
          .find((element) => {
            if (!isVisible(element)) return false;
            const placeholder = element.getAttribute('placeholder') || '';
            const aria = element.getAttribute('aria-label') || '';
            return /回复|鍥炲/i.test(placeholder + aria);
          });
        if (!focusedInput) {
          return false;
        }
        if (focusedInput instanceof HTMLTextAreaElement) {
          const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
          setter?.call(focusedInput, content);
          focusedInput.focus();
          focusedInput.dispatchEvent(new Event('input', { bubbles: true }));
          focusedInput.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
        if (focusedInput instanceof HTMLElement) {
          focusedInput.focus();
          focusedInput.textContent = content;
          focusedInput.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: content }));
          return true;
        }
        return false;
      }
      const textareas = Array.from(document.querySelectorAll('textarea'));
      const textarea = textareas.reverse().find((element) => {
        const rect = element.getBoundingClientRect();
        const placeholder = element.getAttribute('placeholder') || '';
        return rect.width && rect.height && (/评论|回复|说点什么/.test(placeholder) || textareas.length === 1);
      });
      if (textarea) {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        setter?.call(textarea, content);
        textarea.focus();
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
      const editables = Array.from(document.querySelectorAll('[contenteditable="true"]'));
      const editable = editables.reverse().find((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width && rect.height;
      });
      if (editable) {
        editable.focus();
        editable.textContent = content;
        editable.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: content }));
        return true;
      }
      return false;
    })()
  `)) as boolean;
  if (!wrote) {
    throw new Error(ready ? '没有找到评论输入框' : '没有找到评论入口');
  }
  await delay(1000);
  const clicked = (await window.webContents.executeJavaScript(`
    (() => {
      const text = (value) => (value || '').replace(/\\s+/g, ' ').trim();
      const replyToContent = ${JSON.stringify(replyToContent)};
      const isSubmit = (element) => {
        const value = text(element.textContent || element.getAttribute('aria-label') || element.getAttribute('title') || '');
        return value === '评论' || value === '发送' || value === '回复' || value === '璇勮' || value === '鍙戦€?' || value === '鍥炲';
      };
      const clickElement = (element) => {
        const rect = element.getBoundingClientRect();
        const options = { bubbles: true, cancelable: true, view: window, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
        element.dispatchEvent(new MouseEvent('mousedown', options));
        element.dispatchEvent(new MouseEvent('mouseup', options));
        element.dispatchEvent(new MouseEvent('click', options));
      };
      if (replyToContent) {
        const input = document.activeElement;
        if (!(input instanceof HTMLElement)) return false;
        let node = input.parentElement;
        for (let depth = 0; node && depth < 8; depth += 1, node = node.parentElement) {
          const buttons = Array.from(node.querySelectorAll('button, [role="button"], a, div')).reverse();
          const submit = buttons.find((element) => {
            const rect = element.getBoundingClientRect();
            return rect.width && rect.height && isSubmit(element);
          });
          if (submit) {
            clickElement(submit);
            return true;
          }
        }
        return false;
      }
      const candidates = Array.from(document.querySelectorAll('button, [role="button"], a, div')).reverse();
      const submit = candidates.find((element) => {
        const rect = element.getBoundingClientRect();
        if (!rect.width || !rect.height) return false;
        return isSubmit(element);
      });
      if (!submit) return false;
      clickElement(submit);
      return true;
    })()
  `)) as boolean;
  if (!clicked) {
    throw new Error('没有找到评论提交按钮');
  }
  await delay(3500);
}

async function submitCommentInWindowV2(window: BrowserWindow, content: string, replyToContent: string | null = null): Promise<void> {
  const ready = (await window.webContents.executeJavaScript(`
    (() => {
      const text = (value) => (value || '').replace(/\\s+/g, ' ').trim();
      const compact = (value) => text(value)
        .replace(/[\\u200b-\\u200f\\ufeff]/g, '')
        .replace(/[🔗]/g, '')
        .replace(/\\s+/g, '')
        .trim();
      const replyToContent = ${JSON.stringify(replyToContent)};
      const visible = (element) => {
        if (!element || !(element instanceof Element)) return false;
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const realTarget = (element) => element?.closest?.('button, [role="button"], a[href], div, span') || element;
      const clickElement = (element) => {
        const target = realTarget(element);
        if (!target || !visible(target)) return false;
        const rect = target.getBoundingClientRect();
        const options = { bubbles: true, cancelable: true, view: window, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
        target.dispatchEvent(new MouseEvent('mouseover', options));
        target.dispatchEvent(new MouseEvent('mousedown', options));
        target.dispatchEvent(new MouseEvent('mouseup', options));
        target.dispatchEvent(new MouseEvent('click', options));
        return true;
      };
      const clickPoint = (x, y) => {
        const target = document.elementFromPoint(x, y)?.closest('button, [role="button"], a, div, span, svg, use');
        if (!target || !visible(target)) return false;
        const options = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
        target.dispatchEvent(new MouseEvent('mouseover', options));
        target.dispatchEvent(new MouseEvent('mousedown', options));
        target.dispatchEvent(new MouseEvent('mouseup', options));
        target.dispatchEvent(new MouseEvent('click', options));
        return true;
      };
      const labelOf = (element) => text(element.textContent || element.getAttribute('aria-label') || element.getAttribute('title') || '');
      const isCommentAction = (element) => {
        const value = labelOf(element);
        return value === '\\u56de\\u590d' || value.includes('\\u56de\\u590d') || value === '\\u8bc4\\u8bba' || value.includes('\\u8bc4\\u8bba');
      };
      const hasPrimaryEditor = () => Array.from(document.querySelectorAll('textarea, [contenteditable="true"]'))
        .some((element) => {
          if (!visible(element)) return false;
          const placeholder = element.getAttribute('placeholder') || '';
          const aria = element.getAttribute('aria-label') || '';
          const rect = element.getBoundingClientRect();
          const actionRows = Array.from(document.querySelectorAll('div, footer, section'))
            .filter((rowElement) => {
              if (!visible(rowElement)) return false;
              const value = text(rowElement.textContent || '');
              const row = rowElement.getBoundingClientRect();
              return value.includes('\\u8f6c\\u53d1') &&
                value.includes('\\u8bc4\\u8bba') &&
                (value.includes('\\u8d5e') || value.includes('\\u5206\\u4eab') || /\\b\\d+\\b/.test(value)) &&
                row.top > 180 &&
                row.bottom < rect.top + 12 &&
                rect.top <= row.bottom + 180 &&
                rect.left >= row.left - 80 &&
                rect.right <= row.right + 80;
            });
          return actionRows.length > 0 &&
            (/\\u8bc4\\u8bba|\\u56de\\u590d|\\u8bf4\\u70b9\\u4ec0\\u4e48/.test(placeholder + aria) ||
            text(element.textContent || '').includes('\\u53d1\\u5e03\\u4f60\\u7684\\u8bc4\\u8bba'));
        });
      const clickableSelector = 'button, [role="button"], a[href], [aria-label], [title], svg, use, div, span';
      if (replyToContent) {
        const rawTarget = text(replyToContent);
        const variants = Array.from(new Set([
          rawTarget,
          rawTarget.replace(/https?:\\/\\/\\S+/ig, '\\u7f51\\u9875\\u94fe\\u63a5'),
          rawTarget.replace(/https?:\\/\\/\\S+/ig, ''),
          rawTarget.replace(/[🔗]/g, ''),
          rawTarget.replace(/[DK]:\\s*/i, '').replace(/https?:\\/\\/\\S+/ig, '\\u7f51\\u9875\\u94fe\\u63a5'),
          rawTarget.match(/^[DK]:/i) ? rawTarget.slice(0, 2) + '\\u7f51\\u9875\\u94fe\\u63a5' : ''
        ].filter(Boolean))).map(compact).filter((value) => value.length >= 2);
        const matchesTarget = (value) => {
          const normalized = compact(value);
          if (!normalized) return false;
          return variants.some((variant) => normalized.includes(variant) || variant.includes(normalized));
        };
        const candidates = Array.from(document.querySelectorAll('article, li, div'))
          .filter((element) => {
            if (!visible(element) || !matchesTarget(element.textContent || '')) return false;
            const rect = element.getBoundingClientRect();
            return rect.top > 70 && rect.bottom < window.innerHeight + 120 && rect.height >= 28 && rect.height <= 260 && rect.width >= 240;
          })
          .sort((a, b) => {
            const ar = a.getBoundingClientRect();
            const br = b.getBoundingClientRect();
            return ar.height * ar.width - br.height * br.width;
          });
        const clickReplyInRow = (candidate) => {
          candidate.scrollIntoView({ block: 'center', inline: 'nearest' });
          const row = candidate.getBoundingClientRect();
          const labelled = Array.from(candidate.querySelectorAll(clickableSelector)).reverse().find((element) => {
            if (!visible(element) || !isCommentAction(element)) return false;
            const rect = element.getBoundingClientRect();
            return rect.left >= row.left - 2 && rect.right <= row.right + 8 && rect.top >= row.top - 8 && rect.bottom <= row.bottom + 28;
          });
          if (labelled) return clickElement(labelled);
          const globalActions = Array.from(document.querySelectorAll(clickableSelector))
            .filter((element) => {
              if (!visible(element)) return false;
              const rect = element.getBoundingClientRect();
              const centerY = rect.top + rect.height / 2;
              const centerX = rect.left + rect.width / 2;
              return centerY >= row.top - 8 && centerY <= row.bottom + 28 && centerX > row.left + Math.min(260, row.width * 0.55) && centerX < row.right + 16 && rect.width <= 80 && rect.height <= 80;
            });
          if (globalActions.length) {
            const sortedRight = [...globalActions].sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left);
            return clickElement(sortedRight[1] || sortedRight[0]);
          }
          const probePoints = [
            [row.right - 70, row.top + row.height / 2],
            [row.right - 70, row.bottom - 24],
            [row.right - 110, row.top + row.height / 2],
            [row.right - 110, row.bottom - 24]
          ];
          for (const [x, y] of probePoints) {
            const target = document.elementFromPoint(x, y)?.closest(clickableSelector);
            if (target && clickElement(target)) return true;
          }
          return false;
        };
        for (const candidate of candidates) {
          if (clickReplyInRow(candidate)) return true;
        }
        return false;
      }
      if (hasPrimaryEditor()) return true;
      const buttons = Array.from(document.querySelectorAll('button, [role="button"], a, div, span'));
      const commentButton = buttons.find((element) => visible(element) && isCommentAction(element));
      return clickElement(commentButton);
    })()
  `)) as boolean;
  await delay(replyToContent ? 1800 : 1200);
  if (replyToContent && !ready) {
    throw new Error('没有找到目标评论的回复入口，已停止，避免发成一级评论');
  }

  const wrote = (await window.webContents.executeJavaScript(`
    (() => {
      const content = ${JSON.stringify(content)};
      const replyToContent = ${JSON.stringify(replyToContent)};
      const isVisible = (element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width && rect.height && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const findPrimaryCommentInput = () => {
        const rows = Array.from(document.querySelectorAll('div, footer, section'))
          .filter((rowElement) => {
            if (!isVisible(rowElement)) return false;
            const value = (rowElement.textContent || '').replace(/\\s+/g, ' ').trim();
            const row = rowElement.getBoundingClientRect();
            return value.includes('\\u8f6c\\u53d1') &&
              value.includes('\\u8bc4\\u8bba') &&
              (value.includes('\\u8d5e') || value.includes('\\u5206\\u4eab') || /\\b\\d+\\b/.test(value)) &&
              row.top > 180 &&
              row.top < Math.min(window.innerHeight * 0.72, 620) &&
              row.width >= 520 &&
              row.height >= 34 &&
              row.height <= 96;
          })
          .sort((a, b) => {
            const ar = a.getBoundingClientRect();
            const br = b.getBoundingClientRect();
            return ar.height * ar.width - br.height * br.width;
          });
        for (const rowElement of rows) {
          const row = rowElement.getBoundingClientRect();
          const input = Array.from(document.querySelectorAll('textarea, [contenteditable="true"]'))
            .find((element) => {
              if (!isVisible(element)) return false;
              const rect = element.getBoundingClientRect();
              const placeholder = element.getAttribute('placeholder') || '';
              const aria = element.getAttribute('aria-label') || '';
              return rect.top >= row.bottom - 8 &&
                rect.top <= row.bottom + 180 &&
                rect.left >= row.left - 80 &&
                rect.right <= row.right + 80 &&
                (/\\u8bc4\\u8bba|\\u56de\\u590d|\\u8bf4\\u70b9\\u4ec0\\u4e48/.test(placeholder + aria) || document.querySelectorAll('textarea').length === 1);
            });
          if (input) return input;
        }
        return null;
      };
      const writeInput = (input) => {
        if (input instanceof HTMLTextAreaElement) {
          const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
          setter?.call(input, content);
          input.focus();
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
        if (input instanceof HTMLElement) {
          input.focus();
          const selection = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(input);
          range.deleteContents();
          selection?.removeAllRanges();
          selection?.addRange(range);
          document.execCommand('insertText', false, content);
          if (!text(input.textContent || '').includes(content)) {
            input.textContent = content;
          }
          input.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: content }));
          input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: content }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
        return false;
      };
      if (replyToContent) {
        const active = document.activeElement;
        if ((active instanceof HTMLTextAreaElement || active?.isContentEditable) && isVisible(active)) {
          return writeInput(active);
        }
        const focusedInput = Array.from(document.querySelectorAll('textarea, [contenteditable="true"]'))
          .reverse()
          .find((element) => {
            if (!isVisible(element)) return false;
            const placeholder = element.getAttribute('placeholder') || '';
            const aria = element.getAttribute('aria-label') || '';
            return /\\u56de\\u590d|\\u8bc4\\u8bba/.test(placeholder + aria);
          });
        return writeInput(focusedInput);
      }
      const input = findPrimaryCommentInput() || Array.from(document.querySelectorAll('textarea, [contenteditable="true"]'))
        .reverse()
        .find((element) => {
          if (!isVisible(element)) return false;
          const placeholder = element.getAttribute('placeholder') || '';
          const rect = element.getBoundingClientRect();
          return rect.top > 260 && (/\\u8bc4\\u8bba|\\u56de\\u590d|\\u8bf4\\u70b9\\u4ec0\\u4e48/.test(placeholder) || document.querySelectorAll('textarea').length === 1);
        });
      return writeInput(input);
    })()
  `)) as boolean;
  if (!wrote) {
    throw new Error(ready ? '没有找到评论输入框' : '没有找到评论入口');
  }

  await delay(1000);
  const clicked = (await window.webContents.executeJavaScript(`
    (() => {
      const text = (value) => (value || '').replace(/\\s+/g, ' ').trim();
      const replyToContent = ${JSON.stringify(replyToContent)};
      const isSubmit = (element) => {
        const value = text(element.textContent || element.getAttribute('aria-label') || element.getAttribute('title') || '');
        return value === '\\u8bc4\\u8bba' || value === '\\u53d1\\u9001' || value === '\\u56de\\u590d' || value.includes('\\u8bc4\\u8bba') || value.includes('\\u53d1\\u9001') || value.includes('\\u56de\\u590d');
      };
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width && rect.height && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const clickElement = (element) => {
        const target = element?.closest?.('button, [role="button"], a, div, span') || element;
        if (!target || !visible(target)) return false;
        const rect = target.getBoundingClientRect();
        const options = { bubbles: true, cancelable: true, view: window, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
        target.dispatchEvent(new MouseEvent('mouseover', options));
        target.dispatchEvent(new MouseEvent('mousedown', options));
        target.dispatchEvent(new MouseEvent('mouseup', options));
        target.dispatchEvent(new MouseEvent('click', options));
        return true;
      };
      const clickPoint = (x, y) => {
        const target = document.elementFromPoint(x, y)?.closest('button, [role="button"], a, div, span');
        if (!target || !visible(target)) return false;
        const options = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
        target.dispatchEvent(new MouseEvent('mouseover', options));
        target.dispatchEvent(new MouseEvent('mousedown', options));
        target.dispatchEvent(new MouseEvent('mouseup', options));
        target.dispatchEvent(new MouseEvent('click', options));
        return true;
      };
      const findPrimaryCommentInput = () => {
        const rows = Array.from(document.querySelectorAll('div, footer, section'))
          .filter((rowElement) => {
            if (!visible(rowElement)) return false;
            const value = text(rowElement.textContent || '');
            const row = rowElement.getBoundingClientRect();
            return value.includes('\\u8f6c\\u53d1') &&
              value.includes('\\u8bc4\\u8bba') &&
              (value.includes('\\u8d5e') || value.includes('\\u5206\\u4eab') || /\\b\\d+\\b/.test(value)) &&
              row.top > 180 &&
              row.top < Math.min(window.innerHeight * 0.72, 620) &&
              row.width >= 520 &&
              row.height >= 34 &&
              row.height <= 96;
          })
          .sort((a, b) => {
            const ar = a.getBoundingClientRect();
            const br = b.getBoundingClientRect();
            return ar.height * ar.width - br.height * br.width;
          });
        for (const rowElement of rows) {
          const row = rowElement.getBoundingClientRect();
          const input = Array.from(document.querySelectorAll('textarea, [contenteditable="true"]'))
            .find((element) => {
              if (!visible(element)) return false;
              const rect = element.getBoundingClientRect();
              return rect.top >= row.bottom - 8 &&
                rect.top <= row.bottom + 180 &&
                rect.left >= row.left - 80 &&
                rect.right <= row.right + 80;
            });
          if (input) return input;
        }
        return null;
      };
      const detailInput = findPrimaryCommentInput();
      const activeInput = !replyToContent && detailInput
        ? detailInput
        : document.activeElement instanceof HTMLElement && visible(document.activeElement)
          ? document.activeElement
          : Array.from(document.querySelectorAll('textarea, [contenteditable="true"]')).reverse().find((element) => visible(element));
      const clickNearestSubmit = () => {
        if (!(activeInput instanceof HTMLElement)) return false;
        const inputRect = activeInput.getBoundingClientRect();
        let node = activeInput.parentElement;
        for (let depth = 0; node && depth < 9; depth += 1, node = node.parentElement) {
          const containerRect = node.getBoundingClientRect();
          const buttons = Array.from(node.querySelectorAll('button, [role="button"], a, div, span')).reverse();
          const submit = buttons.find((element) => {
            if (!visible(element) || !isSubmit(element)) return false;
            const rect = element.getBoundingClientRect();
            return rect.left >= inputRect.left &&
              rect.right <= containerRect.right + 8 &&
              rect.top >= inputRect.top - 8 &&
              rect.top <= inputRect.bottom + 96 &&
              rect.width >= 34 &&
              rect.height >= 24;
          });
          if (submit && clickElement(submit)) return true;
        }
        const points = [
          [Math.min(inputRect.right - 44, window.innerWidth - 64), inputRect.bottom + 40],
          [Math.min(inputRect.right - 64, window.innerWidth - 84), inputRect.bottom + 40],
          [Math.min(inputRect.right - 44, window.innerWidth - 64), inputRect.bottom + 28]
        ];
        for (const [x, y] of points) {
          if (clickPoint(x, y)) return true;
        }
        return false;
      };
      if (replyToContent) {
        const input = activeInput;
        if (!(input instanceof HTMLElement)) return false;
        let node = input.parentElement;
        for (let depth = 0; node && depth < 9; depth += 1, node = node.parentElement) {
          const buttons = Array.from(node.querySelectorAll('button, [role="button"], a, div')).reverse();
          const submit = buttons.find((element) => visible(element) && isSubmit(element));
          if (submit) {
            clickElement(submit);
            return true;
          }
        }
        return false;
      }
      if (clickNearestSubmit()) return true;
      const candidates = Array.from(document.querySelectorAll('button, [role="button"], a, div')).reverse();
      const submit = candidates.find((element) => visible(element) && isSubmit(element));
      if (!submit) return false;
      return clickElement(submit);
    })()
  `)) as boolean;
  if (!clicked) {
    throw new Error('没有找到评论提交按钮');
  }
  await delay(3500);
}

async function likeWeiboInWindow(window: BrowserWindow, content = ''): Promise<boolean> {
  return (await window.webContents.executeJavaScript(`
    (async () => {
      const targetContent = ${JSON.stringify(content)};
      const text = (value) => (value || '').replace(/\\s+/g, ' ').trim();
      const compact = (value) => text(value).replace(/\\s+/g, '').trim();
      const visible = (element) => {
        if (!element || !(element instanceof Element)) return false;
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const labelOf = (element) => text(element.textContent || element.getAttribute('aria-label') || element.getAttribute('title') || '');
      const elementText = (element) => text(element.textContent || element.getAttribute('aria-label') || element.getAttribute('title') || element.innerHTML || '');
      const looksLiked = (element) => {
        const value = labelOf(element);
        const ariaPressed = element.getAttribute('aria-pressed');
        const ariaChecked = element.getAttribute('aria-checked');
        const className = String(element.className || '');
        return value.includes('\\u5df2\\u8d5e') ||
          value.includes('\\u53d6\\u6d88\\u8d5e') ||
          ariaPressed === 'true' ||
          ariaChecked === 'true' ||
          /liked|active|selected/i.test(className);
      };
      const isLikeAction = (element) => {
        const value = elementText(element);
        if (value.includes('\\u8bc4\\u8bba') || value.includes('\\u8f6c\\u53d1') || value.includes('\\u9605\\u8bfb')) return false;
        if (value === '\\u8d5e' || value.includes('\\u8d5e')) return true;
        return /woo-font--like|icon_like|like/i.test(value);
      };
      const clickElement = (element) => {
        const target = element.closest?.('button, [role="button"], a, div, span') || element;
        if (!visible(target) || looksLiked(target) || isOrangeLike(target)) return false;
        const rect = target.getBoundingClientRect();
        const options = { bubbles: true, cancelable: true, view: window, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
        target.dispatchEvent(new MouseEvent('mouseover', options));
        target.dispatchEvent(new MouseEvent('mousedown', options));
        target.dispatchEvent(new MouseEvent('mouseup', options));
        target.dispatchEvent(new MouseEvent('click', options));
        return true;
      };
      const clickPoint = (x, y) => {
        const target = document.elementFromPoint(x, y)?.closest('button, [role="button"], a, div, span, svg, use');
        if (!target || !visible(target) || looksLiked(target) || isOrangeLike(target)) return false;
        const options = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
        target.dispatchEvent(new MouseEvent('mouseover', options));
        target.dispatchEvent(new MouseEvent('mousedown', options));
        target.dispatchEvent(new MouseEvent('mouseup', options));
        target.dispatchEvent(new MouseEvent('click', options));
        return true;
      };
      const isOrangeLike = (element) => {
        const style = window.getComputedStyle(element);
        const colorText = [style.color, style.fill, style.stroke].join(' ');
        const className = String(element.className || '');
        return /orange|liked|active|selected/i.test(className) ||
          /255,\\s*(130|131|132|133|134|135|136|137|138|139|140|141|142|143|144|145|146|147|148|149|150)/.test(colorText) ||
          /#ff/i.test(colorText);
      };
      const didLike = (root) => Array.from(root.querySelectorAll('*')).some((element) => visible(element) && isOrangeLike(element));
      const clickPrecise = async (element, root) => {
        const targets = [
          element,
          element.querySelector?.('svg'),
          element.querySelector?.('use'),
          ...Array.from(element.querySelectorAll?.('i, svg, use, span') || [])
        ].filter(Boolean);
        for (const target of targets) {
          if (!clickElement(target)) continue;
          await new Promise((resolve) => setTimeout(resolve, 700));
          if (didLike(root)) return true;
        }
        return false;
      };
      window.scrollTo({ top: 0, behavior: 'instant' });
      await new Promise((resolve) => setTimeout(resolve, 300));
      const detailActionRows = Array.from(document.querySelectorAll('div, footer, section'))
        .filter((element) => {
          if (!visible(element)) return false;
          const value = text(element.textContent || '');
          const rect = element.getBoundingClientRect();
          return value.includes('\\u8f6c\\u53d1') &&
            value.includes('\\u8bc4\\u8bba') &&
            value.includes('\\u8d5e') &&
            !value.includes('\\u53d1\\u5e03\\u4f60\\u7684\\u8bc4\\u8bba') &&
            rect.top > 260 &&
            rect.top < Math.min(window.innerHeight * 0.7, 560) &&
            rect.width >= 520 &&
            rect.height >= 34 &&
            rect.height <= 92;
        })
        .sort((a, b) => {
          const ar = a.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          return ar.height * ar.width - br.height * br.width;
        });
      for (const rowElement of detailActionRows) {
        const likeActions = Array.from(rowElement.querySelectorAll('button, [role="button"], a, div, span, svg, use'))
          .filter((element) => visible(element) && isLikeAction(element) && !looksLiked(element) && !isOrangeLike(element))
          .sort((a, b) => {
            const ar = a.getBoundingClientRect();
            const br = b.getBoundingClientRect();
            return ar.width * ar.height - br.width * br.height || ar.left - br.left;
          });
        for (const action of likeActions) {
          if (await clickPrecise(action, rowElement)) return true;
        }
        const row = rowElement.getBoundingClientRect();
        const fallbackPoints = [
          [row.left + row.width * 0.50, row.top + row.height / 2],
          [row.left + row.width * 0.53, row.top + row.height / 2],
          [row.left + row.width * 0.56, row.top + row.height / 2]
        ];
        for (const [x, y] of fallbackPoints) {
          if (clickPoint(x, y)) {
            await new Promise((resolve) => setTimeout(resolve, 900));
            if (didLike(rowElement)) return true;
          }
        }
      }
      const postCards = Array.from(document.querySelectorAll('article, main > div, div'))
        .filter((element) => {
          if (!visible(element)) return false;
          const value = text(element.textContent || '');
          const target = compact(targetContent).slice(0, 36);
          const rect = element.getBoundingClientRect();
          if (target && !compact(value).includes(target)) return false;
          return value.includes('\\u8f6c\\u53d1') &&
            value.includes('\\u8bc4\\u8bba') &&
            rect.top >= 0 &&
            rect.top < Math.min(window.innerHeight * 0.55, 420) &&
            rect.width >= 420 &&
            rect.height >= 120 &&
            rect.height <= Math.max(window.innerHeight * 0.9, 520);
        })
        .sort((a, b) => {
          const ar = a.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          return ar.height * ar.width - br.height * br.width;
        });
      for (const card of postCards) {
        const cardRect = card.getBoundingClientRect();
        const actionTexts = Array.from(card.querySelectorAll('div, footer, section'))
          .filter((element) => {
            if (!visible(element)) return false;
            const value = text(element.textContent || '');
            const rect = element.getBoundingClientRect();
            return value.includes('\\u8f6c\\u53d1') &&
              value.includes('\\u8bc4\\u8bba') &&
              rect.top > cardRect.top + cardRect.height * 0.35 &&
              rect.bottom <= cardRect.bottom + 12 &&
              rect.width >= cardRect.width * 0.55 &&
              rect.height >= 28 &&
              rect.height <= 100;
          })
          .sort((a, b) => {
            const ar = a.getBoundingClientRect();
            const br = b.getBoundingClientRect();
            return ar.height * ar.width - br.height * br.width;
          });
        for (const rowElement of actionTexts) {
          const row = rowElement.getBoundingClientRect();
          const commentNodes = Array.from(rowElement.querySelectorAll('button, [role="button"], a, div, span, svg, use'))
            .filter((element) => visible(element) && text(element.textContent || element.getAttribute('aria-label') || element.getAttribute('title') || '').includes('\\u8bc4\\u8bba'))
            .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
          const commentRect = commentNodes[0]?.getBoundingClientRect();
          const y = commentRect ? commentRect.top + commentRect.height / 2 : row.top + row.height / 2;
          const xFromComment = commentRect ? commentRect.right + Math.min(180, row.width * 0.22) : row.left + row.width * 0.55;
          const points = [
            [xFromComment, y],
            [row.left + row.width * 0.56, y],
            [row.left + row.width * 0.60, y],
            [row.left + row.width * 0.64, y]
          ];
          for (const [x, yPoint] of points) {
            if (x > row.left && x < row.right && clickPoint(x, yPoint)) {
              await new Promise((resolve) => setTimeout(resolve, 900));
              if (didLike(rowElement)) return true;
            }
          }
        }
        const actionRows = Array.from(card.querySelectorAll('div, footer, section'))
          .filter((element) => {
            if (!visible(element)) return false;
            const value = text(element.textContent || '');
            const rect = element.getBoundingClientRect();
            return value.includes('\\u8f6c\\u53d1') &&
              value.includes('\\u8bc4\\u8bba') &&
              rect.top > cardRect.top + cardRect.height * 0.45 &&
              rect.bottom <= cardRect.bottom + 4 &&
              rect.width >= cardRect.width * 0.5 &&
              rect.height >= 28 &&
              rect.height <= 90;
          })
          .sort((a, b) => {
            const ar = a.getBoundingClientRect();
            const br = b.getBoundingClientRect();
            return ar.height * ar.width - br.height * br.width;
          });
        for (const rowElement of actionRows) {
          const row = rowElement.getBoundingClientRect();
          const thirds = Array.from(rowElement.children).filter((element) => visible(element));
          const rightChild = thirds.length >= 3 ? thirds[thirds.length - 1] : null;
          if (rightChild && await clickPrecise(rightChild, rowElement)) return true;
          const target = document.elementFromPoint(row.left + row.width * 0.84, row.top + row.height / 2)?.closest('button, [role="button"], a, div, span, svg, use');
          if (target && rowElement.contains(target) && await clickPrecise(target, rowElement)) return true;
        }
        const actions = Array.from(card.querySelectorAll('button, [role="button"], a, div, span, svg, use'))
          .filter((element) => {
            if (!visible(element) || looksLiked(element)) return false;
            const rect = element.getBoundingClientRect();
            const centerX = rect.left + rect.width / 2;
            const centerY = rect.top + rect.height / 2;
            return centerY > cardRect.top + cardRect.height * 0.45 &&
              centerY < cardRect.bottom - 4 &&
              centerX > cardRect.left + cardRect.width * 0.62 &&
              centerX < cardRect.right - 4 &&
              rect.width <= 160 &&
              rect.height <= 80;
          })
          .sort((a, b) => {
            const ar = a.getBoundingClientRect();
            const br = b.getBoundingClientRect();
            return br.left - ar.left || br.top - ar.top;
          });
        for (const action of actions) {
          if ((isLikeAction(action) || actions.indexOf(action) < 3) && await clickPrecise(action, card)) return true;
        }
        const probePoints = [
          [cardRect.left + cardRect.width * 0.82, cardRect.bottom - 34],
          [cardRect.left + cardRect.width * 0.84, cardRect.bottom - 28],
          [cardRect.right - 120, cardRect.bottom - 34]
        ];
        for (const [x, y] of probePoints) {
          const target = document.elementFromPoint(x, y)?.closest('button, [role="button"], a, div, span, svg, use');
          if (target && card.contains(target) && await clickPrecise(target, card)) return true;
        }
      }
      return false;
    })()
  `)) as boolean;
}

async function likeFirstLevelCommentInWindow(window: BrowserWindow, commentContent: string): Promise<boolean> {
  return (await window.webContents.executeJavaScript(`
    (() => {
      const targetContent = ${JSON.stringify(commentContent)};
      const normalize = (value) => (value || '').replace(/\\s+/g, '').trim();
      const target = normalize(targetContent).slice(0, 36);
      if (!target) return false;
      const visible = (element) => {
        if (!element || !(element instanceof Element)) return false;
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const clickElement = (element) => {
        const targetElement = element.closest?.('button, [role="button"], a, div, span') || element;
        if (!visible(targetElement)) return false;
        const rect = targetElement.getBoundingClientRect();
        const options = { bubbles: true, cancelable: true, view: window, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
        targetElement.dispatchEvent(new MouseEvent('mouseover', options));
        targetElement.dispatchEvent(new MouseEvent('mousedown', options));
        targetElement.dispatchEvent(new MouseEvent('mouseup', options));
        targetElement.dispatchEvent(new MouseEvent('click', options));
        return true;
      };
      const textOf = (element) => normalize(element.textContent || element.getAttribute('aria-label') || element.getAttribute('title') || element.innerHTML || '');
      const rows = Array.from(document.querySelectorAll('article, li, div'))
        .filter((element) => {
          if (!visible(element)) return false;
          const text = normalize(element.textContent || '');
          const rect = element.getBoundingClientRect();
          return text.includes(target) && rect.top > 120 && rect.width >= 260 && rect.height >= 34 && rect.height <= 260;
        })
        .sort((a, b) => {
          const ar = a.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          return ar.height * ar.width - br.height * br.width;
        });
      for (const rowElement of rows) {
        rowElement.scrollIntoView({ block: 'center', inline: 'nearest' });
        const row = rowElement.getBoundingClientRect();
        const actions = Array.from(rowElement.querySelectorAll('button, [role="button"], a, div, span, svg, use'))
          .filter((element) => {
            if (!visible(element)) return false;
            const rect = element.getBoundingClientRect();
            const centerX = rect.left + rect.width / 2;
            const centerY = rect.top + rect.height / 2;
            const value = textOf(element);
            if (value.includes('\\u8bc4\\u8bba') || value.includes('\\u56de\\u590d') || value.includes('\\u5220\\u9664')) return false;
            return centerY >= row.top - 8 && centerY <= row.bottom + 28 && centerX > row.left + row.width * 0.58 && centerX < row.right + 12 && rect.width <= 90 && rect.height <= 80;
          })
          .sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left);
        for (const action of actions) {
          if (clickElement(action)) return true;
        }
      }
      return false;
    })()
  `)) as boolean;
}

async function openPrimaryCommentEditorInWindow(window: BrowserWindow): Promise<boolean> {
  return (await window.webContents.executeJavaScript(`
    (async () => {
      const text = (value) => (value || '').replace(/\\s+/g, ' ').trim();
      const visible = (element) => {
        if (!element || !(element instanceof Element)) return false;
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const hasEditor = () => Array.from(document.querySelectorAll('textarea, [contenteditable="true"]'))
        .some((element) => {
          if (!visible(element)) return false;
          const placeholder = element.getAttribute('placeholder') || '';
          const aria = element.getAttribute('aria-label') || '';
          return /\\u8bc4\\u8bba|\\u56de\\u590d|\\u8bf4\\u70b9\\u4ec0\\u4e48/.test(placeholder + aria) ||
            text(element.textContent || '').includes('\\u53d1\\u5e03\\u4f60\\u7684\\u8bc4\\u8bba');
        });
      if (hasEditor()) return true;
      const clickElement = (element) => {
        const target = element?.closest?.('button, [role="button"], a, div, span') || element;
        if (!target || !visible(target)) return false;
        const rect = target.getBoundingClientRect();
        const options = { bubbles: true, cancelable: true, view: window, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
        target.dispatchEvent(new MouseEvent('mouseover', options));
        target.dispatchEvent(new MouseEvent('mousedown', options));
        target.dispatchEvent(new MouseEvent('mouseup', options));
        target.dispatchEvent(new MouseEvent('click', options));
        return true;
      };
      const isCommentAction = (element) => {
        const value = text(element.textContent || element.getAttribute('aria-label') || element.getAttribute('title') || '');
        return value === '\\u8bc4\\u8bba' || value.includes('\\u8bc4\\u8bba');
      };
      const actionRows = Array.from(document.querySelectorAll('div, footer, section'))
        .filter((element) => {
          if (!visible(element)) return false;
          const value = text(element.textContent || '');
          const rect = element.getBoundingClientRect();
          return value.includes('\\u8f6c\\u53d1') &&
            value.includes('\\u8bc4\\u8bba') &&
            (value.includes('\\u8d5e') || value.includes('\\u5206\\u4eab') || /\\b\\d+\\b/.test(value)) &&
            rect.top > 220 &&
            rect.top < Math.min(window.innerHeight * 0.72, 600) &&
            rect.width >= 520 &&
            rect.height >= 34 &&
            rect.height <= 96;
        })
        .sort((a, b) => {
          const ar = a.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          return ar.height * ar.width - br.height * br.width;
        });
      for (const rowElement of actionRows) {
        const commentAction = Array.from(rowElement.querySelectorAll('button, [role="button"], a, div, span, svg, use'))
          .filter((element) => visible(element) && isCommentAction(element))
          .sort((a, b) => {
            const ar = a.getBoundingClientRect();
            const br = b.getBoundingClientRect();
            return ar.width * ar.height - br.width * br.height || ar.left - br.left;
          })[0];
        if (commentAction && clickElement(commentAction)) {
          await new Promise((resolve) => setTimeout(resolve, 1200));
          if (hasEditor()) return true;
        }
        const row = rowElement.getBoundingClientRect();
        const points = [
          [row.left + row.width * 0.30, row.top + row.height / 2],
          [row.left + row.width * 0.34, row.top + row.height / 2],
          [row.left + row.width * 0.38, row.top + row.height / 2]
        ];
        for (const [x, y] of points) {
          const target = document.elementFromPoint(x, y)?.closest('button, [role="button"], a, div, span, svg, use');
          if (target && rowElement.contains(target) && clickElement(target)) {
            await new Promise((resolve) => setTimeout(resolve, 1200));
            if (hasEditor()) return true;
          }
        }
      }
      return hasEditor();
    })()
  `)) as boolean;
}

async function commentInBrowser(payload: AutoCommentPayload, db: AppDatabase): Promise<AutoCommentResult> {
  const partition = db.getPartition(payload.accountId);
  const commentWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    show: true,
    title: '微博自动评论',
    webPreferences: {
      partition,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });
  try {
    if (payload.delaySeconds > 0) {
      await delay(payload.delaySeconds * 1000);
    }
    commentWindow.loadURL(payload.weiboUrl);
    await waitForLoad(commentWindow);
    await delay(2500);
    if (payload.replyToContent) {
      try {
        await submitCommentInWindowV2(commentWindow, payload.content, payload.replyToContent);
      } catch (error) {
        await submitCommentInWindow(commentWindow, payload.content, payload.replyToContent);
      }
    } else {
      await submitCommentInWindow(commentWindow, payload.content, null);
    }
    await delay(1200);
    return { taskId: payload.taskId, status: 'success', errorMessage: null };
  } catch (error) {
    return {
      taskId: payload.taskId,
      status: 'failed',
      errorMessage: error instanceof Error ? error.message : '自动评论失败'
    };
  } finally {
    if (!commentWindow.isDestroyed()) {
      commentWindow.close();
    }
  }
}

async function publishInBrowser(payload: AutoPublishPayload, db: AppDatabase): Promise<AutoPublishResult> {
  const partition = db.getPartition(payload.accountId);
  const postWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: true,
    title: '微博自动发帖',
    webPreferences: {
      partition,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });
  let shouldCloseWindow = true;
  try {
    postWindow.loadURL(WEIBO_HOME_URL);
    await waitForLoad(postWindow);
    await waitForComposer(postWindow);
    await postWindow.webContents.executeJavaScript(`
      (() => {
        const content = ${JSON.stringify(payload.content)};
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        const textarea = document.querySelector('textarea[placeholder*="新鲜事"], textarea[placeholder*="分享"], textarea');
        if (textarea) {
          setter?.call(textarea, content);
          textarea.focus();
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
          textarea.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
        const editable = document.querySelector('[contenteditable="true"]');
        if (editable) {
          editable.focus();
          editable.textContent = content;
          editable.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: content }));
          return true;
        }
        return false;
      })()
    `);
    await setUploadFiles(postWindow, payload.images);
    await delay(800);
    const clicked = (await postWindow.webContents.executeJavaScript(`
      (() => {
        const text = (value) => (value || '').replace(/\\s+/g, ' ').trim();
        const buttons = Array.from(document.querySelectorAll('button, [role="button"], a, div'));
        const sendButton = buttons.reverse().find((element) => {
          const rect = element.getBoundingClientRect();
          if (!rect.width || !rect.height) return false;
          const value = text(element.textContent || element.getAttribute('aria-label') || element.getAttribute('title') || '');
          return value === '发送' || value === '发布';
        });
        if (!sendButton) return false;
        const rect = sendButton.getBoundingClientRect();
        const options = { bubbles: true, cancelable: true, view: window, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
        sendButton.dispatchEvent(new MouseEvent('mousedown', options));
        sendButton.dispatchEvent(new MouseEvent('mouseup', options));
        sendButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        return true;
      })()
    `)) as boolean;
    if (!clicked) {
      throw new Error('没有找到发送按钮');
    }
    await delay(6000);
    if (payload.likeAfterPublish) {
      await likeWeiboInWindow(postWindow, payload.content).catch(() => false);
      await delay(1200);
    }
    const weiboUrl = (await readLatestWeiboUrl(postWindow, payload.content).catch(() => null)) || postWindow.webContents.getURL() || WEIBO_HOME_URL;
    return { taskId: payload.taskId, status: 'success', weiboUrl, errorMessage: null };
  } catch (error) {
    shouldCloseWindow = false;
    return {
      taskId: payload.taskId,
      status: 'failed',
      weiboUrl: null,
      errorMessage: error instanceof Error ? error.message : '自动发帖失败'
    };
  } finally {
    if (shouldCloseWindow && !postWindow.isDestroyed()) {
      postWindow.close();
    }
  }
}

async function autoPublishCommentTask(task: CommentTask, db: AppDatabase): Promise<AutoCommentResult> {
  if (!task.weibo_url) {
    db.failCommentTask({ taskId: task.id, errorMessage: '微博链接为空，不能执行评论' });
    return { taskId: task.id, status: 'failed', errorMessage: '微博链接为空，不能执行评论' };
  }
  const runningTask = task.status === 'running' ? task : db.startCommentTask(task.id);
  const result = await commentInBrowser(
    {
      taskId: runningTask.id,
      accountId: runningTask.account_id,
      weiboUrl: runningTask.weibo_url || '',
      content: runningTask.comment_content,
      delaySeconds: Number(runningTask.delay_seconds) || 0
    },
    db
  );
  let finalResult = result;
  if (result.status === 'success' && runningTask.reply_comment_content?.trim()) {
    const replyResult = await commentInBrowser(
      {
        taskId: runningTask.id,
        accountId: runningTask.reply_comment_account_id || runningTask.account_id,
        weiboUrl: runningTask.weibo_url || '',
        content: runningTask.reply_comment_content,
        delaySeconds: Number(runningTask.reply_comment_delay_seconds) || 0,
        replyToContent: runningTask.comment_content
      },
      db
    );
    finalResult = replyResult;
  }
  if (finalResult.status === 'success') {
    db.completeCommentTask({ taskId: runningTask.id });
  } else {
    db.failCommentTask({ taskId: runningTask.id, errorMessage: finalResult.errorMessage || '自动评论失败' });
  }
  return finalResult;
}

async function autoPublishPostTask(taskId: number, db: AppDatabase): Promise<AutoPublishResult> {
  if (runningAutoPostTaskIds.has(taskId)) {
    return { taskId, status: 'running', weiboUrl: null, errorMessage: null };
  }
  runningAutoPostTaskIds.add(taskId);
  try {
    const task = db.startPostTask(taskId);
    if (!task.account_id) {
      throw new Error('主任务不能直接执行');
    }
    const images = task.images ? (JSON.parse(task.images) as string[]) : [];
    const result = await publishInBrowser(
      {
        taskId,
        accountId: task.account_id,
        content: task.content,
        images,
        likeAfterPublish: Boolean(task.auto_comment_enabled && task.comment_content)
      },
      db
    );
    if (result.status === 'success' && result.weiboUrl) {
      db.completePostTask({ taskId, weiboUrl: result.weiboUrl });
      const commentTasks = db
        .listCommentTasks()
        .filter((commentTask) => commentTask.post_task_id === taskId && commentTask.status === 'pending');
      for (const commentTask of commentTasks) {
        await autoPublishCommentTask(commentTask, db);
      }
    } else {
      db.failPostTask({ taskId, errorMessage: result.errorMessage || '自动发帖失败' });
    }
    return result;
  } finally {
    runningAutoPostTaskIds.delete(taskId);
  }
}

function startScheduledPostRunner(db: AppDatabase, mainWindow: BrowserWindow): void {
  const runDueTasks = async (): Promise<void> => {
    const dueTasks = db.listDuePostTasks();
    for (const task of dueTasks) {
      if (mainWindow.isDestroyed()) {
        return;
      }
      try {
        await autoPublishPostTask(task.id, db);
        mainWindow.webContents.send('post:scheduled-task-updated', task.id);
      } catch {
        mainWindow.webContents.send('post:scheduled-task-updated', task.id);
      }
    }
  };
  const timer = setInterval(() => {
    void runDueTasks();
  }, 30000);
  mainWindow.on('closed', () => clearInterval(timer));
  void runDueTasks();
}

async function cookieHeaderForAccount(partition: string): Promise<string> {
  const accountSession = session.fromPartition(partition);
  const cookies = await accountSession.cookies.get({});
  return cookies
    .filter((cookie) => /(^|\.)weibo\.(com|cn)$/.test((cookie.domain || '').replace(/^\./, '')))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

async function hasAccountLoginCookie(partition: string): Promise<boolean> {
  const accountSession = session.fromPartition(partition);
  const cookies = await accountSession.cookies.get({});
  return cookies.some(
    (cookie) =>
      ['SUB', 'SUBP'].includes(cookie.name) &&
      Boolean(cookie.value) &&
      /(^|\.)weibo\.(com|cn)$/.test((cookie.domain || '').replace(/^\./, ''))
  );
}

async function hasBaiduPanLoginCookie(partition: string): Promise<boolean> {
  const accountSession = session.fromPartition(partition);
  const cookies = await accountSession.cookies.get({});
  return cookies.some(
    (cookie) =>
      ['BDUSS', 'STOKEN'].includes(cookie.name) &&
      Boolean(cookie.value) &&
      /(^|\.)baidu\.com$/.test((cookie.domain || '').replace(/^\./, ''))
  );
}

async function hasPlatformLoginCookie(partition: string, platform: AccountPlatform): Promise<boolean> {
  return platform === 'baidu_pan' ? hasBaiduPanLoginCookie(partition) : hasAccountLoginCookie(partition);
}

async function readProfileFromAccountSession(partition: string): Promise<WeiboLoginProfile | null> {
  if (!(await hasAccountLoginCookie(partition))) {
    return null;
  }
  const cookieHeader = await cookieHeaderForAccount(partition);
  if (!cookieHeader) {
    return null;
  }

  let profile: WeiboLoginProfile | null = null;
  const mobileConfig = (await readJson('https://m.weibo.cn/api/config', cookieHeader, 'https://m.weibo.cn/')) as
    | { data?: { uid?: string; login_uid?: string; user?: unknown; userInfo?: unknown } }
    | null;
  profile = mergeProfile(profile, normalizeProfileUser(mobileConfig?.data?.userInfo));
  profile = mergeProfile(profile, normalizeProfileUser(mobileConfig?.data?.user));
  if (mobileConfig?.data && !profile?.uid) {
    profile = mergeProfile(profile, {
      uid: text(mobileConfig.data.uid || mobileConfig.data.login_uid),
      nickname: '',
      avatar: ''
    });
  }

  const webConfig = (await readJson('https://weibo.com/ajax/config/get_config', cookieHeader, 'https://weibo.com/')) as
    | { data?: { uid?: string; login_uid?: string; user?: unknown; userInfo?: unknown } }
    | null;
  profile = mergeProfile(profile, normalizeProfileUser(webConfig?.data?.userInfo));
  profile = mergeProfile(profile, normalizeProfileUser(webConfig?.data?.user));
  if (webConfig?.data && !profile?.uid) {
    profile = mergeProfile(profile, {
      uid: text(webConfig.data.uid || webConfig.data.login_uid),
      nickname: '',
      avatar: ''
    });
  }

  if (profile?.uid && (!profile.nickname || !profile.avatar)) {
    const [webInfo, webDetail, mobileProfile] = await Promise.all([
      readJson(`https://weibo.com/ajax/profile/info?uid=${profile.uid}`, cookieHeader, 'https://weibo.com/').catch(() => null),
      readJson(`https://weibo.com/ajax/profile/detail?uid=${profile.uid}`, cookieHeader, 'https://weibo.com/').catch(() => null),
      readJson(
        `https://m.weibo.cn/api/container/getIndex?type=uid&value=${profile.uid}`,
        cookieHeader,
        'https://m.weibo.cn/'
      ).catch(() => null)
    ]);
    profile = mergeProfile(profile, normalizeProfileUser((webInfo as { data?: { user?: unknown } } | null)?.data?.user));
    profile = mergeProfile(profile, normalizeProfileUser((webDetail as { data?: { user?: unknown } } | null)?.data?.user));
    profile = mergeProfile(
      profile,
      normalizeProfileUser((mobileProfile as { data?: { userInfo?: unknown } } | null)?.data?.userInfo)
    );
  }

  if (!profile || (!profile.nickname && !profile.avatar)) {
    return null;
  }
  return profile;
}

async function readLoggedInWeiboProfile(window: BrowserWindow): Promise<WeiboLoginProfile | null> {
  try {
    const profile = (await window.webContents.executeJavaScript(`
      (() => {
        const text = (value) => (value || '').replace(/\\s+/g, ' ').trim();
        const normalizeUrl = (value) => text(value).replace(/\\\\\\//g, '/');
        const isVisible = (element) => {
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0.01;
        };
        const topAvatar = Array.from(document.images)
          .filter((img) => {
            const rect = img.getBoundingClientRect();
            const src = img.currentSrc || img.src || '';
            return src && isVisible(img) && rect.top < 120 && rect.width >= 28 && rect.height >= 28 && src.includes('sinaimg');
          })
          .sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left)[0];
        const hasLoginEntry = Array.from(document.querySelectorAll('a, button, [role="button"]')).some((element) => {
          if (!isVisible(element)) return false;
          const value = text(element.textContent || element.getAttribute('aria-label') || element.getAttribute('title') || '');
          return value === '登录' || value === '登录/注册' || value === '注册' || value.includes('登录/注册');
        });
        if (hasLoginEntry) {
          return { uid: '', nickname: '', avatar: '' };
        }
        const cfg = window.$CONFIG || {};
        const values = [];
        const push = (value) => {
          if (value === undefined || value === null) return;
          if (typeof value === 'string') values.push(value);
          else {
            try { values.push(JSON.stringify(value)); } catch {}
          }
        };
        push(cfg);
        ['__INITIAL_STATE__', '$render_data', '__render_data__', '__data', 'STK', 'FM'].forEach((key) => push(window[key]));
        try {
          for (let index = 0; index < localStorage.length; index += 1) {
            push(localStorage.getItem(localStorage.key(index)));
          }
          for (let index = 0; index < sessionStorage.length; index += 1) {
            push(sessionStorage.getItem(sessionStorage.key(index)));
          }
        } catch {}
        const scripts = Array.from(document.scripts).map((script) => script.textContent || '').join('\\n');
        values.push(scripts);
        const haystack = values.join('\\n');
        const match = (regexp) => {
          const result = haystack.match(regexp);
          return result ? result[1] : '';
        };
        const attr = (selector, name) => text(document.querySelector(selector)?.getAttribute(name) || '');
        const avatarImg = topAvatar || document.querySelector(
          'header img[src*="sinaimg"], nav img[src*="sinaimg"], img[alt*="头像"], [class*="avatar"] img, [class*="Avatar"] img, img[src*="avatar"], img[src*="sinaimg"]'
        );
        const avatarAlt = text(avatarImg?.getAttribute('alt') || avatarImg?.getAttribute('title') || '');
        const uid = text(
          cfg.uid ||
          cfg.id ||
          cfg.oid ||
          cfg.user?.id ||
          cfg.user?.uid ||
          cfg.userInfo?.id ||
          cfg.userInfo?.uid ||
          match(/\\$CONFIG\\[['"]uid['"]\\]\\s*=\\s*['"]?(\\d+)/) ||
          match(/"login_uid"\\s*:\\s*"?([0-9]+)/) ||
          match(/"uid"\\s*:\\s*"?([0-9]+)/) ||
          match(/"idstr"\\s*:\\s*"([0-9]{5,})"/) ||
          match(/"id"\\s*:\\s*"?([0-9]{5,})/) ||
          location.href.match(/(?:u|profile)\\/(\\d+)/)?.[1] ||
          ''
        );
        const nickname = text(
          cfg.nick ||
          cfg.nickname ||
          cfg.screen_name ||
          cfg.user_name ||
          cfg.name ||
          cfg.user?.screen_name ||
          cfg.user?.name ||
          cfg.userInfo?.screen_name ||
          cfg.userInfo?.name ||
          match(/\\$CONFIG\\[['"]nick['"]\\]\\s*=\\s*['"]([^'"]+)['"]/) ||
          match(/"login_name"\\s*:\\s*"([^"]+)"/) ||
          match(/"screen_name"\\s*:\\s*"([^"]+)"/) ||
          match(/"nick"\\s*:\\s*"([^"]+)"/) ||
          match(/"nickname"\\s*:\\s*"([^"]+)"/) ||
          avatarAlt.replace(/的头像$/, '')
        );
        const avatar = normalizeUrl(
          cfg.avatar_large ||
          cfg.avatar_hd ||
          cfg.profile_image_url ||
          cfg.avatar ||
          cfg.user?.avatar_large ||
          cfg.user?.avatar_hd ||
          cfg.user?.profile_image_url ||
          cfg.userInfo?.avatar_large ||
          cfg.userInfo?.avatar_hd ||
          cfg.userInfo?.profile_image_url ||
          match(/"avatar_large"\\s*:\\s*"([^"]+)"/) ||
          match(/"avatar_hd"\\s*:\\s*"([^"]+)"/) ||
          match(/"profile_image_url"\\s*:\\s*"([^"]+)"/) ||
          attr('meta[property="og:image"], meta[name="og:image"]', 'content') ||
          avatarImg?.src ||
          ''
        );
        return { uid, nickname, avatar };
      })()
    `)) as WeiboLoginProfile;

    if (!profile.nickname && !profile.avatar) {
      return null;
    }
    return profile;
  } catch {
    return null;
  }
}

export function registerIpc(db: AppDatabase, mainWindow: BrowserWindow): void {
  startScheduledPostRunner(db, mainWindow);
  ipcMain.handle('dashboard:get', () => db.getDashboard());
  ipcMain.handle('media:select-images', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择微博配图',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp'] }]
    });
    return result.canceled ? [] : result.filePaths.slice(0, 9);
  });
  ipcMain.handle('topic:suggest', (_event, keyword: string, accountId: number | null) =>
    suggestWeiboTopics(keyword, accountId, db)
  );

  ipcMain.handle('account:list', () => db.listAccounts());
  ipcMain.handle('account:create', (_event, platform: AccountPlatform = 'weibo') => db.createAccount(platform));
  ipcMain.handle('account:update-status', (_event, id: number, status: string) => db.updateAccountStatus(id, status as never));
  ipcMain.handle('account:update-profile', (_event, payload: UpdateAccountPayload) => db.updateAccountProfile(payload));
  ipcMain.handle('account:update-group', (_event, accountId: number, groupId: number | null) =>
    db.updateAccountGroup(accountId, groupId)
  );
  ipcMain.handle('account:sync-profile', async (_event, id: number) => {
    const account = db.getAccount(id);
    const partition = db.getPartition(id);
    if (!(await hasPlatformLoginCookie(partition, account.platform || 'weibo'))) {
      if (account.status === 'online' || account.status === 'logging_in') {
        return db.updateAccountStatus(id, 'not_logged_in');
      }
      return account;
    }
    if (account.platform === 'baidu_pan') {
      if (account.status !== 'online') {
        return db.updateAccountStatus(id, 'online');
      }
      return account;
    }
    const profile = await readProfileFromAccountSession(partition);
    if (!profile) {
      if (account.status !== 'online') {
        return db.updateAccountStatus(id, 'online');
      }
      return account;
    }
    return db.updateAccountProfile({
      id,
      uid: profile.uid || account.uid,
      nickname: profile.nickname || account.nickname,
      avatar: profile.avatar || account.avatar,
      status: profile.nickname || profile.avatar ? 'online' : account.status,
      groupId: account.group_id
    });
  });
  ipcMain.handle('account:delete', (_event, id: number) => {
    db.deleteAccount(id);
    return true;
  });
  ipcMain.handle('account:get-partition', (_event, id: number) => db.getPartition(id));
  ipcMain.handle('account:clear-cache', async (_event, id: number) => {
    const accountSession = session.fromPartition(db.getPartition(id));
    await accountSession.clearCache();
    await accountSession.clearStorageData({
      storages: ['cachestorage', 'shadercache', 'serviceworkers']
    });
    return true;
  });
  ipcMain.handle('account:open-login-window', (_event, id: number) => {
    const account = db.getAccount(id);
    const partition = db.getPartition(id);
    const platform = account.platform || 'weibo';
    let loginCompleted = false;
    let loginPoller: NodeJS.Timeout | null = null;
    const loginWindow = new BrowserWindow({
      parent: mainWindow,
      width: 1100,
      height: 760,
      title: platform === 'baidu_pan' ? '百度网盘人工登录' : '微博人工登录',
      webPreferences: {
        partition,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true
      }
    });
    db.updateAccountStatus(id, 'logging_in');
    loginWindow.loadURL(platform === 'baidu_pan' ? BAIDU_PAN_HOME_URL : WEIBO_HOME_URL);

    const stopPolling = (): void => {
      if (loginPoller) {
        clearInterval(loginPoller);
        loginPoller = null;
      }
    };

    const tryCompleteLogin = async (): Promise<void> => {
      if (loginCompleted || loginWindow.isDestroyed()) {
        return;
      }
      if (platform === 'baidu_pan') {
        const hasCookie = await hasBaiduPanLoginCookie(partition);
        if (!hasCookie || loginCompleted || loginWindow.isDestroyed()) {
          return;
        }
        const current = db.getAccount(id);
        db.updateAccountProfile({
          id,
          uid: current.uid,
          nickname: current.nickname || `百度网盘 ${id}`,
          avatar: current.avatar,
          status: 'online',
          groupId: current.group_id
        });
        loginCompleted = true;
        stopPolling();
        mainWindow.webContents.send('account:login-succeeded', id);
        loginWindow.close();
        return;
      }
      const [profileFromPage, profileFromSession, hasCookie] = await Promise.all([
        readLoggedInWeiboProfile(loginWindow),
        readProfileFromAccountSession(partition),
        hasAccountLoginCookie(partition)
      ]);
      const profile = mergeProfile(profileFromPage, profileFromSession);
      if ((!profile && !hasCookie) || loginCompleted || loginWindow.isDestroyed()) {
        return;
      }
      const account = db.getAccount(id);
      if (profile) {
        db.updateAccountProfile({
          id,
          uid: profile.uid || account.uid,
          nickname: profile.nickname,
          avatar: profile.avatar || account.avatar,
          status: 'online',
          groupId: account.group_id
        });
      }
      loginCompleted = true;
      stopPolling();
      mainWindow.webContents.send('account:login-succeeded', id);
      loginWindow.close();
    };

    const scheduleCheck = (): void => {
      setTimeout(() => {
        void tryCompleteLogin();
      }, 900);
    };

    loginPoller = setInterval(() => {
      void tryCompleteLogin();
    }, 1500);

    loginWindow.webContents.on('did-stop-loading', scheduleCheck);
    loginWindow.webContents.on('did-navigate-in-page', scheduleCheck);
    loginWindow.webContents.on('did-navigate', scheduleCheck);
    loginWindow.on('closed', () => {
      stopPolling();
      if (!loginCompleted) {
        try {
          const account = db.getAccount(id);
          if (account.status === 'logging_in') {
            db.updateAccountStatus(id, 'not_logged_in');
          }
        } catch {
          return;
        }
      }
      mainWindow.webContents.send('account:login-window-closed', id);
    });
    return true;
  });

  ipcMain.handle('group:list', () => db.listGroups());
  ipcMain.handle('group:create', (_event, name: string, remark: string | null) => db.createGroup(name, remark));
  ipcMain.handle('group:update', (_event, id: number, name: string, remark: string | null) =>
    db.updateGroup(id, name, remark)
  );
  ipcMain.handle('group:delete', (_event, id: number) => {
    db.deleteGroup(id);
    return true;
  });

  ipcMain.handle('post:create-batch', (_event, payload: CreatePostPayload) => db.createPostTasks(payload));
  ipcMain.handle('post:list', () => db.listPostTasks());
  ipcMain.handle('post:auto-publish', async (_event, taskId: number) => autoPublishPostTask(taskId, db));
  ipcMain.handle('post:start', (_event, taskId: number) => db.startPostTask(taskId));
  ipcMain.handle('post:complete', (_event, payload: CompletePostPayload) => db.completePostTask(payload));
  ipcMain.handle('post:fail', (_event, payload: FailPostPayload) => db.failPostTask(payload));

  ipcMain.handle('comment:list', () => db.listCommentTasks());
  ipcMain.handle('comment:auto-publish', async (_event, taskId: number) => {
    const task = db.startCommentTask(taskId);
    return autoPublishCommentTask(task, db);
  });
  ipcMain.handle('comment:start', (_event, taskId: number) => db.startCommentTask(taskId));
  ipcMain.handle('comment:complete', (_event, payload: CompleteCommentPayload) => db.completeCommentTask(payload));
  ipcMain.handle('comment:fail', (_event, payload: FailCommentPayload) => db.failCommentTask(payload));
  ipcMain.handle('comment:skip', (_event, taskId: number) => db.skipCommentTask(taskId));

  ipcMain.handle('log:list', () => db.listLogs());
}
