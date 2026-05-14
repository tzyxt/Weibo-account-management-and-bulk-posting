import type Database from 'better-sqlite3';
import { app } from 'electron';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type {
  AccountGroup,
  AccountStatus,
  CommentTask,
  CompleteCommentPayload,
  CompletePostPayload,
  CreatePostPayload,
  DashboardStats,
  FailCommentPayload,
  FailPostPayload,
  LogStatus,
  LogType,
  OperationLog,
  PostTask,
  AccountPlatform,
  UpdateAccountPayload,
  WeiboAccount
} from '../../shared/types';

const now = (): string => new Date().toISOString();
const require = createRequire(import.meta.url);
const BetterSqlite3 = require('better-sqlite3') as typeof Database;

export class AppDatabase {
  private readonly db: Database.Database;
  private readonly dataRoot: string;

  constructor() {
    this.dataRoot = join(app.getPath('userData'), 'weibo-account-manager');
    const dbPath = join(this.dataRoot, 'data', 'app.sqlite');
    mkdirSync(dirname(dbPath), { recursive: true });
    mkdirSync(join(this.dataRoot, 'profiles'), { recursive: true });
    mkdirSync(join(this.dataRoot, 'uploads'), { recursive: true });
    this.db = new BetterSqlite3(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  getProfilePath(accountId: number, platform: AccountPlatform = 'weibo'): string {
    return join(this.dataRoot, 'profiles', `${platform}_account_${accountId}`);
  }

  getPartition(accountId: number): string {
    const account = this.getAccount(accountId);
    return `persist:${account.platform || 'weibo'}_account_${accountId}`;
  }

  getDashboard(): DashboardStats {
    const one = <T>(sql: string, params: unknown[] = []): T => this.db.prepare(sql).get(...params) as T;
    const today = new Date().toISOString().slice(0, 10);

    return {
      totalAccounts: one<{ count: number }>('SELECT COUNT(*) AS count FROM weibo_account').count,
      onlineAccounts: one<{ count: number }>(
        "SELECT COUNT(*) AS count FROM weibo_account WHERE status = 'online'"
      ).count,
      offlineAccounts: one<{ count: number }>(
        "SELECT COUNT(*) AS count FROM weibo_account WHERE status IN ('not_logged_in', 'offline')"
      ).count,
      expiredAccounts: one<{ count: number }>(
        "SELECT COUNT(*) AS count FROM weibo_account WHERE status = 'expired'"
      ).count,
      totalPosts: one<{ count: number }>("SELECT COUNT(*) AS count FROM post_task WHERE status = 'success' AND account_id IS NOT NULL")
        .count,
      totalComments: one<{ count: number }>(
        "SELECT COUNT(*) AS count FROM comment_task WHERE status = 'success'"
      ).count,
      todayPosts: one<{ count: number }>(
        "SELECT COUNT(*) AS count FROM post_task WHERE status = 'success' AND account_id IS NOT NULL AND finished_at LIKE ?",
        [`${today}%`]
      ).count,
      todayComments: one<{ count: number }>(
        "SELECT COUNT(*) AS count FROM comment_task WHERE status = 'success' AND finished_at LIKE ?",
        [`${today}%`]
      ).count,
      failedTasks:
        one<{ count: number }>("SELECT COUNT(*) AS count FROM post_task WHERE status = 'failed' AND account_id IS NOT NULL").count +
        one<{ count: number }>("SELECT COUNT(*) AS count FROM comment_task WHERE status = 'failed'").count
    };
  }

  listAccounts(): WeiboAccount[] {
    return this.db
      .prepare(
        `SELECT a.*, g.name AS group_name
         FROM weibo_account a
         LEFT JOIN account_group g ON g.id = a.group_id
         ORDER BY a.updated_at DESC`
      )
      .all() as WeiboAccount[];
  }

  createAccount(platform: AccountPlatform = 'weibo'): WeiboAccount {
    const timestamp = now();
    const nickname = platform === 'baidu_pan' ? '新百度网盘账号' : null;
    const insert = this.db.prepare(
      `INSERT INTO weibo_account
       (platform, uid, nickname, avatar, status, group_id, profile_path, encrypted_cookie, created_at, updated_at)
       VALUES (?, NULL, ?, NULL, 'not_logged_in', NULL, ?, NULL, ?, ?)`
    );
    const info = insert.run(platform, nickname, 'pending', timestamp, timestamp);
    const id = Number(info.lastInsertRowid);
    const profilePath = this.getProfilePath(id, platform);
    mkdirSync(profilePath, { recursive: true });
    this.db.prepare('UPDATE weibo_account SET profile_path = ?, updated_at = ? WHERE id = ?').run(profilePath, now(), id);
    this.addLog({
      accountId: id,
      taskId: null,
      taskType: null,
      type: 'login',
      status: 'info',
      message: platform === 'baidu_pan' ? '已创建百度网盘账号，请人工登录' : '已创建微博账号，请人工登录',
      errorMessage: null
    });
    return this.getAccount(id);
  }

  getAccount(id: number): WeiboAccount {
    const account = this.db
      .prepare(
        `SELECT a.*, g.name AS group_name
         FROM weibo_account a
         LEFT JOIN account_group g ON g.id = a.group_id
         WHERE a.id = ?`
      )
      .get(id) as WeiboAccount | undefined;
    if (!account) {
      throw new Error(`Account ${id} not found`);
    }
    return account;
  }

  updateAccountStatus(id: number, status: AccountStatus): WeiboAccount {
    const timestamp = now();
    const lastLoginTime = status === 'online' ? timestamp : null;
    this.db
      .prepare(
        `UPDATE weibo_account
         SET status = ?,
             last_login_time = COALESCE(?, last_login_time),
             updated_at = ?
         WHERE id = ?`
      )
      .run(status, lastLoginTime, timestamp, id);
    this.addLog({
      accountId: id,
      taskId: null,
      taskType: null,
      type: 'login',
      status: status === 'online' ? 'success' : 'info',
      message: `账号状态更新为 ${status}`,
      errorMessage: null
    });
    return this.getAccount(id);
  }

  updateAccountGroup(accountId: number, groupId: number | null): WeiboAccount {
    this.db.prepare('UPDATE weibo_account SET group_id = ?, updated_at = ? WHERE id = ?').run(groupId, now(), accountId);
    this.addLog({
      accountId,
      taskId: null,
      taskType: null,
      type: 'group',
      status: 'success',
      message: groupId ? `账号已加入分组 ${groupId}` : '账号已移出分组',
      errorMessage: null
    });
    return this.getAccount(accountId);
  }

  updateAccountProfile(payload: UpdateAccountPayload): WeiboAccount {
    const current = this.getAccount(payload.id);
    const timestamp = now();
    const nickname = payload.nickname?.trim() || null;
    const uid = payload.uid?.trim() || null;
    const avatar = payload.avatar?.trim() || null;
    this.db
      .prepare(
        `UPDATE weibo_account
         SET uid = ?,
             nickname = ?,
             avatar = ?,
             status = ?,
             group_id = ?,
             updated_at = ?
         WHERE id = ?`
      )
      .run(uid, nickname, avatar, payload.status, payload.groupId, timestamp, payload.id);
    this.addLog({
      accountId: payload.id,
      taskId: null,
      taskType: null,
      type: 'login',
      status: 'info',
      message: `账号资料已更新：${nickname || current.nickname || `账号 ${payload.id}`}`,
      errorMessage: null
    });
    return this.getAccount(payload.id);
  }

  deleteAccount(id: number): void {
    const account = this.getAccount(id);
    const transaction = this.db.transaction(() => {
      this.addLog({
        accountId: id,
        taskId: null,
        taskType: null,
        type: 'login',
        status: 'info',
        message: `账号已删除：${account.nickname || `账号 ${id}`}`,
        errorMessage: null
      });

      this.db.prepare('DELETE FROM comment_task WHERE account_id = ?').run(id);
      this.db.prepare('DELETE FROM media_file WHERE post_task_id IN (SELECT id FROM post_task WHERE account_id = ?)').run(id);
      this.db.prepare('DELETE FROM post_task WHERE account_id = ?').run(id);
      this.db.prepare('DELETE FROM post_task WHERE account_id IS NULL AND id NOT IN (SELECT DISTINCT parent_task_id FROM post_task WHERE parent_task_id IS NOT NULL)').run();
      this.db.prepare('DELETE FROM task_event WHERE account_id = ?').run(id);
      this.db.prepare('UPDATE operation_log SET account_id = NULL WHERE account_id = ?').run(id);
      this.db.prepare('DELETE FROM weibo_account WHERE id = ?').run(id);
    });
    transaction();
  }

  listGroups(): AccountGroup[] {
    return this.db
      .prepare(
        `SELECT g.*, COUNT(a.id) AS account_count
         FROM account_group g
         LEFT JOIN weibo_account a ON a.group_id = g.id
         GROUP BY g.id
         ORDER BY g.updated_at DESC`
      )
      .all() as AccountGroup[];
  }

  createGroup(name: string, remark: string | null): AccountGroup {
    const timestamp = now();
    const info = this.db
      .prepare('INSERT INTO account_group (name, remark, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(name.trim(), remark?.trim() || null, timestamp, timestamp);
    this.addLog({
      accountId: null,
      taskId: null,
      taskType: null,
      type: 'group',
      status: 'success',
      message: `创建分组：${name.trim()}`,
      errorMessage: null
    });
    return this.getGroup(Number(info.lastInsertRowid));
  }

  updateGroup(id: number, name: string, remark: string | null): AccountGroup {
    this.db
      .prepare('UPDATE account_group SET name = ?, remark = ?, updated_at = ? WHERE id = ?')
      .run(name.trim(), remark?.trim() || null, now(), id);
    this.addLog({
      accountId: null,
      taskId: null,
      taskType: null,
      type: 'group',
      status: 'success',
      message: `编辑分组：${name.trim()}`,
      errorMessage: null
    });
    return this.getGroup(id);
  }

  deleteGroup(id: number): void {
    this.db.prepare('UPDATE weibo_account SET group_id = NULL, updated_at = ? WHERE group_id = ?').run(now(), id);
    this.db.prepare('DELETE FROM account_group WHERE id = ?').run(id);
    this.addLog({
      accountId: null,
      taskId: null,
      taskType: null,
      type: 'group',
      status: 'success',
      message: `删除分组：${id}`,
      errorMessage: null
    });
  }

  getGroup(id: number): AccountGroup {
    const group = this.db
      .prepare(
        `SELECT g.*, COUNT(a.id) AS account_count
         FROM account_group g
         LEFT JOIN weibo_account a ON a.group_id = g.id
         WHERE g.id = ?
         GROUP BY g.id`
      )
      .get(id) as AccountGroup | undefined;
    if (!group) {
      throw new Error(`Group ${id} not found`);
    }
    return group;
  }

  createPostTasks(payload: CreatePostPayload): PostTask[] {
    if (!payload.accountIds.length) {
      throw new Error('至少选择一个账号');
    }
    if (!payload.content.trim()) {
      throw new Error('微博正文不能为空');
    }
    if (payload.autoCommentEnabled && !payload.commentContent.trim()) {
      throw new Error('开启自动评论时评论内容不能为空');
    }
    if (payload.autoCommentEnabled && payload.replyCommentEnabled && !payload.replyCommentContent.trim()) {
      throw new Error('开启评论后回复时回复内容不能为空');
    }
    const scheduledAt = payload.scheduledAt?.trim() || null;
    if (scheduledAt && Number.isNaN(Date.parse(scheduledAt))) {
      throw new Error('定时发布时间格式不正确');
    }
    const commentAccountId = payload.autoCommentEnabled && payload.commentAccountId ? Number(payload.commentAccountId) : null;
    const replyCommentAccountId =
      payload.autoCommentEnabled && payload.replyCommentEnabled && payload.replyCommentAccountId
        ? Number(payload.replyCommentAccountId)
        : null;
    for (const accountId of [commentAccountId, replyCommentAccountId].filter(Boolean) as number[]) {
      const commentAccount = this.getAccount(accountId);
      if ((commentAccount.platform || 'weibo') !== 'weibo') {
        throw new Error('评论账号必须是微博账号');
      }
      if (['not_logged_in', 'expired'].includes(commentAccount.status)) {
        throw new Error('评论账号未登录或登录失效');
      }
    }

    const timestamp = now();
    const insertTask = this.db.prepare(
      `INSERT INTO post_task
       (parent_task_id, account_id, content, topics, images, auto_comment_enabled, comment_content,
        comment_delay_seconds, comment_account_id, reply_comment_content, reply_comment_delay_seconds,
        reply_comment_account_id, scheduled_at, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?)`
    );

    const transaction = this.db.transaction(() => {
      const parentInfo =
        payload.accountIds.length > 1
          ? insertTask.run(
              null,
              null,
              payload.content.trim(),
              JSON.stringify(payload.topics),
              JSON.stringify(payload.images),
              payload.autoCommentEnabled ? 1 : 0,
              payload.commentContent.trim() || null,
              payload.commentDelaySeconds,
              commentAccountId,
              payload.replyCommentEnabled ? payload.replyCommentContent.trim() : null,
              payload.replyCommentEnabled ? payload.replyCommentDelaySeconds : 0,
              replyCommentAccountId,
              scheduledAt,
              timestamp
            )
          : null;
      const parentId = parentInfo ? Number(parentInfo.lastInsertRowid) : null;

      const taskIds = payload.accountIds.map((accountId) => {
        const info = insertTask.run(
          parentId,
          accountId,
          payload.content.trim(),
          JSON.stringify(payload.topics),
          JSON.stringify(payload.images),
          payload.autoCommentEnabled ? 1 : 0,
          payload.commentContent.trim() || null,
          payload.commentDelaySeconds,
          commentAccountId,
          payload.replyCommentEnabled ? payload.replyCommentContent.trim() : null,
          payload.replyCommentEnabled ? payload.replyCommentDelaySeconds : 0,
          replyCommentAccountId,
          scheduledAt,
          timestamp
        );
        const taskId = Number(info.lastInsertRowid);
        this.addLog({
          accountId,
          taskId,
          taskType: 'post',
          type: 'post',
          status: 'info',
          message: '已创建发帖任务，等待用户确认执行',
          errorMessage: null
        });
        return taskId;
      });

      return taskIds;
    });

    const taskIds = transaction();
    return taskIds.map((id) => this.getPostTask(id));
  }

  listPostTasks(): PostTask[] {
    return this.db
      .prepare(
        `SELECT p.*, a.nickname AS account_nickname, ca.nickname AS comment_account_nickname,
                ra.nickname AS reply_comment_account_nickname
         FROM post_task p
         LEFT JOIN weibo_account a ON a.id = p.account_id
         LEFT JOIN weibo_account ca ON ca.id = p.comment_account_id
         LEFT JOIN weibo_account ra ON ra.id = p.reply_comment_account_id
         WHERE p.account_id IS NOT NULL
         ORDER BY p.created_at DESC
         LIMIT 100`
      )
      .all() as PostTask[];
  }

  listDuePostTasks(): PostTask[] {
    return this.db
      .prepare(
        `SELECT p.*, a.nickname AS account_nickname, ca.nickname AS comment_account_nickname,
                ra.nickname AS reply_comment_account_nickname
         FROM post_task p
         LEFT JOIN weibo_account a ON a.id = p.account_id
         LEFT JOIN weibo_account ca ON ca.id = p.comment_account_id
         LEFT JOIN weibo_account ra ON ra.id = p.reply_comment_account_id
         WHERE p.account_id IS NOT NULL
           AND p.status = 'pending'
           AND p.scheduled_at IS NOT NULL
           AND p.scheduled_at <= ?
         ORDER BY p.scheduled_at ASC, p.created_at ASC
         LIMIT 10`
      )
      .all(now()) as PostTask[];
  }

  startPostTask(taskId: number): PostTask {
    const task = this.getPostTask(taskId);
    if (!task.account_id) {
      throw new Error('主任务不能直接执行，请执行子任务');
    }
    if (task.status === 'success') {
      throw new Error('任务已成功，不能重复执行');
    }

    const account = this.getAccount(task.account_id);
    if (account.status !== 'online') {
      throw new Error('账号未在线，请先完成人工登录并确认账号在线');
    }

    const timestamp = now();
    this.db
      .prepare('UPDATE post_task SET status = ?, started_at = COALESCE(started_at, ?), error_message = NULL WHERE id = ?')
      .run('running', timestamp, taskId);
    this.db.prepare('UPDATE weibo_account SET status = ?, updated_at = ? WHERE id = ?').run('posting', timestamp, task.account_id);
    if (task.parent_task_id) {
      this.db
        .prepare('UPDATE post_task SET status = ?, started_at = COALESCE(started_at, ?) WHERE id = ?')
        .run('running', timestamp, task.parent_task_id);
    }
    this.addTaskEvent(taskId, 'post', task.account_id, 'started', 'running', '发帖任务开始执行', null);
    this.addLog({
      accountId: task.account_id,
      taskId,
      taskType: 'post',
      type: 'post',
      status: 'info',
      message: '发帖任务进入执行态，请在右侧微博页面完成发布',
      errorMessage: null
    });
    return this.getPostTask(taskId);
  }

  completePostTask(payload: CompletePostPayload): PostTask {
    const task = this.getPostTask(payload.taskId);
    if (!task.account_id) {
      throw new Error('主任务不能直接完成');
    }
    const weiboUrl = payload.weiboUrl.trim();
    if (!weiboUrl) {
      throw new Error('微博链接不能为空');
    }

    const timestamp = now();
    const transaction = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE post_task
           SET status = 'success',
               weibo_url = ?,
               weibo_id = ?,
               error_message = NULL,
               finished_at = ?
           WHERE id = ?`
        )
        .run(weiboUrl, payload.weiboId?.trim() || null, timestamp, payload.taskId);
      this.db
        .prepare("UPDATE weibo_account SET status = 'online', last_post_time = ?, updated_at = ? WHERE id = ?")
        .run(timestamp, timestamp, task.account_id);

      this.addTaskEvent(payload.taskId, 'post', task.account_id, 'completed', 'success', '发帖任务已完成', null);
      this.addLog({
        accountId: task.account_id,
        taskId: payload.taskId,
        taskType: 'post',
        type: 'post',
        status: 'success',
        message: `微博发布成功：${weiboUrl}`,
        errorMessage: null
      });

      if (task.auto_comment_enabled && task.comment_content) {
        const commentInfo = this.db
          .prepare(
            `INSERT INTO comment_task
             (post_task_id, account_id, weibo_url, weibo_id, comment_content, status,
              retry_count, max_retry_count, delay_seconds, reply_comment_content,
              reply_comment_delay_seconds, reply_comment_account_id, created_at)
             VALUES (?, ?, ?, ?, ?, 'pending', 0, 1, ?, ?, ?, ?, ?)`
          )
          .run(
            payload.taskId,
            task.comment_account_id || task.account_id,
            weiboUrl,
            payload.weiboId?.trim() || null,
            task.comment_content,
            task.comment_delay_seconds,
            task.reply_comment_content,
            task.reply_comment_delay_seconds,
            task.reply_comment_account_id,
            timestamp
          );
        const commentTaskId = Number(commentInfo.lastInsertRowid);
        this.addTaskEvent(
          commentTaskId,
          'comment',
          task.comment_account_id || task.account_id,
          'created',
          'pending',
          '已创建发帖后评论任务',
          null
        );
        this.addLog({
          accountId: task.comment_account_id || task.account_id,
          taskId: commentTaskId,
          taskType: 'comment',
          type: 'comment',
          status: 'info',
          message: '已创建发帖后评论任务，等待后续评论执行',
          errorMessage: null
        });
      }

      if (task.parent_task_id) {
        this.updateParentPostStatus(task.parent_task_id);
      }
    });

    transaction();
    return this.getPostTask(payload.taskId);
  }

  failPostTask(payload: FailPostPayload): PostTask {
    const task = this.getPostTask(payload.taskId);
    if (!task.account_id) {
      throw new Error('主任务不能直接标记失败');
    }
    const errorMessage = payload.errorMessage.trim();
    if (!errorMessage) {
      throw new Error('失败原因不能为空');
    }

    const timestamp = now();
    const transaction = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE post_task
           SET status = 'failed',
               error_message = ?,
               finished_at = ?
           WHERE id = ?`
        )
        .run(errorMessage, timestamp, payload.taskId);
      this.db.prepare("UPDATE weibo_account SET status = 'online', updated_at = ? WHERE id = ?").run(timestamp, task.account_id);
      this.addTaskEvent(payload.taskId, 'post', task.account_id, 'failed', 'failed', '发帖任务失败', errorMessage);
      this.addLog({
        accountId: task.account_id,
        taskId: payload.taskId,
        taskType: 'post',
        type: 'post',
        status: 'failed',
        message: '微博发布失败',
        errorMessage
      });
      if (task.parent_task_id) {
        this.updateParentPostStatus(task.parent_task_id);
      }
    });

    transaction();
    return this.getPostTask(payload.taskId);
  }

  listCommentTasks(): CommentTask[] {
    return this.db
      .prepare(
        `SELECT c.*, a.nickname AS account_nickname, ra.nickname AS reply_comment_account_nickname
         FROM comment_task c
         LEFT JOIN weibo_account a ON a.id = c.account_id
         LEFT JOIN weibo_account ra ON ra.id = c.reply_comment_account_id
         ORDER BY c.created_at DESC
         LIMIT 100`
      )
      .all() as CommentTask[];
  }

  getCommentTask(id: number): CommentTask {
    const task = this.db
      .prepare(
        `SELECT c.*, a.nickname AS account_nickname, ra.nickname AS reply_comment_account_nickname
         FROM comment_task c
         LEFT JOIN weibo_account a ON a.id = c.account_id
         LEFT JOIN weibo_account ra ON ra.id = c.reply_comment_account_id
         WHERE c.id = ?`
      )
      .get(id) as CommentTask | undefined;
    if (!task) {
      throw new Error(`Comment task ${id} not found`);
    }
    return task;
  }

  startCommentTask(taskId: number): CommentTask {
    const task = this.getCommentTask(taskId);
    if (task.status === 'success') {
      throw new Error('评论任务已成功，不能重复执行');
    }
    if (!task.weibo_url) {
      throw new Error('微博链接为空，不能执行评论');
    }
    if (!task.comment_content.trim()) {
      throw new Error('评论内容为空，不能执行评论');
    }

    const account = this.getAccount(task.account_id);
    if (account.status !== 'online') {
      throw new Error('账号未在线，请先确认账号在线');
    }

    const timestamp = now();
    this.db
      .prepare('UPDATE comment_task SET status = ?, started_at = COALESCE(started_at, ?), error_message = NULL WHERE id = ?')
      .run('running', timestamp, taskId);
    this.db.prepare('UPDATE weibo_account SET status = ?, updated_at = ? WHERE id = ?').run('commenting', timestamp, task.account_id);
    this.addTaskEvent(taskId, 'comment', task.account_id, 'started', 'running', '评论任务开始执行', null);
    this.addLog({
      accountId: task.account_id,
      taskId,
      taskType: 'comment',
      type: 'comment',
      status: 'info',
      message: '评论任务进入执行态，请在右侧微博详情页完成评论',
      errorMessage: null
    });
    return this.getCommentTask(taskId);
  }

  completeCommentTask(payload: CompleteCommentPayload): CommentTask {
    const task = this.getCommentTask(payload.taskId);
    const timestamp = now();
    this.db
      .prepare(
        `UPDATE comment_task
         SET status = 'success',
             error_message = NULL,
             finished_at = ?
         WHERE id = ?`
      )
      .run(timestamp, payload.taskId);
    this.db
      .prepare("UPDATE weibo_account SET status = 'online', last_comment_time = ?, updated_at = ? WHERE id = ?")
      .run(timestamp, timestamp, task.account_id);
    this.addTaskEvent(payload.taskId, 'comment', task.account_id, 'completed', 'success', '评论任务已完成', null);
    this.addLog({
      accountId: task.account_id,
      taskId: payload.taskId,
      taskType: 'comment',
      type: 'comment',
      status: 'success',
      message: '自动评论已确认完成',
      errorMessage: null
    });
    return this.getCommentTask(payload.taskId);
  }

  failCommentTask(payload: FailCommentPayload): CommentTask {
    const task = this.getCommentTask(payload.taskId);
    const errorMessage = payload.errorMessage.trim();
    if (!errorMessage) {
      throw new Error('失败原因不能为空');
    }
    const timestamp = now();
    this.db
      .prepare(
        `UPDATE comment_task
         SET status = 'failed',
             retry_count = retry_count + 1,
             error_message = ?,
             finished_at = ?
         WHERE id = ?`
      )
      .run(errorMessage, timestamp, payload.taskId);
    this.db.prepare("UPDATE weibo_account SET status = 'online', updated_at = ? WHERE id = ?").run(timestamp, task.account_id);
    this.addTaskEvent(payload.taskId, 'comment', task.account_id, 'failed', 'failed', '评论任务失败', errorMessage);
    this.addLog({
      accountId: task.account_id,
      taskId: payload.taskId,
      taskType: 'comment',
      type: 'comment',
      status: 'failed',
      message: '评论任务失败',
      errorMessage
    });
    return this.getCommentTask(payload.taskId);
  }

  skipCommentTask(taskId: number): CommentTask {
    const task = this.getCommentTask(taskId);
    const timestamp = now();
    this.db
      .prepare(
        `UPDATE comment_task
         SET status = 'skipped',
             error_message = NULL,
             finished_at = ?
         WHERE id = ?`
      )
      .run(timestamp, taskId);
    this.db.prepare("UPDATE weibo_account SET status = 'online', updated_at = ? WHERE id = ?").run(timestamp, task.account_id);
    this.addTaskEvent(taskId, 'comment', task.account_id, 'skipped', 'skipped', '用户跳过评论任务', null);
    this.addLog({
      accountId: task.account_id,
      taskId,
      taskType: 'comment',
      type: 'comment',
      status: 'info',
      message: '用户跳过评论任务',
      errorMessage: null
    });
    return this.getCommentTask(taskId);
  }

  getPostTask(id: number): PostTask {
    const task = this.db
      .prepare(
        `SELECT p.*, a.nickname AS account_nickname, ca.nickname AS comment_account_nickname,
                ra.nickname AS reply_comment_account_nickname
         FROM post_task p
         LEFT JOIN weibo_account a ON a.id = p.account_id
         LEFT JOIN weibo_account ca ON ca.id = p.comment_account_id
         LEFT JOIN weibo_account ra ON ra.id = p.reply_comment_account_id
         WHERE p.id = ?`
      )
      .get(id) as PostTask | undefined;
    if (!task) {
      throw new Error(`Post task ${id} not found`);
    }
    return task;
  }

  listLogs(): OperationLog[] {
    return this.db
      .prepare(
        `SELECT l.*, a.nickname AS account_nickname
         FROM operation_log l
         LEFT JOIN weibo_account a ON a.id = l.account_id
         ORDER BY l.created_at DESC
         LIMIT 200`
      )
      .all() as OperationLog[];
  }

  addLog(input: {
    accountId: number | null;
    taskId: number | null;
    taskType: string | null;
    type: LogType;
    status: LogStatus;
    message: string;
    errorMessage: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO operation_log
         (account_id, task_id, task_type, type, status, message, error_message, operator_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`
      )
      .run(
        input.accountId,
        input.taskId,
        input.taskType,
        input.type,
        input.status,
        input.message,
        input.errorMessage,
        now()
      );
  }

  private addTaskEvent(
    taskId: number,
    taskType: string,
    accountId: number | null,
    event: string,
    status: string,
    message: string | null,
    errorMessage: string | null
  ): void {
    this.db
      .prepare(
        `INSERT INTO task_event
         (task_id, task_type, account_id, event, status, message, error_message, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(taskId, taskType, accountId, event, status, message, errorMessage, now());
  }

  private updateParentPostStatus(parentTaskId: number): void {
    const children = this.db
      .prepare('SELECT status FROM post_task WHERE parent_task_id = ?')
      .all(parentTaskId) as Array<{ status: string }>;
    if (!children.length) {
      return;
    }

    let nextStatus = 'pending';
    if (children.some((child) => child.status === 'running')) {
      nextStatus = 'running';
    } else if (children.every((child) => child.status === 'success')) {
      nextStatus = 'success';
    } else if (children.every((child) => ['success', 'failed', 'cancelled'].includes(child.status))) {
      nextStatus = children.some((child) => child.status === 'success') ? 'success' : 'failed';
    } else if (children.some((child) => child.status !== 'pending')) {
      nextStatus = 'running';
    }

    const finishedAt = ['success', 'failed', 'cancelled'].includes(nextStatus) ? now() : null;
    this.db
      .prepare(
        `UPDATE post_task
         SET status = ?,
             finished_at = COALESCE(?, finished_at)
         WHERE id = ?`
      )
      .run(nextStatus, finishedAt, parentTaskId);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS account_group (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        remark TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS weibo_account (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT NOT NULL DEFAULT 'weibo',
        uid TEXT,
        nickname TEXT,
        avatar TEXT,
        status TEXT NOT NULL DEFAULT 'not_logged_in',
        group_id INTEGER,
        profile_path TEXT NOT NULL,
        encrypted_cookie TEXT,
        last_login_time TEXT,
        last_post_time TEXT,
        last_comment_time TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (group_id) REFERENCES account_group(id)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_weibo_account_uid
      ON weibo_account(uid)
      WHERE uid IS NOT NULL;

      CREATE TABLE IF NOT EXISTS post_task (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        parent_task_id INTEGER,
        account_id INTEGER,
        content TEXT NOT NULL,
        topics TEXT,
        images TEXT,
        auto_comment_enabled INTEGER NOT NULL DEFAULT 0,
        comment_content TEXT,
        comment_delay_seconds INTEGER NOT NULL DEFAULT 0,
        comment_account_id INTEGER,
        reply_comment_content TEXT,
        reply_comment_delay_seconds INTEGER NOT NULL DEFAULT 0,
        reply_comment_account_id INTEGER,
        scheduled_at TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        weibo_url TEXT,
        weibo_id TEXT,
        error_message TEXT,
        created_by INTEGER,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        FOREIGN KEY (parent_task_id) REFERENCES post_task(id),
        FOREIGN KEY (account_id) REFERENCES weibo_account(id),
        FOREIGN KEY (comment_account_id) REFERENCES weibo_account(id),
        FOREIGN KEY (reply_comment_account_id) REFERENCES weibo_account(id)
      );

      CREATE INDEX IF NOT EXISTS idx_post_task_parent ON post_task(parent_task_id);
      CREATE INDEX IF NOT EXISTS idx_post_task_account ON post_task(account_id);
      CREATE INDEX IF NOT EXISTS idx_post_task_status ON post_task(status);
      PRAGMA user_version = 2;

      CREATE TABLE IF NOT EXISTS comment_task (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        post_task_id INTEGER NOT NULL,
        account_id INTEGER NOT NULL,
        weibo_url TEXT,
        weibo_id TEXT,
        comment_content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        retry_count INTEGER NOT NULL DEFAULT 0,
        max_retry_count INTEGER NOT NULL DEFAULT 1,
        delay_seconds INTEGER NOT NULL DEFAULT 0,
        reply_comment_content TEXT,
        reply_comment_delay_seconds INTEGER NOT NULL DEFAULT 0,
        reply_comment_account_id INTEGER,
        error_message TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        FOREIGN KEY (post_task_id) REFERENCES post_task(id),
        FOREIGN KEY (account_id) REFERENCES weibo_account(id),
        FOREIGN KEY (reply_comment_account_id) REFERENCES weibo_account(id)
      );

      CREATE INDEX IF NOT EXISTS idx_comment_task_post ON comment_task(post_task_id);
      CREATE INDEX IF NOT EXISTS idx_comment_task_account ON comment_task(account_id);
      CREATE INDEX IF NOT EXISTS idx_comment_task_status ON comment_task(status);

      CREATE TABLE IF NOT EXISTS media_file (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        post_task_id INTEGER,
        file_path TEXT NOT NULL,
        file_name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        error_message TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (post_task_id) REFERENCES post_task(id)
      );

      CREATE INDEX IF NOT EXISTS idx_media_file_post ON media_file(post_task_id);

      CREATE TABLE IF NOT EXISTS operation_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER,
        task_id INTEGER,
        task_type TEXT,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        message TEXT NOT NULL,
        error_message TEXT,
        operator_id INTEGER,
        created_at TEXT NOT NULL,
        FOREIGN KEY (account_id) REFERENCES weibo_account(id)
      );

      CREATE INDEX IF NOT EXISTS idx_operation_log_account ON operation_log(account_id);
      CREATE INDEX IF NOT EXISTS idx_operation_log_type ON operation_log(type);
      CREATE INDEX IF NOT EXISTS idx_operation_log_status ON operation_log(status);
      CREATE INDEX IF NOT EXISTS idx_operation_log_created_at ON operation_log(created_at);

      CREATE TABLE IF NOT EXISTS task_event (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL,
        task_type TEXT NOT NULL,
        account_id INTEGER,
        event TEXT NOT NULL,
        status TEXT NOT NULL,
        message TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (account_id) REFERENCES weibo_account(id)
      );

      CREATE INDEX IF NOT EXISTS idx_task_event_task ON task_event(task_type, task_id);
    `);
    const accountColumns = this.db.prepare('PRAGMA table_info(weibo_account)').all() as Array<{ name: string }>;
    if (!accountColumns.some((column) => column.name === 'platform')) {
      this.db.prepare("ALTER TABLE weibo_account ADD COLUMN platform TEXT NOT NULL DEFAULT 'weibo'").run();
    }
    const postTaskColumns = this.db.prepare('PRAGMA table_info(post_task)').all() as Array<{ name: string }>;
    if (!postTaskColumns.some((column) => column.name === 'images')) {
      this.db.prepare('ALTER TABLE post_task ADD COLUMN images TEXT').run();
    }
    if (!postTaskColumns.some((column) => column.name === 'comment_account_id')) {
      this.db.prepare('ALTER TABLE post_task ADD COLUMN comment_account_id INTEGER').run();
    }
    if (!postTaskColumns.some((column) => column.name === 'scheduled_at')) {
      this.db.prepare('ALTER TABLE post_task ADD COLUMN scheduled_at TEXT').run();
    }
    if (!postTaskColumns.some((column) => column.name === 'reply_comment_content')) {
      this.db.prepare('ALTER TABLE post_task ADD COLUMN reply_comment_content TEXT').run();
    }
    if (!postTaskColumns.some((column) => column.name === 'reply_comment_delay_seconds')) {
      this.db.prepare('ALTER TABLE post_task ADD COLUMN reply_comment_delay_seconds INTEGER NOT NULL DEFAULT 0').run();
    }
    if (!postTaskColumns.some((column) => column.name === 'reply_comment_account_id')) {
      this.db.prepare('ALTER TABLE post_task ADD COLUMN reply_comment_account_id INTEGER').run();
    }
    const commentTaskColumns = this.db.prepare('PRAGMA table_info(comment_task)').all() as Array<{ name: string }>;
    if (!commentTaskColumns.some((column) => column.name === 'reply_comment_content')) {
      this.db.prepare('ALTER TABLE comment_task ADD COLUMN reply_comment_content TEXT').run();
    }
    if (!commentTaskColumns.some((column) => column.name === 'reply_comment_delay_seconds')) {
      this.db.prepare('ALTER TABLE comment_task ADD COLUMN reply_comment_delay_seconds INTEGER NOT NULL DEFAULT 0').run();
    }
    if (!commentTaskColumns.some((column) => column.name === 'reply_comment_account_id')) {
      this.db.prepare('ALTER TABLE comment_task ADD COLUMN reply_comment_account_id INTEGER').run();
    }
  }
}
