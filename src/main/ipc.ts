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

async function readLatestWeiboUrl(window: BrowserWindow): Promise<string | null> {
  return window.webContents.executeJavaScript(`
    (() => {
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
    await submitCommentInWindow(commentWindow, payload.content, payload.replyToContent || null);
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
        sendButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        return true;
      })()
    `)) as boolean;
    if (!clicked) {
      throw new Error('没有找到发送按钮');
    }
    await delay(6000);
    const weiboUrl = (await readLatestWeiboUrl(postWindow).catch(() => null)) || postWindow.webContents.getURL() || WEIBO_HOME_URL;
    return { taskId: payload.taskId, status: 'success', weiboUrl, errorMessage: null };
  } catch (error) {
    return {
      taskId: payload.taskId,
      status: 'failed',
      weiboUrl: null,
      errorMessage: error instanceof Error ? error.message : '自动发帖失败'
    };
  } finally {
    if (!postWindow.isDestroyed()) {
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
        images
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
