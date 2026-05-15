<script setup lang="ts">
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ClipboardList,
  Copy,
  Eraser,
  FolderTree,
  Hash,
  Home,
  Image as ImageIcon,
  Loader2,
  MessageCircle,
  Plus,
  RefreshCw,
  Send,
  ShieldCheck,
  Trash2,
  Users,
} from 'lucide-vue-next';
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import type {
  AccountGroup,
  AccountPlatform,
  AccountStatus,
  CommentTask,
  CreatePostPayload,
  DashboardStats,
  OperationLog,
  PostTask,
  WeiboAccount
} from '../../shared/types';

type PageKey = 'home' | 'accounts' | 'posts' | 'groups' | 'logs';

const pages: Array<{ key: PageKey; label: string; icon: typeof Home }> = [
  { key: 'home', label: '首页', icon: Home },
  { key: 'accounts', label: '账号', icon: Users },
  { key: 'posts', label: '发帖', icon: Send },
  { key: 'groups', label: '分组', icon: FolderTree },
  { key: 'logs', label: '状态日志', icon: ClipboardList }
];

const activePage = ref<PageKey>('home');
const loading = ref(false);
const errorMessage = ref('');
const dashboard = ref<DashboardStats | null>(null);
const accounts = ref<WeiboAccount[]>([]);
const groups = ref<AccountGroup[]>([]);
const logs = ref<OperationLog[]>([]);
const postTasks = ref<PostTask[]>([]);
const commentTasks = ref<CommentTask[]>([]);
const selectedAccountId = ref<number | null>(null);
const selectedPartition = ref('');
const accountPanelCollapsed = ref(false);
const accountViewVersion = ref(0);
const accountWebviewSyncing = ref(false);
const browserUrl = ref('https://weibo.com/');
const accountBrowserUrls = ref<Record<number, string>>({});
const accountPlatformMenuOpen = ref(false);
const accountProfileRedirectedAt = ref<Record<number, number>>({});
const accountSearch = ref('');
const accountStatusFilter = ref<'all' | AccountStatus>('all');

const groupName = ref('');
const groupRemark = ref('');
const expandedGroupIds = ref<number[]>([]);
const selectedPostAccountIds = ref<number[]>([]);
const postContent = ref('');
const postTopics = ref('');
const postTextarea = ref<HTMLTextAreaElement | null>(null);
const postImages = ref<string[]>([]);
const topicQuery = ref('');
const topicSuggesting = ref(false);
const topicMenuOpen = ref(false);
const liveTopicSuggestions = ref<string[]>([]);
const superTopicPickerOpen = ref(false);
const superTopicSearch = ref('');
const activeSuperTopicTab = ref('recent');
const superTopicLoading = ref(false);
const superTopicResults = ref<string[]>([]);
const autoCommentEnabled = ref(false);
const commentContent = ref('');
const commentDelaySeconds = ref(0);
const commentAccountId = ref<number | null>(null);
const linkExtractInput = ref('');
const replyCommentEnabled = ref(false);
const replyCommentContent = ref('');
const replyCommentDelaySeconds = ref(0);
const replyCommentAccountId = ref<number | null>(null);
const scheduledAt = ref('');
const activeManualTask = ref<PostTask | null>(null);
const activeCommentTask = ref<CommentTask | null>(null);
const completionWeiboUrl = ref('');
const completionWeiboId = ref('');
const failReason = ref('');
const commentFailReason = ref('');

const selectedAccount = computed(() => accounts.value.find((account) => account.id === selectedAccountId.value) ?? null);
const onlineAccounts = computed(() => accounts.value.filter((account) => account.status === 'online'));
const postableAccounts = computed(() => accounts.value.filter((account) => (account.platform || 'weibo') === 'weibo' && account.status !== 'expired'));
const commentableAccounts = computed(() => accounts.value.filter((account) => (account.platform || 'weibo') === 'weibo' && account.status === 'online'));
const extractedCommentLinks = computed(() => extractCommentLinks(linkExtractInput.value));
const composedTopics = computed(() => {
  const fromContent = Array.from(postContent.value.matchAll(/#([^#\s]{1,30})#/g)).map((match) => normalizeTopic(match[1]));
  return Array.from(new Set(fromContent));
});
const filteredAccounts = computed(() => {
  const keyword = accountSearch.value.trim().toLowerCase();
  return accounts.value.filter((account) => {
    const matchesKeyword =
      !keyword ||
      String(account.id).includes(keyword) ||
      (account.nickname || '').toLowerCase().includes(keyword) ||
      (account.uid || '').toLowerCase().includes(keyword) ||
      (account.group_name || '').toLowerCase().includes(keyword);
    const matchesStatus = accountStatusFilter.value === 'all' || account.status === accountStatusFilter.value;
    return matchesKeyword && matchesStatus;
  });
});

const statusText: Record<AccountStatus, string> = {
  not_logged_in: '未登录',
  logging_in: '登录中',
  online: '在线',
  offline: '离线',
  expired: '登录失效',
  abnormal: '异常',
  posting: '发帖中',
  commenting: '评论中'
};

const platformText: Record<AccountPlatform, string> = {
  weibo: '新浪微博',
  baidu_pan: '百度网盘'
};

const platformHomeUrl: Record<AccountPlatform, string> = {
  weibo: 'https://weibo.com/',
  baidu_pan: 'https://pan.baidu.com/'
};

function accountPlatform(account: WeiboAccount): AccountPlatform {
  return account.platform || 'weibo';
}

function accountHomeUrl(account: WeiboAccount): string {
  return platformHomeUrl[accountPlatform(account)];
}

const superTopicTabs = [
  { key: 'recent', label: '最近使用' },
  { key: 'game', label: '游戏' },
  { key: 'esports', label: '电竞' },
  { key: 'anime', label: '动漫' },
  { key: 'sports', label: '体育运动' },
  { key: 'celebrity', label: '明星' },
  { key: 'influencer', label: '红人' },
  { key: 'film', label: '影视' }
];

const fallbackSuperTopics: Record<string, string[]> = {
  recent: ['韩漫推荐分享', '漫画推荐', '美耽漫画', '追剧日常'],
  game: ['游戏分享', '手游推荐', '单机游戏', '游戏日常'],
  esports: ['电竞赛事', '英雄联盟', '王者荣耀', '和平精英'],
  anime: ['韩漫推荐分享', '漫画推荐', '动漫推荐', '新番推荐'],
  sports: ['运动打卡', '足球', '篮球', '健身日常'],
  celebrity: ['明星安利', '娱乐播报', '明星日常', '追星日记'],
  influencer: ['生活分享', '好物推荐', '日常碎片', '穿搭分享'],
  film: ['影视推荐', '追剧日常', '电影推荐', '综艺安利']
};

const accountStatusOptions: AccountStatus[] = [
  'not_logged_in',
  'logging_in',
  'online',
  'offline',
  'expired',
  'abnormal',
  'posting',
  'commenting'
];

type WebviewElement = HTMLElement & {
  executeJavaScript: <T = unknown>(code: string) => Promise<T>;
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  goBack: () => void;
  goForward: () => void;
  reload: () => void;
  getURL: () => string;
  loadURL: (url: string) => Promise<void> | void;
};

function isNavigationAbort(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const value = error as { code?: string; errno?: number; message?: string };
  return value.errno === -3 || value.code === 'ERR_ABORTED' || /ERR_ABORTED|\(-3\)/.test(value.message || '');
}

function accountDisplayName(account: WeiboAccount): string {
  if (account.nickname && account.nickname !== '新微博账号' && account.nickname !== '新百度网盘账号') {
    return account.nickname;
  }
  return accountPlatform(account) === 'baidu_pan' ? '百度网盘账号' : '等待同步微博名称';
}

function accountDisplayIndex(account: WeiboAccount): number {
  const index = accounts.value.findIndex((item) => item.id === account.id);
  return index >= 0 ? index + 1 : 1;
}

function accountFallbackName(account: WeiboAccount): string {
  return `账号 ${accountDisplayIndex(account)}`;
}

function accountTabTitle(account: WeiboAccount): string {
  if (accountPlatform(account) === 'baidu_pan') {
    return accountDisplayName(account);
  }
  if (hasSyncedProfile(account)) {
    return accountDisplayName(account);
  }
  return `新浪微博 ${accountDisplayIndex(account)}`;
}

function hasSyncedProfile(account: WeiboAccount): boolean {
  if (accountPlatform(account) === 'baidu_pan') {
    return account.status === 'online';
  }
  return Boolean(account.nickname && account.nickname !== '新微博账号' && account.avatar);
}

function accountStatusLabel(account: WeiboAccount): string {
  if (account.status === 'online' && !hasSyncedProfile(account)) {
    return '等待同步';
  }
  if (account.status === 'logging_in' && !hasSyncedProfile(account)) {
    return '等待同步';
  }
  return statusText[account.status];
}

function normalizeTopic(value: string): string {
  const cleaned = value
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

function topicToken(value: string): string {
  const normalized = normalizeTopic(value);
  return normalized ? `#${normalized}#` : '';
}

function normalizeSuperTopic(value: string): string {
  const normalized = normalizeTopic(value);
  if (!normalized) {
    return '';
  }
  return /\[超话\]$/.test(normalized) ? normalized : `${normalized.replace(/超话$/g, '')}[超话]`;
}

function cleanPostContent(value: string): string {
  return value
    .replace(/#([^#\s]+?\[超话\])#\1超话/g, '#$1#')
    .replace(/#([^#\s]+?\[超话\])#\1\[超话\]/g, '#$1#')
    .replace(/#([^#\s]+?)\[超话\]超话#/g, '#$1[超话]#')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

async function insertPostToken(token: string): Promise<void> {
  const textarea = postTextarea.value;
  const current = postContent.value;
  const prefix = current && !/\s$/.test(current) ? ' ' : '';
  const suffix = ' ';
  if (!textarea) {
    postContent.value = `${current}${prefix}${token}${suffix}`;
    return;
  }

  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  postContent.value = `${current.slice(0, start)}${prefix}${token}${suffix}${current.slice(end)}`;
  await nextTick();
  const cursor = start + prefix.length + token.length + suffix.length;
  textarea.focus();
  textarea.setSelectionRange(cursor, cursor);
}

function addTopicSuggestion(topic: string): void {
  const token = topicToken(topic);
  if (!token) {
    return;
  }
  void insertPostToken(token);
}

function fallbackSuperTopicList(): string[] {
  return fallbackSuperTopics[activeSuperTopicTab.value] ?? fallbackSuperTopics.recent;
}

async function refreshSuperTopicResults(): Promise<void> {
  const query = superTopicSearch.value.trim();
  if (!query) {
    superTopicResults.value = fallbackSuperTopicList();
    return;
  }
  superTopicLoading.value = true;
  try {
    const suggestions = await window.weiboApp.topics.suggest(query, selectedPostAccountIds.value[0] ?? selectedAccountId.value);
    superTopicResults.value = suggestions.length ? suggestions : [`${query}[超话]`];
  } catch {
    superTopicResults.value = [`${query}[超话]`];
  } finally {
    superTopicLoading.value = false;
  }
}

async function toggleSuperTopicPicker(): Promise<void> {
  superTopicPickerOpen.value = !superTopicPickerOpen.value;
  if (superTopicPickerOpen.value) {
    await refreshSuperTopicResults();
    await nextTick();
    document.querySelector<HTMLInputElement>('.supertopic-search-input')?.focus();
  }
}

async function selectSuperTopic(topic: string): Promise<void> {
  const token = topicToken(normalizeSuperTopic(topic));
  if (!token) {
    return;
  }
  await insertPostToken(token);
  superTopicPickerOpen.value = false;
  superTopicSearch.value = '';
}

function currentTopicDraft(): { query: string; start: number; end: number } | null {
  const textarea = postTextarea.value;
  const cursor = textarea?.selectionStart ?? postContent.value.length;
  const beforeCursor = postContent.value.slice(0, cursor);
  const match = beforeCursor.match(/#([^#\s]{0,30})$/);
  if (!match || match.index === undefined) {
    return null;
  }
  return {
    query: match[1],
    start: match.index,
    end: cursor
  };
}

async function updateTopicSuggestions(): Promise<void> {
  const draft = currentTopicDraft();
  if (!draft || !draft.query) {
    topicQuery.value = '';
    liveTopicSuggestions.value = [];
    topicMenuOpen.value = false;
    return;
  }
  topicQuery.value = draft.query;
  topicMenuOpen.value = true;
  topicSuggesting.value = true;
  try {
    const suggestions = await window.weiboApp.topics.suggest(draft.query, selectedPostAccountIds.value[0] ?? selectedAccountId.value);
    liveTopicSuggestions.value = suggestions.length ? suggestions : [`${draft.query}[超话]`, `${draft.query}分享`, `${draft.query}日常`];
  } catch {
    liveTopicSuggestions.value = [`${draft.query}[超话]`, `${draft.query}分享`, `${draft.query}日常`];
  } finally {
    topicSuggesting.value = false;
  }
}

async function applyTopicSuggestion(topic: string): Promise<void> {
  const draft = currentTopicDraft();
  const token = topicToken(topic);
  if (!draft || !token) {
    return;
  }
  postContent.value = `${postContent.value.slice(0, draft.start)}${token} ${postContent.value.slice(draft.end)}`;
  topicMenuOpen.value = false;
  await nextTick();
  const cursor = draft.start + token.length + 1;
  postTextarea.value?.focus();
  postTextarea.value?.setSelectionRange(cursor, cursor);
}

async function openImagePicker(): Promise<void> {
  const nextImages = await window.weiboApp.media.selectImages();
  postImages.value = Array.from(new Set([...postImages.value, ...nextImages])).slice(0, 9);
}

function removePostImage(path: string): void {
  postImages.value = postImages.value.filter((image) => image !== path);
}

function getWeiboWebview(): WebviewElement | null {
  return document.querySelector('.weibo-webview') as WebviewElement | null;
}

function updateBrowserUrl(): void {
  const webview = getWeiboWebview();
  if (webview?.getURL) {
    const nextUrl = webview.getURL() || browserUrl.value;
    browserUrl.value = nextUrl;
    if (selectedAccountId.value) {
      accountBrowserUrls.value[selectedAccountId.value] = nextUrl;
    }
  }
}

function goBrowserBack(): void {
  const webview = getWeiboWebview();
  if (webview?.canGoBack()) {
    webview.goBack();
  }
}

function goBrowserForward(): void {
  const webview = getWeiboWebview();
  if (webview?.canGoForward()) {
    webview.goForward();
  }
}

function reloadBrowser(): void {
  getWeiboWebview()?.reload();
}

function loadWebviewUrl(webview: WebviewElement, url: string): void {
  void Promise.resolve(webview.loadURL(url)).catch((error) => {
    if (!isNavigationAbort(error)) {
      console.error(error);
    }
  });
}

function loadBrowserUrl(): void {
  const webview = getWeiboWebview();
  if (!webview) {
    return;
  }
  const rawUrl = browserUrl.value.trim();
  if (!rawUrl) {
    return;
  }
  const nextUrl = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
  browserUrl.value = nextUrl;
  if (selectedAccountId.value) {
    accountBrowserUrls.value[selectedAccountId.value] = nextUrl;
  }
  loadWebviewUrl(webview, nextUrl);
}

async function copyBrowserLink(): Promise<void> {
  updateBrowserUrl();
  await navigator.clipboard.writeText(browserUrl.value);
}

async function clearSelectedAccountCache(): Promise<void> {
  if (!selectedAccount.value) {
    return;
  }
  await window.weiboApp.accounts.clearCache(selectedAccount.value.id);
  reloadBrowser();
}

async function refreshAllAndSyncSelected(): Promise<void> {
  await refreshAll();
  scheduleLoggedInProfileSync();
}

async function syncLoggedInProfileFromWebview(): Promise<void> {
  const account = selectedAccount.value;
  if (!account || accountWebviewSyncing.value) {
    return;
  }
  if (accountPlatform(account) !== 'weibo') {
    await window.weiboApp.accounts.syncProfile(account.id);
    await refreshAll();
    return;
  }

  accountWebviewSyncing.value = true;
  try {
    const syncedAccount = await window.weiboApp.accounts.syncProfile(account.id);
    if (hasSyncedProfile(syncedAccount)) {
      await refreshAll();
      if (
        syncedAccount.nickname !== account.nickname ||
        syncedAccount.avatar !== account.avatar ||
        syncedAccount.uid !== account.uid
      ) {
        return;
      }
    }

    const webview = document.querySelector('.weibo-webview') as WebviewElement | null;
    if (!webview?.executeJavaScript) {
      return;
    }

    const profile = await webview.executeJavaScript<{
      nickname: string;
      avatar: string;
      uid: string;
      profileUrl: string;
      clickedProfileEntry: boolean;
    }>(`
      (async () => {
        try {
        const text = (value) => (value || '').replace(/\\s+/g, ' ').trim();
        const normalizeUrl = (value) => text(value).replace(/\\\\\\//g, '/');
        const absoluteUrl = (value) => {
          try {
            const url = new URL(text(value), location.href);
            return url.hostname.endsWith('weibo.com') ? url.href : '';
          } catch {
            return '';
          }
        };
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
          return { uid: '', nickname: '', avatar: '', profileUrl: '', clickedProfileEntry: false };
        }
        const isProfilePage = /\\/u\\/\\d+|\\/profile\\/\\d+/.test(location.pathname);
        const blocked = new Set([
          '首页', '我的主页', '我的关注', '我的粉丝', '我的经常访问', '我的收藏',
          '我的赞', '创作者中心', '全部关注', '最新微博', '好友圈', '自定义分组',
          '微博', '视频', '精选', '返回', '搜索', '公开', '粉丝', '关注', '转评赞',
          '全部微博', '相册', '更多', '管理'
        ]);
        const app = document.querySelector('#app')?.__vue_app__;
        const store = app?.config?.globalProperties?.$store;
        const storeCfg = store?.state?.config?.config || {};
        let remoteCfg = {};
        let mobileCfg = {};
        try {
          const configResponse = await fetch('/ajax/config/get_config', { credentials: 'include' });
          if (configResponse.ok) {
            const configData = await configResponse.json();
            remoteCfg = configData?.data || {};
          }
        } catch {}
        try {
          const mobileConfigResponse = await fetch('https://m.weibo.cn/api/config', { credentials: 'include' });
          if (mobileConfigResponse.ok) {
            const mobileConfigData = await mobileConfigResponse.json();
            mobileCfg = mobileConfigData?.data || {};
          }
        } catch {}
        const cfg = { ...remoteCfg, ...storeCfg, ...(window.$CONFIG || {}) };
        let currentUser =
          mobileCfg.userInfo ||
          mobileCfg.user ||
          cfg.user ||
          storeCfg.user ||
          remoteCfg.user ||
          {};
        const values = [];
        const push = (value) => {
          if (value === undefined || value === null) return;
          if (typeof value === 'string') values.push(value);
          else {
            try { values.push(JSON.stringify(value)); } catch {}
          }
        };
        push(cfg);
        push(mobileCfg);
        ['__INITIAL_STATE__', '$render_data', '__render_data__', '__data'].forEach((key) => push(window[key]));
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
        const cleanName = (value) => {
          const next = text(value)
            .replace(/^@/, '')
            .replace(/的头像$/, '')
            .replace(/的微博.*$/, '')
            .replace(/微博.*$/, '');
          if (
            !next ||
            blocked.has(next) ||
            next.length > 32 ||
            /^[0-9\\s]+$/.test(next) ||
            /粉丝|关注|转评赞|播放|全部|主页|收藏|创作者/.test(next) ||
            /^\\d+/.test(next)
          ) return '';
          return next;
        };
        const uid = text(
          cfg.uid ||
          cfg.id ||
          cfg.oid ||
          cfg.login_uid ||
          mobileCfg.uid ||
          mobileCfg.login_uid ||
          mobileCfg.userInfo?.id ||
          mobileCfg.userInfo?.uid ||
          mobileCfg.user?.id ||
          mobileCfg.user?.uid ||
          currentUser.id ||
          currentUser.uid ||
          cfg.user?.id ||
          cfg.user?.uid ||
          cfg.userInfo?.id ||
          cfg.userInfo?.uid ||
          match(/"login_uid"\\s*:\\s*"?([0-9]+)/) ||
          match(/"uid"\\s*:\\s*"?([0-9]+)/) ||
          match(/"idstr"\\s*:\\s*"([0-9]{5,})"/) ||
          match(/"id"\\s*:\\s*"?([0-9]{5,})/) ||
          location.href.match(/(?:u|profile)\\/(\\d+)/)?.[1] ||
          ''
        );
        if (uid) {
          try {
            const [infoData, detailData, mobileProfileData] = await Promise.all([
              fetch(\`/ajax/profile/info?uid=\${uid}\`, { credentials: 'include' }).then((response) => response.ok ? response.json() : null).catch(() => null),
              fetch(\`/ajax/profile/detail?uid=\${uid}\`, { credentials: 'include' }).then((response) => response.ok ? response.json() : null).catch(() => null),
              fetch(\`https://m.weibo.cn/api/container/getIndex?type=uid&value=\${uid}\`, { credentials: 'include' }).then((response) => response.ok ? response.json() : null).catch(() => null)
            ]);
            currentUser =
              infoData?.data?.user ||
              detailData?.data?.user ||
              mobileProfileData?.data?.userInfo ||
              currentUser;
            push(infoData);
            push(detailData);
            push(mobileProfileData);
          } catch {}
        }
        const navAvatar = topAvatar || Array.from(document.images)
          .filter((img) => {
            const rect = img.getBoundingClientRect();
            const src = img.currentSrc || img.src || '';
            return src && isVisible(img) && rect.top < 120 && rect.width >= 28 && rect.height >= 28;
          })
          .sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left)[0];
        const navProfileLink = navAvatar?.closest('a[href]');
        const findClickableProfileEntry = (element) => {
          let node = element;
          for (let depth = 0; node && depth < 6; depth += 1) {
            const style = window.getComputedStyle(node);
            if (
              node.matches?.('a[href], button, [role="button"], [tabindex]') ||
              typeof node.onclick === 'function' ||
              style.cursor === 'pointer'
            ) {
              return node;
            }
            node = node.parentElement;
          }
          return null;
        };
        const profileUrl = absoluteUrl(
          uid ? \`https://weibo.com/u/\${uid}\` :
          currentUser.profile_url ||
          navProfileLink?.href ||
          match(/"profile_url"\\s*:\\s*"([^"]+)"/) ||
          match(/"profileUrl"\\s*:\\s*"([^"]+)"/) ||
          ''
        );
        const configNickname = cleanName(
          cfg.nick ||
          cfg.nickname ||
          cfg.screen_name ||
          cfg.user_name ||
          cfg.name ||
          currentUser.screen_name ||
          currentUser.name ||
          currentUser.nickname ||
          currentUser.screenName ||
          cfg.user?.screen_name ||
          cfg.user?.name ||
          cfg.userInfo?.screen_name ||
          cfg.userInfo?.name ||
          match(/"login_name"\\s*:\\s*"([^"]+)"/) ||
          match(/"screen_name"\\s*:\\s*"([^"]+)"/) ||
          match(/"nick"\\s*:\\s*"([^"]+)"/) ||
          match(/"nickname"\\s*:\\s*"([^"]+)"/)
        );
        const visibleElements = isProfilePage ? Array.from(document.querySelectorAll('div, section, article, main')).filter(isVisible) : [];
        const profileBlocks = visibleElements
          .map((element) => ({ element, body: text(element.innerText || '') }))
          .filter((item) =>
            item.body.includes('粉丝') &&
            item.body.includes('关注') &&
            item.element.querySelector('img') &&
            !item.body.includes('登录/注册')
          )
          .sort((a, b) => {
            const ar = a.element.getBoundingClientRect();
            const br = b.element.getBoundingClientRect();
            const aScore =
              (a.body.includes('转评赞') ? -100000 : 0) +
              (a.body.includes('我的主页') ? -50000 : 0) +
              ar.width * ar.height;
            const bScore =
              (b.body.includes('转评赞') ? -100000 : 0) +
              (b.body.includes('我的主页') ? -50000 : 0) +
              br.width * br.height;
            return bScore - aScore;
          });
        const profileBlock = profileBlocks[0]?.element || null;
        const profileBlockText = text(profileBlocks[0]?.body || '');
        const profileNameFromStats = (() => {
          const beforeFans = profileBlockText.split(/粉丝/)[0] || '';
          const normalized = beforeFans
            .replace(/\\d+$/, '')
            .split(' ')
            .map(cleanName)
            .filter(Boolean);
          return normalized[normalized.length - 1] || '';
        })();
        const leafTextNames = profileBlock
          ? Array.from(profileBlock.querySelectorAll('*'))
              .filter((element) => isVisible(element) && element.children.length === 0)
              .map((element) => cleanName(element.textContent || ''))
              .filter(Boolean)
          : [];
        const profileImages = profileBlock
          ? Array.from(profileBlock.querySelectorAll('img')).filter((img) => {
              const src = img.currentSrc || img.src || '';
              const rect = img.getBoundingClientRect();
              return src && rect.width >= 44 && rect.height >= 44 && isVisible(img);
            }).sort((a, b) => {
              const ar = a.getBoundingClientRect();
              const br = b.getBoundingClientRect();
              const score = (rect) =>
                Math.abs(rect.width - rect.height) +
                (Math.max(rect.width, rect.height) > 220 ? 10000 : 0) +
                (Math.min(rect.width, rect.height) < 44 ? 10000 : 0);
              return score(ar) - score(br);
            })
          : [];
        const imageCandidates = (topAvatar || isProfilePage ? Array.from(document.images) : [])
          .filter((img) => {
            const src = img.currentSrc || img.src || '';
            const width = img.naturalWidth || img.width || 0;
            const height = img.naturalHeight || img.height || 0;
            return src && width >= 36 && height >= 36 && isVisible(img) && !src.includes('weibo.com/favicon') && !src.includes('logo');
          })
          .sort((a, b) => ((b.naturalWidth || b.width || 0) * (b.naturalHeight || b.height || 0)) - ((a.naturalWidth || a.width || 0) * (a.naturalHeight || a.height || 0)));
        const avatarImage =
          profileImages.find((img) => (img.currentSrc || img.src || '').includes('sinaimg')) ||
          profileImages[0] ||
          navAvatar ||
          imageCandidates.find((img) => text(img.alt || img.title).includes('头像')) ||
          imageCandidates.find((img) => (img.currentSrc || img.src || '').includes('sinaimg')) ||
          imageCandidates[0];
        const avatar = normalizeUrl(
          cfg.avatar_large ||
          cfg.avatar_hd ||
          cfg.profile_image_url ||
          cfg.avatar ||
          currentUser.avatar_hd ||
          currentUser.avatar_large ||
          currentUser.avatarLarge ||
          currentUser.profileImageUrl ||
          currentUser.profile_image_url ||
          currentUser.avatar ||
          cfg.user?.avatar_large ||
          cfg.user?.avatar_hd ||
          cfg.user?.profile_image_url ||
          cfg.userInfo?.avatar_large ||
          cfg.userInfo?.avatar_hd ||
          cfg.userInfo?.profile_image_url ||
          match(/"avatar_large"\\s*:\\s*"([^"]+)"/) ||
          match(/"avatar_hd"\\s*:\\s*"([^"]+)"/) ||
          match(/"profile_image_url"\\s*:\\s*"([^"]+)"/) ||
          avatarImage?.currentSrc ||
          avatarImage?.src ||
          ''
        );
        const names = [configNickname, profileNameFromStats, ...leafTextNames];
        if (isProfilePage || topAvatar) {
          names.push(cleanName(avatarImage?.alt), cleanName(avatarImage?.title));
        }
        let node = avatarImage;
        for (let depth = 0; node && depth < 7; depth += 1) {
          const lines = text(node.innerText).split(' ').map(cleanName).filter(Boolean);
          names.push(...lines);
          node = node.parentElement;
        }
        const nickname = names.find(Boolean) || '';
        if ((!nickname || !avatar) && navAvatar && !/\\/u\\/\\d+|\\/profile\\/\\d+/.test(location.pathname)) {
          const clickable = findClickableProfileEntry(navAvatar);
          if (clickable) {
            clickable.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
            return { uid, nickname, avatar, profileUrl: '', clickedProfileEntry: true };
          }
        }
        return { uid, nickname, avatar, profileUrl, clickedProfileEntry: false };
        } catch {
          return { uid: '', nickname: '', avatar: '', profileUrl: '', clickedProfileEntry: false };
        }
      })()
    `);

    if (!profile.nickname || !profile.avatar) {
      if (
        (profile.nickname && profile.nickname !== account.nickname) ||
        (profile.avatar && profile.avatar !== account.avatar)
      ) {
        await window.weiboApp.accounts.updateProfile({
          id: account.id,
          uid: profile.uid || account.uid,
          nickname: profile.nickname || account.nickname,
          avatar: profile.avatar || account.avatar,
          status: profile.nickname || profile.avatar ? 'online' : account.status,
          groupId: account.group_id
        });
        await refreshAll();
      }
      const now = Date.now();
      const lastRedirectAt = accountProfileRedirectedAt.value[account.id] ?? 0;
      const currentUrl = webview.getURL?.() || browserUrl.value;
      if (
        profile.profileUrl &&
        !currentUrl.includes(profile.profileUrl.replace(/\/$/, '')) &&
        now - lastRedirectAt > 8000
      ) {
        accountProfileRedirectedAt.value[account.id] = now;
        browserUrl.value = profile.profileUrl;
        accountBrowserUrls.value[account.id] = profile.profileUrl;
        loadWebviewUrl(webview, profile.profileUrl);
      } else if (profile.clickedProfileEntry) {
        scheduleLoggedInProfileSync();
      }
      return;
    }
    if (profile.nickname === account.nickname && profile.avatar === account.avatar && account.status === 'online') {
      return;
    }
    await window.weiboApp.accounts.updateProfile({
      id: account.id,
      uid: profile.uid || account.uid,
      nickname: profile.nickname,
      avatar: profile.avatar,
      status: 'online',
      groupId: account.group_id
    });
    await refreshAll();
  } catch {
    // Ignore probing failures; the page may still be loading or not logged in.
  } finally {
    accountWebviewSyncing.value = false;
  }
}

function scheduleLoggedInProfileSync(): void {
  [600, 1800, 3600, 6500].forEach((delay) => {
    window.setTimeout(() => {
      syncLoggedInProfileFromWebview();
    }, delay);
  });
}

function needsProfileSync(): boolean {
  const account = selectedAccount.value;
  return Boolean(
    account &&
      accountPlatform(account) === 'weibo' &&
      account.status !== 'expired' &&
      (account.status === 'online' || account.status === 'logging_in')
  );
}

async function refreshAll(): Promise<void> {
  loading.value = true;
  errorMessage.value = '';
  try {
    const [dashboardData, accountData, groupData, logData, taskData, commentTaskData] = await Promise.all([
      window.weiboApp.dashboard.get(),
      window.weiboApp.accounts.list(),
      window.weiboApp.groups.list(),
      window.weiboApp.logs.list(),
      window.weiboApp.posts.list(),
      window.weiboApp.comments.list()
    ]);
    dashboard.value = dashboardData;
    accounts.value = accountData;
    groups.value = groupData;
    logs.value = logData;
    postTasks.value = taskData;
    commentTasks.value = commentTaskData;
    if (!selectedAccountId.value && accountData.length > 0) {
      await selectAccount(accountData[0].id);
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '加载数据失败';
  } finally {
    loading.value = false;
  }
}

async function addAccount(platform: AccountPlatform): Promise<void> {
  accountPlatformMenuOpen.value = false;
  const account = await window.weiboApp.accounts.create(platform);
  await refreshAll();
  await selectAccount(account.id);
  await window.weiboApp.accounts.openLoginWindow(account.id);
}

async function openLoginWindow(id: number): Promise<void> {
  await window.weiboApp.accounts.openLoginWindow(id);
  await window.weiboApp.accounts.syncProfile(id);
  await refreshAll();
}

async function selectAccount(id: number): Promise<void> {
  updateBrowserUrl();
  selectedAccountId.value = id;
  selectedPartition.value = await window.weiboApp.accounts.getPartition(id);
  const account = accounts.value.find((item) => item.id === id);
  browserUrl.value = accountBrowserUrls.value[id] || (account ? accountHomeUrl(account) : 'https://weibo.com/');
}

async function deleteAccount(id: number): Promise<void> {
  errorMessage.value = '';
  try {
    await window.weiboApp.accounts.delete(id);
    if (selectedAccountId.value === id) {
      selectedAccountId.value = null;
      selectedPartition.value = '';
    }
    await refreshAll();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '删除账号失败';
  }
}

async function assignGroup(accountId: number, rawGroupId: string): Promise<void> {
  const groupId = rawGroupId ? Number(rawGroupId) : null;
  await window.weiboApp.accounts.updateGroup(accountId, groupId);
  await refreshAll();
}

function toggleGroupPanel(groupId: number): void {
  expandedGroupIds.value = expandedGroupIds.value.includes(groupId)
    ? expandedGroupIds.value.filter((id) => id !== groupId)
    : [...expandedGroupIds.value, groupId];
}

async function toggleAccountGroup(account: WeiboAccount, groupId: number, checked: boolean): Promise<void> {
  await window.weiboApp.accounts.updateGroup(account.id, checked ? groupId : null);
  await refreshAll();
}

async function createGroup(): Promise<void> {
  if (!groupName.value.trim()) {
    errorMessage.value = '分组名称不能为空';
    return;
  }
  await window.weiboApp.groups.create(groupName.value, groupRemark.value || null);
  groupName.value = '';
  groupRemark.value = '';
  await refreshAll();
}

async function deleteGroup(id: number): Promise<void> {
  await window.weiboApp.groups.delete(id);
  await refreshAll();
}

function togglePostAccount(id: number): void {
  selectedPostAccountIds.value = selectedPostAccountIds.value.includes(id)
    ? selectedPostAccountIds.value.filter((accountId) => accountId !== id)
    : [...selectedPostAccountIds.value, id];
}

function localDateTimeToIso(value: string): string | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeSharedLink(rawUrl: string): string {
  const url = rawUrl.replace(/[，。；、,.;!?！？）)\]】>》"'“”‘’]+$/g, '');
  if (/pan\.baidu\.com/i.test(url)) {
    return `D:${url}`;
  }
  if (/pan\.quark\.cn/i.test(url)) {
    return `K:${url}`;
  }
  return url;
}

function extractCommentLinks(value: string): string[] {
  const matches = value.match(/https?:\/\/[^\s<>"'，。；、]+/gi) || [];
  return Array.from(new Set(matches.map((url) => normalizeSharedLink(url))));
}

function appendToFirstComment(value: string): void {
  const nextValue = value.trim();
  if (!nextValue) {
    return;
  }
  autoCommentEnabled.value = true;
  commentContent.value = commentContent.value.trim()
    ? `${commentContent.value.trim()}\n${nextValue}`
    : nextValue;
}

function appendExtractedLinksToFirstComment(): void {
  appendToFirstComment(extractedCommentLinks.value.join('\n'));
}

async function createPostTasks(): Promise<void> {
  errorMessage.value = '';
  const content = cleanPostContent(postContent.value);
  const topics = Array.from(new Set(Array.from(content.matchAll(/#([^#\s]{1,30})#/g)).map((match) => normalizeTopic(match[1]))));
  const nextScheduledAt = localDateTimeToIso(scheduledAt.value);
  const payload: CreatePostPayload = {
    accountIds: selectedPostAccountIds.value.map((id) => Number(id)),
    content,
    topics,
    images: postImages.value.map((image) => String(image)),
    autoCommentEnabled: Boolean(autoCommentEnabled.value),
    commentContent: String(commentContent.value),
    commentDelaySeconds: Number(commentDelaySeconds.value) || 0,
    commentAccountId: autoCommentEnabled.value ? commentAccountId.value : null,
    replyCommentEnabled: Boolean(autoCommentEnabled.value && replyCommentEnabled.value),
    replyCommentContent: String(replyCommentContent.value),
    replyCommentDelaySeconds: Number(replyCommentDelaySeconds.value) || 0,
    replyCommentAccountId: autoCommentEnabled.value && replyCommentEnabled.value ? replyCommentAccountId.value : null,
    scheduledAt: nextScheduledAt
  };
  try {
    const tasks = await window.weiboApp.posts.createBatch(payload);
    postContent.value = '';
    postTopics.value = '';
    postImages.value = [];
    commentContent.value = '';
    commentDelaySeconds.value = 0;
    commentAccountId.value = null;
    linkExtractInput.value = '';
    replyCommentEnabled.value = false;
    replyCommentContent.value = '';
    replyCommentDelaySeconds.value = 0;
    replyCommentAccountId.value = null;
    scheduledAt.value = '';
    autoCommentEnabled.value = false;
    for (const task of tasks.filter((item) => item.account_id && !item.scheduled_at)) {
      await window.weiboApp.posts.autoPublish(task.id);
    }
    await refreshAll();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '创建发帖任务失败';
  }
}

async function startManualTask(task: PostTask): Promise<void> {
  errorMessage.value = '';
  try {
    const startedTask = await window.weiboApp.posts.start(task.id);
    activeManualTask.value = startedTask;
    completionWeiboUrl.value = startedTask.weibo_url || '';
    completionWeiboId.value = startedTask.weibo_id || '';
    failReason.value = '';
    if (startedTask.account_id) {
      await selectAccount(startedTask.account_id);
    }
    await refreshAll();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '开始任务失败';
  }
}

function openManualTask(task: PostTask): void {
  activeManualTask.value = task;
  completionWeiboUrl.value = task.weibo_url || '';
  completionWeiboId.value = task.weibo_id || '';
  failReason.value = task.error_message || '';
}

async function completeManualTask(): Promise<void> {
  if (!activeManualTask.value) {
    return;
  }
  errorMessage.value = '';
  try {
    await window.weiboApp.posts.complete({
      taskId: activeManualTask.value.id,
      weiboUrl: completionWeiboUrl.value,
      weiboId: completionWeiboId.value || undefined
    });
    activeManualTask.value = null;
    completionWeiboUrl.value = '';
    completionWeiboId.value = '';
    await refreshAll();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '完成任务失败';
  }
}

async function failManualTask(): Promise<void> {
  if (!activeManualTask.value) {
    return;
  }
  errorMessage.value = '';
  try {
    await window.weiboApp.posts.fail({
      taskId: activeManualTask.value.id,
      errorMessage: failReason.value
    });
    activeManualTask.value = null;
    failReason.value = '';
    await refreshAll();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '标记失败失败';
  }
}

async function startCommentTask(task: CommentTask): Promise<void> {
  errorMessage.value = '';
  try {
    const result = await window.weiboApp.comments.autoPublish(task.id);
    if (result.status === 'failed') {
      throw new Error(result.errorMessage || '自动评论失败');
    }
    activeCommentTask.value = null;
    commentFailReason.value = '';
    await refreshAll();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '开始评论任务失败';
  }
}

function openCommentTask(task: CommentTask): void {
  activeCommentTask.value = task;
  commentFailReason.value = task.error_message || '';
}

async function completeCommentTask(): Promise<void> {
  if (!activeCommentTask.value) {
    return;
  }
  errorMessage.value = '';
  try {
    await window.weiboApp.comments.complete({ taskId: activeCommentTask.value.id });
    activeCommentTask.value = null;
    await refreshAll();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '完成评论任务失败';
  }
}

async function failCommentTask(): Promise<void> {
  if (!activeCommentTask.value) {
    return;
  }
  errorMessage.value = '';
  try {
    await window.weiboApp.comments.fail({
      taskId: activeCommentTask.value.id,
      errorMessage: commentFailReason.value
    });
    activeCommentTask.value = null;
    commentFailReason.value = '';
    await refreshAll();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '标记评论失败失败';
  }
}

async function skipCommentTask(task: CommentTask): Promise<void> {
  errorMessage.value = '';
  try {
    await window.weiboApp.comments.skip(task.id);
    if (activeCommentTask.value?.id === task.id) {
      activeCommentTask.value = null;
    }
    await refreshAll();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '跳过评论任务失败';
  }
}

async function copyText(text: string | null): Promise<void> {
  if (!text) {
    return;
  }
  await navigator.clipboard.writeText(text);
}

function selectGroupForPost(groupId: number): void {
  const ids = accounts.value.filter((account) => account.group_id === groupId && account.status !== 'expired').map((account) => account.id);
  selectedPostAccountIds.value = Array.from(new Set([...selectedPostAccountIds.value, ...ids]));
}

let superTopicSearchTimer: number | null = null;

onMounted(() => {
  refreshAll();
  window.weiboApp.accounts.onLoginWindowClosed(async () => {
    if (selectedAccountId.value) {
      await window.weiboApp.accounts.syncProfile(selectedAccountId.value);
    }
    await refreshAll();
    accountViewVersion.value += 1;
    scheduleLoggedInProfileSync();
  });
  window.weiboApp.posts.onScheduledTaskUpdated(() => {
    refreshAll();
  });
  window.setInterval(() => {
    if (activePage.value === 'accounts' && needsProfileSync()) {
      scheduleLoggedInProfileSync();
    }
  }, 5000);
});

watch(
  selectedAccount,
  (account) => {
    document.title = account ? `${accountTabTitle(account)} - 微博账号管理` : '微博账号管理';
  },
  { immediate: true }
);

watch([superTopicSearch, activeSuperTopicTab], () => {
  if (!superTopicPickerOpen.value) {
    return;
  }
  if (superTopicSearchTimer) {
    window.clearTimeout(superTopicSearchTimer);
  }
  superTopicSearchTimer = window.setTimeout(() => {
    void refreshSuperTopicResults();
  }, 220);
});
</script>

<template>
  <main class="app-shell">
    <aside class="sidebar">
      <div class="brand">
        <ShieldCheck :size="24" />
        <div>
          <strong>微博账号管理</strong>
          <span>本地桌面端</span>
        </div>
      </div>

      <nav class="nav-list" aria-label="主导航">
        <button
          v-for="page in pages"
          :key="page.key"
          class="nav-item"
          :class="{ active: activePage === page.key }"
          type="button"
          @click="activePage = page.key"
        >
          <component :is="page.icon" :size="18" />
          <span>{{ page.label }}</span>
        </button>
      </nav>

      <button class="ghost-button refresh-button" type="button" @click="refreshAllAndSyncSelected">
        <RefreshCw :size="16" />
        <span>刷新数据</span>
      </button>
    </aside>

    <section class="workspace">
      <header class="topbar">
        <div>
          <p class="eyebrow">MVP 工作台</p>
          <h1>{{ pages.find((page) => page.key === activePage)?.label }}</h1>
        </div>
        <div class="topbar-status">
          <Loader2 v-if="loading" class="spin" :size="18" />
          <span>{{ accounts.length }} 个账号</span>
        </div>
      </header>

      <div v-if="errorMessage" class="notice error">{{ errorMessage }}</div>

      <section v-if="activePage === 'home'" class="page-grid">
        <article class="metric" v-for="metric in [
          ['账号总数', dashboard?.totalAccounts ?? 0],
          ['在线账号', dashboard?.onlineAccounts ?? 0],
          ['离线账号', dashboard?.offlineAccounts ?? 0],
          ['登录失效', dashboard?.expiredAccounts ?? 0],
          ['发帖总数', dashboard?.totalPosts ?? 0],
          ['评论总数', dashboard?.totalComments ?? 0],
          ['今日发帖', dashboard?.todayPosts ?? 0],
          ['今日评论', dashboard?.todayComments ?? 0],
          ['失败任务', dashboard?.failedTasks ?? 0]
        ]" :key="metric[0]">
          <span>{{ metric[0] }}</span>
          <strong>{{ metric[1] }}</strong>
        </article>

        <section class="panel wide">
          <div class="panel-title">
            <Activity :size="18" />
            <h2>最近任务</h2>
          </div>
          <div class="table-scroll table-scroll-compact">
            <table>
              <thead>
                <tr>
                  <th>账号</th>
                  <th>状态</th>
                  <th>正文</th>
                  <th>发布时间</th>
                  <th>创建时间</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="task in postTasks.slice(0, 12)" :key="task.id">
                  <td>{{ task.account_nickname || '-' }}</td>
                  <td><span class="status-pill">{{ task.status }}</span></td>
                  <td class="truncate" :title="task.content">{{ task.content }}</td>
                  <td>{{ task.scheduled_at || '立即' }}</td>
                  <td>{{ task.created_at }}</td>
                </tr>
                <tr v-if="postTasks.length === 0">
                  <td colspan="5" class="empty">暂无任务</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section class="panel wide">
          <div class="panel-title">
            <MessageCircle :size="18" />
            <h2>评论任务</h2>
          </div>
          <section v-if="activeCommentTask" class="execution-panel comment-execution">
            <div>
              <p class="eyebrow">当前评论任务</p>
              <h3>{{ activeCommentTask.account_nickname || `账号 ${activeCommentTask.account_id}` }}</h3>
              <span class="status-pill">{{ activeCommentTask.status }}</span>
            </div>
            <div class="execution-content">
              <label>
                <span>微博链接</span>
                <input :value="activeCommentTask.weibo_url || ''" readonly />
              </label>
              <label>
                <span>评论内容</span>
                <textarea :value="activeCommentTask.comment_content" readonly />
              </label>
              <div class="execution-actions">
                <button class="ghost-button" type="button" @click="copyText(activeCommentTask.weibo_url)">
                  复制链接
                </button>
                <button class="ghost-button" type="button" @click="copyText(activeCommentTask.comment_content)">
                  复制评论
                </button>
                <button class="primary-button" type="button" @click="completeCommentTask">完成评论</button>
              </div>
              <div class="result-grid fail-grid">
                <input v-model="commentFailReason" placeholder="评论失败原因" />
                <button class="danger-button text-danger-button" type="button" @click="failCommentTask">标记失败</button>
              </div>
            </div>
          </section>
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>账号</th>
                  <th>状态</th>
                  <th>微博链接</th>
                  <th>评论内容</th>
                  <th>重试</th>
                  <th>发布时间</th>
                  <th>创建时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="task in commentTasks" :key="task.id">
                  <td>{{ task.account_nickname || '-' }}</td>
                  <td><span class="status-pill">{{ task.status }}</span></td>
                  <td class="truncate" :title="task.weibo_url || '-'">{{ task.weibo_url || '-' }}</td>
                  <td class="truncate" :title="task.comment_content">{{ task.comment_content }}</td>
                  <td>{{ task.retry_count }}/{{ task.max_retry_count }}</td>
                  <td>{{ task.created_at }}</td>
                  <td class="row-actions">
                    <button
                      v-if="task.status === 'pending' || task.status === 'failed'"
                      class="ghost-button compact-button"
                      type="button"
                      @click="startCommentTask(task)"
                    >
                      开始
                    </button>
                    <button
                      v-else-if="task.status === 'running'"
                      class="ghost-button compact-button"
                      type="button"
                      @click="openCommentTask(task)"
                    >
                      继续
                    </button>
                    <button
                      v-if="task.status === 'pending'"
                      class="ghost-button compact-button"
                      type="button"
                      @click="skipCommentTask(task)"
                    >
                      跳过
                    </button>
                    <span v-if="task.status === 'success' || task.status === 'skipped'" class="muted">完成</span>
                  </td>
                </tr>
                <tr v-if="commentTasks.length === 0">
                  <td colspan="7" class="empty">暂无评论任务</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      </section>

      <section v-if="activePage === 'accounts'" class="account-workspace" :class="{ 'account-workspace-collapsed': accountPanelCollapsed }">
        <section class="panel account-panel">
          <div class="panel-title">
            <Users :size="18" />
            <h2 v-if="!accountPanelCollapsed">账号列表</h2>
            <button
              class="icon-button collapse-button"
              type="button"
              :title="accountPanelCollapsed ? '展开账号栏' : '折叠账号栏'"
              @click="accountPanelCollapsed = !accountPanelCollapsed"
            >
              <ChevronDown :size="18" />
            </button>
            <div v-if="!accountPanelCollapsed" class="account-add-wrap">
              <button class="icon-button" type="button" title="添加账号" @click="accountPlatformMenuOpen = !accountPlatformMenuOpen">
                <Plus :size="18" />
              </button>
              <div v-if="accountPlatformMenuOpen" class="account-platform-menu">
                <button type="button" @click="addAccount('weibo')">
                  <span class="platform-dot weibo">微</span>
                  <span>新浪微博</span>
                </button>
                <button type="button" @click="addAccount('baidu_pan')">
                  <span class="platform-dot baidu">网</span>
                  <span>百度网盘</span>
                </button>
              </div>
            </div>
          </div>

          <div v-if="accountPanelCollapsed" class="collapsed-account-hint">
            <Users :size="20" />
            <span>{{ accounts.length }}</span>
          </div>

          <template v-else>
          <div class="account-summary">
            <div>
              <strong>{{ accounts.length }}</strong>
              <span>总账号</span>
            </div>
            <div>
              <strong>{{ onlineAccounts.length }}</strong>
              <span>在线</span>
            </div>
            <div>
              <strong>{{ dashboard?.expiredAccounts ?? 0 }}</strong>
              <span>失效</span>
            </div>
          </div>

          <div class="account-filters">
            <input v-model="accountSearch" placeholder="搜索昵称、UID、分组" />
            <select v-model="accountStatusFilter">
              <option value="all">全部状态</option>
              <option v-for="status in accountStatusOptions" :key="status" :value="status">{{ statusText[status] }}</option>
            </select>
          </div>

          <div class="account-list">
            <button
              v-for="account in filteredAccounts"
              :key="account.id"
              type="button"
              class="account-row"
              :class="{ selected: selectedAccountId === account.id }"
              @click="selectAccount(account.id)"
            >
              <div class="avatar-wrap">
                <img v-if="account.avatar" class="avatar image-avatar" :src="account.avatar" alt="" />
                <div v-else class="avatar">{{ (account.nickname || '微').slice(0, 1) }}</div>
                <span class="weibo-badge" :class="{ baidu: accountPlatform(account) === 'baidu_pan' }" :aria-label="platformText[accountPlatform(account)]">
                  {{ accountPlatform(account) === 'baidu_pan' ? '网' : '微' }}
                </span>
              </div>
              <div class="account-row-body">
                <strong>{{ accountDisplayName(account) }}</strong>
                <span class="account-platform-line">
                  <span>{{ platformText[accountPlatform(account)] }}</span>
                  <span>{{ account.group_name || '未分组' }} · {{ accountStatusLabel(account) }}</span>
                </span>
              </div>
            </button>
            <p v-if="accounts.length === 0" class="empty">还没有账号，点击右上角添加微博或百度网盘。</p>
            <p v-else-if="filteredAccounts.length === 0" class="empty">没有匹配的账号。</p>
          </div>

          <div v-if="selectedAccount" class="account-quick-actions">
            <span class="account-actions-title">账号管理</span>
            <button class="ghost-button" type="button" @click="openLoginWindow(selectedAccount.id)">人工登录</button>
            <button class="danger-button delete-account-button" type="button" @click="deleteAccount(selectedAccount.id)">
              <Trash2 :size="16" />
              <span>删除账号</span>
            </button>
          </div>
          </template>
        </section>

        <section class="browser-panel">
          <div class="browser-header">
            <div v-if="selectedAccount" class="browser-account-title">
              <span>{{ accountTabTitle(selectedAccount) }}</span>
              <span class="browser-platform">{{ platformText[accountPlatform(selectedAccount)] }}</span>
            </div>
            <span v-else>未选择账号</span>
            <span>{{ selectedAccount ? accountStatusLabel(selectedAccount) : '' }}</span>
          </div>
          <div v-if="selectedAccount" class="browser-toolbar">
            <button class="tool-button" type="button" title="后退" @click="goBrowserBack">
              <ArrowLeft :size="18" />
            </button>
            <button class="tool-button" type="button" title="前进" @click="goBrowserForward">
              <ArrowRight :size="18" />
            </button>
            <button class="tool-button" type="button" title="刷新" @click="reloadBrowser">
              <RefreshCw :size="17" />
            </button>
            <input
              v-model="browserUrl"
              class="address-input"
              @keyup.enter="loadBrowserUrl"
              @blur="loadBrowserUrl"
            />
            <button class="toolbar-text-button" type="button" @click="clearSelectedAccountCache">
              <Eraser :size="15" />
              <span>清除缓存</span>
            </button>
            <button class="toolbar-text-button" type="button" @click="copyBrowserLink">
              <Copy :size="15" />
              <span>复制链接</span>
            </button>
          </div>
          <webview
            v-if="selectedAccount && selectedPartition"
            :key="`${selectedAccount.id}-${selectedPartition}-${accountViewVersion}`"
            class="weibo-webview"
            :src="accountHomeUrl(selectedAccount)"
            :partition="selectedPartition"
            allowpopups
            @did-stop-loading="scheduleLoggedInProfileSync"
            @dom-ready="scheduleLoggedInProfileSync"
            @did-navigate="updateBrowserUrl"
            @did-navigate-in-page="updateBrowserUrl"
          />
          <div v-else class="browser-empty">选择或添加账号后，这里会显示对应平台页面。</div>
        </section>
      </section>

      <section v-if="activePage === 'posts'" class="post-layout">
        <section class="panel">
          <div class="panel-title">
            <Users :size="18" />
            <h2>选择账号</h2>
          </div>
          <div class="group-chips">
            <button v-for="group in groups" :key="group.id" type="button" @click="selectGroupForPost(group.id)">
              {{ group.name }}
            </button>
          </div>
          <div class="checkbox-list">
            <label v-for="account in postableAccounts" :key="account.id">
              <input
                type="checkbox"
                :checked="selectedPostAccountIds.includes(account.id)"
                @change="togglePostAccount(account.id)"
              />
              <span>{{ account.nickname || accountFallbackName(account) }}</span>
              <small>{{ statusText[account.status] }}</small>
            </label>
          </div>
        </section>

        <section class="panel composer-panel">
          <div class="panel-title">
            <Send :size="18" />
            <h2>创建发帖任务</h2>
          </div>
          <div class="weibo-composer">
            <textarea
              ref="postTextarea"
              v-model="postContent"
              maxlength="2000"
              placeholder="有什么新鲜事想分享给大家？"
              @input="updateTopicSuggestions"
              @keyup="updateTopicSuggestions"
              @click="updateTopicSuggestions"
            />
            <div v-if="topicMenuOpen" class="topic-suggestion-menu">
              <span>{{ topicSuggesting ? '正在查找话题' : '想用什么话题' }}</span>
              <button v-for="topic in liveTopicSuggestions" :key="topic" type="button" @click="applyTopicSuggestion(topic)">
                {{ topic }}
              </button>
            </div>
            <div v-if="postImages.length" class="image-preview-list">
              <div v-for="image in postImages" :key="image" class="image-preview-item">
                <span>{{ image.split(/[\\/]/).pop() }}</span>
                <button type="button" @click="removePostImage(image)">移除</button>
              </div>
            </div>
            <div class="weibo-toolstrip">
              <button type="button" title="图片" @click="openImagePicker">
                <ImageIcon :size="18" />
                <span>图片</span>
              </button>
              <button type="button" title="话题" @click="insertPostToken('#')">
                <Hash :size="18" />
                <span>话题</span>
              </button>
            </div>
          </div>
          <div class="supertopic-picker-wrap">
            <button class="ghost-button supertopic-trigger" type="button" @click="toggleSuperTopicPicker">
              <Plus :size="16" />
              <span>选择超话</span>
            </button>
            <div v-if="superTopicPickerOpen" class="supertopic-panel">
              <input
                v-model="superTopicSearch"
                class="supertopic-search-input"
                placeholder="搜索超话"
                @keydown.enter.prevent="superTopicResults[0] && selectSuperTopic(superTopicResults[0])"
              />
              <div class="supertopic-tabs">
                <button
                  v-for="tab in superTopicTabs"
                  :key="tab.key"
                  type="button"
                  :class="{ active: activeSuperTopicTab === tab.key }"
                  @click="activeSuperTopicTab = tab.key"
                >
                  {{ tab.label }}
                </button>
              </div>
              <div class="supertopic-info">发布未关注超话时，系统会自动关注所选超话</div>
              <div class="supertopic-list">
                <button v-for="topic in superTopicResults" :key="topic" type="button" @click="selectSuperTopic(topic)">
                  <span class="supertopic-cover">{{ normalizeSuperTopic(topic).slice(0, 1) || '超' }}</span>
                  <span class="supertopic-detail">
                    <strong>{{ normalizeSuperTopic(topic).replace(/\[超话\]$/, '') }}</strong>
                    <small>{{ superTopicLoading ? '搜索中' : '新浪微博超话' }}</small>
                  </span>
                </button>
              </div>
            </div>
          </div>
          <div class="composer-meta composer-meta-count">
            <span>{{ postContent.length }} 字</span>
          </div>
          <div v-if="composedTopics.length" class="selected-topics">
            <span v-for="topic in composedTopics" :key="topic">#{{ topic }}#</span>
          </div>
          <label class="switch-row">
            <input v-model="autoCommentEnabled" type="checkbox" />
            <span>发帖成功后自动评论</span>
          </label>
          <label class="field-row">
            <span>指定发布时间</span>
            <input v-model="scheduledAt" type="datetime-local" />
          </label>
          <div v-if="autoCommentEnabled" class="comment-settings">
            <textarea v-model="commentContent" placeholder="评论内容" rows="4" />
            <div class="link-extractor">
              <textarea v-model="linkExtractInput" placeholder="粘贴网盘分享文案，自动提取 http 链接" rows="3" />
              <div v-if="extractedCommentLinks.length" class="extracted-link-list">
                <button
                  v-for="link in extractedCommentLinks"
                  :key="link"
                  class="ghost-button compact-button"
                  type="button"
                  @click="appendToFirstComment(link)"
                >
                  {{ link }}
                </button>
                <button class="primary-button compact-button" type="button" @click="appendExtractedLinksToFirstComment">
                  全部加入评论
                </button>
              </div>
            </div>
            <input v-model.number="commentDelaySeconds" min="0" type="number" />
            <select v-model.number="commentAccountId">
              <option :value="null">默认发帖账号评论</option>
              <option v-for="account in commentableAccounts" :key="account.id" :value="account.id">
                {{ account.nickname || accountFallbackName(account) }}
              </option>
            </select>
            <label class="switch-row comment-reply-toggle">
              <input v-model="replyCommentEnabled" type="checkbox" />
              <span>评论后继续回复这条评论</span>
            </label>
            <template v-if="replyCommentEnabled">
              <textarea v-model="replyCommentContent" placeholder="回复评论内容" rows="3" />
              <input v-model.number="replyCommentDelaySeconds" min="0" type="number" />
              <select v-model.number="replyCommentAccountId">
                <option :value="null">默认使用评论账号回复</option>
                <option v-for="account in commentableAccounts" :key="account.id" :value="account.id">
                  {{ account.nickname || accountFallbackName(account) }}
                </option>
              </select>
            </template>
          </div>
          <button class="primary-button" type="button" @click="createPostTasks">
            <Send :size="16" />
            <span>创建任务</span>
          </button>
        </section>

        <section class="panel wide">
          <div class="panel-title">
            <ClipboardList :size="18" />
            <h2>发帖任务</h2>
          </div>
          <section v-if="activeManualTask" class="execution-panel">
            <div>
              <p class="eyebrow">当前执行任务</p>
              <h3>{{ activeManualTask.account_nickname || `账号 ${activeManualTask.account_id}` }}</h3>
            </div>
            <div class="execution-content">
              <label>
                <span>微博正文</span>
                <textarea :value="activeManualTask.content" readonly />
              </label>
              <div class="execution-actions">
                <button class="ghost-button" type="button" @click="copyText(activeManualTask.content)">
                  复制正文
                </button>
                <button
                  v-if="activeManualTask.comment_content"
                  class="ghost-button"
                  type="button"
                  @click="copyText(activeManualTask.comment_content)"
                >
                  复制评论
                </button>
              </div>
              <div class="result-grid">
                <input v-model="completionWeiboUrl" placeholder="发布成功后的微博链接" />
                <input v-model="completionWeiboId" placeholder="微博 ID，可选" />
                <button class="primary-button" type="button" @click="completeManualTask">完成</button>
              </div>
              <div class="result-grid fail-grid">
                <input v-model="failReason" placeholder="失败原因" />
                <button class="danger-button text-danger-button" type="button" @click="failManualTask">标记失败</button>
              </div>
            </div>
          </section>
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>账号</th>
                  <th>状态</th>
                  <th>评论</th>
                  <th>正文</th>
                  <th>发布时间</th>
                  <th>创建时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="task in postTasks" :key="task.id">
                  <td>{{ task.account_nickname || '-' }}</td>
                  <td><span class="status-pill">{{ task.status }}</span></td>
                  <td>{{ task.auto_comment_enabled ? (task.comment_account_nickname || '默认发帖号') : '关闭' }}</td>
                  <td class="truncate" :title="task.content">{{ task.content }}</td>
                  <td>{{ task.scheduled_at || '立即' }}</td>
                  <td>{{ task.created_at }}</td>
                  <td>
                    <button
                      v-if="task.status === 'pending' || task.status === 'failed'"
                      class="ghost-button compact-button"
                      type="button"
                      @click="startManualTask(task)"
                    >
                      开始
                    </button>
                    <button
                      v-else-if="task.status === 'running'"
                      class="ghost-button compact-button"
                      type="button"
                      @click="openManualTask(task)"
                    >
                      继续
                    </button>
                    <span v-else class="muted">完成</span>
                  </td>
                </tr>
                <tr v-if="postTasks.length === 0">
                  <td colspan="7" class="empty">暂无发帖任务</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      </section>

      <section v-if="activePage === 'groups'" class="page-grid">
        <section class="panel">
          <div class="panel-title">
            <FolderTree :size="18" />
            <h2>新建分组</h2>
          </div>
          <input v-model="groupName" placeholder="分组名称" />
          <input v-model="groupRemark" placeholder="备注" />
          <button class="primary-button" type="button" @click="createGroup">
            <Plus :size="16" />
            <span>创建分组</span>
          </button>
        </section>

        <section class="panel wide">
          <div class="panel-title">
            <FolderTree :size="18" />
            <h2>分组列表</h2>
          </div>
          <div class="group-list">
            <div v-for="group in groups" :key="group.id" class="group-row">
              <div class="group-row-header">
                <button class="group-title-button" type="button" @click="toggleGroupPanel(group.id)">
                  <ChevronDown :size="16" :class="{ expanded: expandedGroupIds.includes(group.id) }" />
                  <span>
                    <strong>{{ group.name }}</strong>
                    <small>{{ group.account_count || 0 }} 个账号 · {{ group.remark || '无备注' }}</small>
                  </span>
                </button>
                <button class="danger-button" type="button" @click="deleteGroup(group.id)">
                  <Trash2 :size="16" />
                </button>
              </div>
              <div v-if="expandedGroupIds.includes(group.id)" class="group-account-manager">
                <p class="eyebrow">添加账号到分组</p>
                <label v-for="account in accounts" :key="account.id" class="group-account-option">
                  <input
                    type="checkbox"
                    :checked="account.group_id === group.id"
                    @change="toggleAccountGroup(account, group.id, ($event.target as HTMLInputElement).checked)"
                  />
                  <img v-if="account.avatar" :src="account.avatar" alt="" />
                  <span v-else class="avatar-fallback">微</span>
                  <span>
                    <strong>{{ accountDisplayName(account) }}</strong>
                    <small>{{ account.group_name || '未分组' }} · {{ accountStatusLabel(account) }}</small>
                  </span>
                </label>
                <p v-if="accounts.length === 0" class="empty">暂无账号</p>
              </div>
            </div>
            <p v-if="groups.length === 0" class="empty">暂无分组</p>
          </div>
        </section>
      </section>

      <section v-if="activePage === 'logs'" class="panel wide">
        <div class="panel-title">
          <MessageCircle :size="18" />
          <h2>操作日志</h2>
        </div>
        <div class="table-scroll table-scroll-tall">
          <table>
            <thead>
              <tr>
                <th>时间</th>
                <th>账号</th>
                <th>类型</th>
                <th>状态</th>
                <th>内容</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="log in logs" :key="log.id">
                <td>{{ log.created_at }}</td>
                <td>{{ log.account_nickname || '-' }}</td>
                <td>{{ log.type }}</td>
                <td><span class="status-pill">{{ log.status }}</span></td>
                <td class="truncate" :title="log.message">{{ log.message }}</td>
              </tr>
              <tr v-if="logs.length === 0">
                <td colspan="5" class="empty">暂无日志</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </section>
  </main>
</template>
