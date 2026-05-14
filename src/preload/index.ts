import { contextBridge, ipcRenderer } from 'electron';
import type {
  AccountGroup,
  AccountPlatform,
  AccountStatus,
  AutoCommentResult,
  AutoPublishResult,
  CommentTask,
  CompleteCommentPayload,
  CompletePostPayload,
  CreatePostPayload,
  DashboardStats,
  FailCommentPayload,
  FailPostPayload,
  OperationLog,
  PostTask,
  UpdateAccountPayload,
  WeiboAccount
} from '../shared/types';

const api = {
  dashboard: {
    get: (): Promise<DashboardStats> => ipcRenderer.invoke('dashboard:get')
  },
  topics: {
    suggest: (keyword: string, accountId: number | null): Promise<string[]> =>
      ipcRenderer.invoke('topic:suggest', keyword, accountId)
  },
  media: {
    selectImages: (): Promise<string[]> => ipcRenderer.invoke('media:select-images')
  },
  accounts: {
    list: (): Promise<WeiboAccount[]> => ipcRenderer.invoke('account:list'),
    create: (platform: AccountPlatform = 'weibo'): Promise<WeiboAccount> => ipcRenderer.invoke('account:create', platform),
    updateProfile: (payload: UpdateAccountPayload): Promise<WeiboAccount> => ipcRenderer.invoke('account:update-profile', payload),
    syncProfile: (id: number): Promise<WeiboAccount> => ipcRenderer.invoke('account:sync-profile', id),
    updateStatus: (id: number, status: AccountStatus): Promise<WeiboAccount> =>
      ipcRenderer.invoke('account:update-status', id, status),
    updateGroup: (accountId: number, groupId: number | null): Promise<WeiboAccount> =>
      ipcRenderer.invoke('account:update-group', accountId, groupId),
    delete: (id: number): Promise<boolean> => ipcRenderer.invoke('account:delete', id),
    getPartition: (id: number): Promise<string> => ipcRenderer.invoke('account:get-partition', id),
    clearCache: (id: number): Promise<boolean> => ipcRenderer.invoke('account:clear-cache', id),
    openLoginWindow: (id: number): Promise<boolean> => ipcRenderer.invoke('account:open-login-window', id),
    onLoginWindowClosed: (callback: (id: number) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, id: number): void => callback(id);
      ipcRenderer.on('account:login-window-closed', listener);
      return () => ipcRenderer.removeListener('account:login-window-closed', listener);
    }
  },
  groups: {
    list: (): Promise<AccountGroup[]> => ipcRenderer.invoke('group:list'),
    create: (name: string, remark: string | null): Promise<AccountGroup> => ipcRenderer.invoke('group:create', name, remark),
    update: (id: number, name: string, remark: string | null): Promise<AccountGroup> =>
      ipcRenderer.invoke('group:update', id, name, remark),
    delete: (id: number): Promise<boolean> => ipcRenderer.invoke('group:delete', id)
  },
  posts: {
    createBatch: (payload: CreatePostPayload): Promise<PostTask[]> => ipcRenderer.invoke('post:create-batch', payload),
    list: (): Promise<PostTask[]> => ipcRenderer.invoke('post:list'),
    autoPublish: (taskId: number): Promise<AutoPublishResult> => ipcRenderer.invoke('post:auto-publish', taskId),
    start: (taskId: number): Promise<PostTask> => ipcRenderer.invoke('post:start', taskId),
    complete: (payload: CompletePostPayload): Promise<PostTask> => ipcRenderer.invoke('post:complete', payload),
    fail: (payload: FailPostPayload): Promise<PostTask> => ipcRenderer.invoke('post:fail', payload),
    onScheduledTaskUpdated: (callback: (taskId: number) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, taskId: number): void => callback(taskId);
      ipcRenderer.on('post:scheduled-task-updated', listener);
      return () => ipcRenderer.removeListener('post:scheduled-task-updated', listener);
    }
  },
  comments: {
    list: (): Promise<CommentTask[]> => ipcRenderer.invoke('comment:list'),
    autoPublish: (taskId: number): Promise<AutoCommentResult> => ipcRenderer.invoke('comment:auto-publish', taskId),
    start: (taskId: number): Promise<CommentTask> => ipcRenderer.invoke('comment:start', taskId),
    complete: (payload: CompleteCommentPayload): Promise<CommentTask> => ipcRenderer.invoke('comment:complete', payload),
    fail: (payload: FailCommentPayload): Promise<CommentTask> => ipcRenderer.invoke('comment:fail', payload),
    skip: (taskId: number): Promise<CommentTask> => ipcRenderer.invoke('comment:skip', taskId)
  },
  logs: {
    list: (): Promise<OperationLog[]> => ipcRenderer.invoke('log:list')
  }
};

contextBridge.exposeInMainWorld('weiboApp', api);

export type WeiboAppApi = typeof api;
