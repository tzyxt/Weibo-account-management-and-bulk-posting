export type AccountStatus =
  | 'not_logged_in'
  | 'logging_in'
  | 'online'
  | 'offline'
  | 'expired'
  | 'abnormal'
  | 'posting'
  | 'commenting';

export type AccountPlatform = 'weibo' | 'baidu_pan';
export type TaskStatus = 'pending' | 'running' | 'success' | 'failed' | 'cancelled';
export type CommentTaskStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped';

export type LogType = 'login' | 'post' | 'comment' | 'group' | 'system';
export type LogStatus = 'success' | 'failed' | 'abnormal' | 'info';

export interface WeiboAccount {
  id: number;
  platform: AccountPlatform;
  uid: string | null;
  nickname: string | null;
  avatar: string | null;
  status: AccountStatus;
  group_id: number | null;
  group_name?: string | null;
  profile_path: string;
  encrypted_cookie: string | null;
  last_login_time: string | null;
  last_post_time: string | null;
  last_comment_time: string | null;
  created_at: string;
  updated_at: string;
}

export interface UpdateAccountPayload {
  id: number;
  uid: string | null;
  nickname: string | null;
  avatar: string | null;
  status: AccountStatus;
  groupId: number | null;
}

export interface AccountGroup {
  id: number;
  name: string;
  remark: string | null;
  account_count?: number;
  created_at: string;
  updated_at: string;
}

export interface DashboardStats {
  totalAccounts: number;
  onlineAccounts: number;
  offlineAccounts: number;
  expiredAccounts: number;
  totalPosts: number;
  totalComments: number;
  todayPosts: number;
  todayComments: number;
  failedTasks: number;
}

export interface OperationLog {
  id: number;
  account_id: number | null;
  account_nickname?: string | null;
  task_id: number | null;
  task_type: string | null;
  type: LogType;
  status: LogStatus;
  message: string;
  error_message: string | null;
  operator_id: number | null;
  created_at: string;
}

export interface PostTask {
  id: number;
  parent_task_id: number | null;
  account_id: number | null;
  account_nickname?: string | null;
  content: string;
  topics: string | null;
  images: string | null;
  auto_comment_enabled: number;
  comment_content: string | null;
  comment_delay_seconds: number;
  comment_account_id: number | null;
  comment_account_nickname?: string | null;
  reply_comment_content: string | null;
  reply_comment_delay_seconds: number;
  reply_comment_account_id: number | null;
  reply_comment_account_nickname?: string | null;
  scheduled_at: string | null;
  status: TaskStatus;
  weibo_url: string | null;
  weibo_id: string | null;
  error_message: string | null;
  created_by: number | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface CommentTask {
  id: number;
  post_task_id: number;
  account_id: number;
  account_nickname?: string | null;
  weibo_url: string | null;
  weibo_id: string | null;
  comment_content: string;
  status: CommentTaskStatus;
  retry_count: number;
  max_retry_count: number;
  delay_seconds: number;
  reply_comment_content: string | null;
  reply_comment_delay_seconds: number;
  reply_comment_account_id: number | null;
  reply_comment_account_nickname?: string | null;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface CreatePostPayload {
  accountIds: number[];
  content: string;
  accountContents?: Array<{
    accountId: number;
    content: string;
  }>;
  topics: string[];
  images: string[];
  autoCommentEnabled: boolean;
  commentContent: string;
  commentDelaySeconds: number;
  commentAccountId: number | null;
  replyCommentEnabled: boolean;
  replyCommentContent: string;
  replyCommentDelaySeconds: number;
  replyCommentAccountId: number | null;
  scheduledAt: string | null;
}

export interface CompletePostPayload {
  taskId: number;
  weiboUrl: string;
  weiboId?: string;
}

export interface FailPostPayload {
  taskId: number;
  errorMessage: string;
}

export interface AutoPublishResult {
  taskId: number;
  status: TaskStatus;
  weiboUrl: string | null;
  errorMessage: string | null;
}

export interface AutoCommentResult {
  taskId: number;
  status: CommentTaskStatus;
  errorMessage: string | null;
}

export interface CompleteCommentPayload {
  taskId: number;
}

export interface FailCommentPayload {
  taskId: number;
  errorMessage: string;
}
