# 微博账号管理系统技术设计

## 1. 文档信息

| 项目 | 内容 |
|---|---|
| 文档名称 | 微博账号管理系统技术设计 |
| 来源文档 | `weibo_account_management_prd.md` |
| 版本 | V1.0 |
| 日期 | 2026-05-08 |
| 推荐 MVP 技术栈 | Electron + Vue 3 + SQLite |

---

## 2. 设计目标

本系统面向本地桌面端使用场景，目标是在合规前提下帮助用户统一管理本人或已授权的多个微博账号，完成账号登录态隔离、账号页面操作、单账号发帖、多账号发帖、发帖后自动评论、分组和日志记录。

技术设计重点：

1. 每个微博账号拥有独立浏览器会话，避免 Cookie、LocalStorage、SessionStorage 混用。
2. 登录由用户在微博官方页面中人工完成，系统不处理验证码破解、安全验证绕过或风控规避。
3. 发帖和评论任务必须由用户主动创建或确认。
4. 多账号任务按主任务和子任务拆分，单个账号失败不影响其他账号。
5. 所有关键操作写入日志，便于追踪、验收和排错。
6. 本地敏感数据加密存储，不保存微博账号明文密码。

---

## 3. 总体架构

### 3.1 架构形态

MVP 推荐采用本地桌面端架构：

```text
┌────────────────────────────────────────────┐
│ Electron 桌面应用                          │
│                                            │
│  ┌──────────────────────────────────────┐  │
│  │ Renderer: Vue 3 前端                 │  │
│  │ - 首页看板                           │  │
│  │ - 账号管理                           │  │
│  │ - 发帖编辑                           │  │
│  │ - 分组管理                           │  │
│  │ - 状态日志                           │  │
│  └──────────────────────────────────────┘  │
│                    │ IPC                    │
│  ┌──────────────────────────────────────┐  │
│  │ Main: Electron 主进程                │  │
│  │ - BrowserView/WebContents 管理       │  │
│  │ - 独立会话管理                       │  │
│  │ - 任务调度                           │  │
│  │ - SQLite 数据访问                    │  │
│  │ - 加密与本地文件管理                 │  │
│  └──────────────────────────────────────┘  │
│                    │                       │
│  ┌──────────────────────────────────────┐  │
│  │ SQLite 本地数据库                    │  │
│  └──────────────────────────────────────┘  │
│                                            │
│  ┌──────────────────────────────────────┐  │
│  │ profiles/account_xxx 独立会话目录     │  │
│  └──────────────────────────────────────┘  │
└────────────────────────────────────────────┘
```

### 3.2 进程职责

| 层级 | 职责 |
|---|---|
| Vue Renderer | 页面展示、表单校验、用户确认、状态订阅、结果展示 |
| Electron Main | 微博页面容器管理、账号会话隔离、任务执行、数据库读写、文件访问 |
| SQLite | 账号、分组、任务、评论、日志、媒体文件等持久化 |
| profiles 目录 | 按账号保存独立浏览器用户数据 |

### 3.3 推荐目录结构

```text
.
├── docs/
│   └── TECH_DESIGN.md
├── src/
│   ├── main/
│   │   ├── browser/
│   │   │   ├── accountSession.ts
│   │   │   └── weiboViewManager.ts
│   │   ├── db/
│   │   │   ├── migrations/
│   │   │   └── database.ts
│   │   ├── tasks/
│   │   │   ├── postTaskRunner.ts
│   │   │   ├── commentTaskRunner.ts
│   │   │   └── taskScheduler.ts
│   │   ├── security/
│   │   │   └── cryptoStore.ts
│   │   ├── ipc/
│   │   │   ├── accountIpc.ts
│   │   │   ├── postIpc.ts
│   │   │   ├── groupIpc.ts
│   │   │   └── logIpc.ts
│   │   └── main.ts
│   ├── preload/
│   │   └── index.ts
│   └── renderer/
│       ├── pages/
│       │   ├── HomePage.vue
│       │   ├── AccountPage.vue
│       │   ├── PostPage.vue
│       │   ├── GroupPage.vue
│       │   └── LogPage.vue
│       ├── components/
│       ├── stores/
│       └── router/
├── profiles/
│   └── account_{id}/
├── data/
│   └── app.sqlite
└── uploads/
```

---

## 4. 核心模块设计

### 4.1 首页模块

首页只做聚合展示，不直接承载业务操作。

数据来源：

| 指标 | 来源 |
|---|---|
| 账号总数 | `weibo_account` |
| 在线账号数 | `weibo_account.status = online` |
| 离线账号数 | `weibo_account.status in (not_logged_in, offline)` |
| 登录失效账号数 | `weibo_account.status = expired` |
| 发帖总数 | `post_task.status = success` |
| 评论总数 | `comment_task.status = success` |
| 今日发帖数 | `post_task.finished_at` 当日成功记录 |
| 今日评论数 | `comment_task.finished_at` 当日成功记录 |
| 失败任务数 | `post_task/comment_task.status = failed` |

### 4.2 账号模块

账号模块负责账号添加、人工登录、状态识别、列表展示、切换、删除和重新登录。

添加账号流程：

```text
用户点击添加账号
  -> Main 创建临时登录 BrowserWindow
  -> 打开微博官方登录页
  -> 用户人工完成登录和安全验证
  -> Main 检测登录态
  -> 获取昵称、头像、UID
  -> 创建账号记录
  -> 创建独立 profile 目录或 session partition
  -> 写入登录日志
  -> Renderer 刷新账号列表
```

状态识别建议：

| 状态 | 识别方式 |
|---|---|
| `not_logged_in` | 账号已创建但没有有效会话 |
| `logging_in` | 正在打开登录窗口 |
| `online` | 微博页面可访问且能识别当前账号 |
| `offline` | 页面未加载或用户主动退出 |
| `expired` | 跳转到登录页或页面提示重新登录 |
| `abnormal` | 页面加载失败、网络异常、无法判断状态 |
| `posting` | 账号正在执行发帖任务 |
| `commenting` | 账号正在执行评论任务 |

### 4.3 独立微博浏览器区

每个账号必须拥有独立浏览器上下文。推荐使用 Electron `session.fromPartition`：

```text
persist:weibo_account_{accountId}
```

实现原则：

1. 账号切换时复用对应账号的 BrowserView/WebContents。
2. 不同账号使用不同 partition。
3. 删除账号时清理数据库记录和对应会话目录。
4. 右侧浏览器仅承载微博官方页面，不注入绕过验证或规避风控的逻辑。
5. 出现验证码、安全验证或二次确认时，暂停自动任务并提示用户手动处理。

### 4.4 发帖模块

发帖模块由前端创建任务，主进程执行任务。

单账号发帖：

```text
校验账号在线
  -> 校验正文非空
  -> 校验图片
  -> 创建 post_task
  -> 执行发帖
  -> 获取微博链接或微博 ID
  -> 更新任务状态
  -> 写入日志
  -> 如开启自动评论，创建 comment_task
```

多账号发帖：

```text
用户选择多个账号
  -> 展示发布前确认弹窗
  -> 创建主任务 parent_task
  -> 为每个账号创建子任务
  -> 按频率限制逐个执行或受控并发执行
  -> 每个子任务独立更新状态
  -> 聚合整体结果
```

并发策略建议：

| 阶段 | 策略 |
|---|---|
| MVP | 默认逐个执行，间隔 3-10 秒，可配置 |
| V1.1 | 支持小并发，默认并发数 1-2 |
| 风险控制 | 多账号发布前必须人工确认 |

### 4.5 自动评论模块

自动评论只允许当前发帖账号对自己刚发布的微博追加评论。

执行条件：

1. 发帖任务成功。
2. 已获取微博链接或微博 ID。
3. 用户已开启自动评论。
4. 评论内容非空。
5. 当前账号登录态有效。
6. 页面没有验证码、安全验证或风险提示。

失败处理：

| 场景 | 处理 |
|---|---|
| 发帖失败 | 评论任务标记 `skipped` |
| 未获取微博链接 | 评论任务标记 `skipped` |
| 评论内容为空 | 评论任务标记 `skipped` |
| 登录失效 | 评论任务标记 `failed`，账号标记 `expired` |
| 安全验证 | 评论任务暂停或失败，提示用户手动处理 |
| 评论提交失败 | 按配置有限重试 |

### 4.6 分组模块

分组为账号的轻量分类能力，MVP 支持一个账号归属一个分组。

后续如果需要一个账号加入多个分组，可将 `weibo_account.group_id` 改为中间表：

```text
account_group_member(account_id, group_id)
```

MVP 阶段保持简单，使用 `weibo_account.group_id` 即可。

### 4.7 日志模块

日志统一写入 `operation_log`。任务运行过程中建议同时写入 `task_event`，用于展示更细的进度。

日志类型：

| 类型 | 说明 |
|---|---|
| `login` | 登录、重新登录、登录失效 |
| `post` | 发帖任务创建、开始、成功、失败 |
| `comment` | 评论任务创建、开始、成功、失败、跳过 |
| `group` | 分组新增、编辑、删除、账号移动 |
| `system` | 页面异常、网络异常、数据库异常 |

---

## 5. 数据库设计

### 5.1 表关系

```text
account_group 1 ── n weibo_account
weibo_account 1 ── n post_task
post_task 1 ── 0..1 comment_task
post_task 1 ── n media_file
post_task 1 ── n task_event
operation_log 可关联 account / post_task / comment_task
```

### 5.2 SQLite DDL

```sql
CREATE TABLE IF NOT EXISTS account_group (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  remark TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS weibo_account (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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
  auto_comment_enabled INTEGER NOT NULL DEFAULT 0,
  comment_content TEXT,
  comment_delay_seconds INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  weibo_url TEXT,
  weibo_id TEXT,
  error_message TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  FOREIGN KEY (parent_task_id) REFERENCES post_task(id),
  FOREIGN KEY (account_id) REFERENCES weibo_account(id)
);

CREATE INDEX IF NOT EXISTS idx_post_task_parent ON post_task(parent_task_id);
CREATE INDEX IF NOT EXISTS idx_post_task_account ON post_task(account_id);
CREATE INDEX IF NOT EXISTS idx_post_task_status ON post_task(status);

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
  error_message TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  FOREIGN KEY (post_task_id) REFERENCES post_task(id),
  FOREIGN KEY (account_id) REFERENCES weibo_account(id)
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
```

---

## 6. 状态机设计

### 6.1 账号状态

```text
not_logged_in
  -> logging_in
  -> online
  -> expired
  -> logging_in

online
  -> posting
  -> online

online
  -> commenting
  -> online

online
  -> offline
online
  -> abnormal
```

### 6.2 发帖任务状态

```text
pending -> running -> success
pending -> running -> failed
pending -> cancelled
running -> failed
running -> cancelled
```

### 6.3 评论任务状态

```text
pending -> running -> success
pending -> running -> failed
pending -> skipped
running -> failed
```

### 6.4 主任务聚合状态

多账号主任务不直接执行发帖，仅聚合子任务状态。

| 子任务状态 | 主任务状态 |
|---|---|
| 全部 pending | `pending` |
| 任一 running | `running` |
| 全部 success | `success` |
| 部分 success，部分 failed/skipped | `success` 或 `failed`，按产品口径建议显示为 `partial_success` |
| 全部 failed | `failed` |
| 用户取消 | `cancelled` |

建议新增主任务展示状态 `partial_success`，数据库仍可使用 `status = success` 并在聚合接口返回 `summary_status = partial_success`，避免改动 PRD 的基础状态集。

---

## 7. IPC 接口设计

Renderer 不直接访问数据库和文件系统，统一通过 preload 暴露安全 API。

### 7.1 账号接口

| 接口 | 说明 |
|---|---|
| `account:list` | 获取账号列表 |
| `account:create-login-window` | 打开微博登录窗口 |
| `account:refresh-status` | 检测账号登录状态 |
| `account:switch-view` | 切换右侧微博页面 |
| `account:relogin` | 重新登录账号 |
| `account:delete` | 删除账号和会话数据 |
| `account:update-group` | 修改账号所属分组 |

### 7.2 发帖接口

| 接口 | 说明 |
|---|---|
| `post:create` | 创建单账号发帖任务 |
| `post:create-batch` | 创建多账号发帖主任务和子任务 |
| `post:start` | 执行任务 |
| `post:cancel` | 取消任务 |
| `post:get-result` | 获取任务结果 |
| `post:subscribe-events` | 订阅任务进度事件 |

### 7.3 评论接口

| 接口 | 说明 |
|---|---|
| `comment:create` | 创建评论任务 |
| `comment:start` | 执行评论任务 |
| `comment:get-result` | 获取评论结果 |

### 7.4 分组接口

| 接口 | 说明 |
|---|---|
| `group:list` | 获取分组列表 |
| `group:create` | 新建分组 |
| `group:update` | 编辑分组 |
| `group:delete` | 删除分组 |

### 7.5 日志接口

| 接口 | 说明 |
|---|---|
| `log:list` | 分页查询日志 |
| `log:filters` | 获取筛选条件 |
| `log:clear` | 清理日志，建议仅管理员可用 |

---

## 8. 任务执行设计

### 8.1 TaskScheduler

`TaskScheduler` 负责从数据库读取待执行任务，并协调任务 runner。

职责：

1. 控制同一账号同一时间只能执行一个发布或评论任务。
2. 控制多账号任务频率。
3. 更新任务状态。
4. 写入 `task_event` 和 `operation_log`。
5. 出现安全验证时暂停任务并通知前端。

### 8.2 PostTaskRunner

`PostTaskRunner` 执行单个账号的发帖子任务。

核心步骤：

```text
加载账号会话
  -> 检查账号状态
  -> 打开微博发帖页面
  -> 等待用户页面可用
  -> 填写正文
  -> 上传图片
  -> 提交发布
  -> 读取发布结果
  -> 获取微博链接或微博 ID
  -> 更新 post_task
  -> 写日志
```

页面自动化只能用于用户已确认的发布任务，不应包含规避验证码、安全验证或平台风控的逻辑。

### 8.3 CommentTaskRunner

`CommentTaskRunner` 执行发帖后的补充评论。

核心步骤：

```text
校验评论任务
  -> 等待 delay_seconds
  -> 打开微博详情页
  -> 检查是否出现安全验证
  -> 填写评论内容
  -> 提交评论
  -> 更新 comment_task
  -> 写日志
```

---

## 9. 前端页面设计

### 9.1 布局

采用左侧导航 + 右侧工作区。

菜单：

1. 首页
2. 账号
3. 发帖
4. 分组
5. 状态日志

### 9.2 首页

组件：

| 组件 | 内容 |
|---|---|
| `StatsGrid` | 账号、发帖、评论、失败任务统计 |
| `AccountStatusSummary` | 在线、离线、失效、异常 |
| `RecentTaskList` | 最近发帖/评论任务 |

### 9.3 账号页

组件：

| 组件 | 内容 |
|---|---|
| `AccountList` | 头像、昵称、状态、分组、最近登录 |
| `AccountToolbar` | 添加账号、刷新状态、重新登录、删除 |
| `WeiboBrowserHost` | 承载右侧微博页面 |

### 9.4 发帖页

组件：

| 组件 | 内容 |
|---|---|
| `AccountSelector` | 按账号/分组选择发布账号 |
| `PostEditor` | 正文、字数、话题、@、Emoji |
| `ImageUploader` | 图片选择、预览、删除、校验 |
| `AutoCommentSettings` | 开关、评论内容、延迟、重试 |
| `PublishConfirmDialog` | 多账号发布前确认 |
| `PostResultTable` | 每个账号的发帖和评论结果 |

### 9.5 分组页

组件：

| 组件 | 内容 |
|---|---|
| `GroupList` | 分组列表和账号数量 |
| `GroupEditor` | 新建/编辑分组 |
| `GroupAccountPanel` | 分组内账号管理 |

### 9.6 状态日志页

组件：

| 组件 | 内容 |
|---|---|
| `LogFilterBar` | 账号、类型、状态、时间 |
| `LogTable` | 日志列表 |
| `TaskEventDrawer` | 查看任务事件明细 |

---

## 10. 安全与合规设计

### 10.1 合规边界

系统明确不实现：

1. 验证码识别。
2. 安全验证绕过。
3. 破解登录。
4. 风控规避。
5. 未授权账号操作。
6. 垃圾评论或恶意刷屏。

系统必须实现：

1. 用户人工登录。
2. 多账号发布前人工确认。
3. 自动评论仅用于当前账号对自己刚发布内容的补充说明。
4. 操作日志保留。
5. 出现验证、安全提示或异常时暂停任务。

### 10.2 本地数据安全

| 数据 | 处理方式 |
|---|---|
| 微博账号密码 | 不采集、不保存 |
| Cookie/Token | 使用 Electron 安全存储或系统级安全能力加密 |
| profile 目录 | 按账号隔离，删除账号时可清理 |
| SQLite 数据库 | 存放在本地应用数据目录 |
| 图片文件 | 存放在 `uploads`，发布后按策略保留或清理 |

### 10.3 IPC 安全

1. Renderer 关闭 Node.js 直接访问能力。
2. 使用 preload 暴露白名单 API。
3. 所有 IPC 参数做 schema 校验。
4. 文件路径必须限制在应用数据目录或用户选择的文件范围内。
5. 禁止 Renderer 直接执行任意系统命令。

---

## 11. 错误处理

| 场景 | 前端提示 | 后端处理 |
|---|---|---|
| 账号登录失效 | 提示重新登录 | 账号状态设为 `expired`，写日志 |
| 微博页面加载失败 | 提示刷新或重试 | 任务失败，记录错误 |
| 图片格式不支持 | 提示格式限制 | 阻止任务创建 |
| 图片过大 | 提示大小限制 | 阻止任务创建 |
| 发帖失败 | 展示失败原因 | `post_task.status = failed` |
| 评论失败 | 展示失败原因 | `comment_task.status = failed` |
| 出现安全验证 | 提示人工处理 | 暂停任务或标记失败 |
| 数据库异常 | 提示系统异常 | 写系统日志 |

---

## 12. 测试与验收

### 12.1 单元测试

重点覆盖：

1. 表单校验。
2. 任务状态流转。
3. 主任务聚合逻辑。
4. 日志写入逻辑。
5. 分组增删改。

### 12.2 集成测试

重点覆盖：

1. 账号添加流程。
2. 独立会话切换。
3. 单账号发帖任务创建。
4. 多账号主子任务创建。
5. 自动评论跳过和失败规则。
6. 日志筛选。

### 12.3 手工验收

按 PRD 验收标准执行：

1. 添加账号后能打开微博登录页。
2. 人工登录成功后能识别昵称和头像。
3. 不同账号右侧页面能正确切换。
4. 多个账号登录态互不影响。
5. 未选择账号、正文为空时不能发帖。
6. 多账号发布前必须展示确认。
7. 某个账号失败不影响其他账号。
8. 发帖成功后可记录微博链接。
9. 自动评论成功、失败、跳过均有状态记录。
10. 登录、发帖、评论均有日志。

---

## 13. MVP 开发计划

### 阶段 1：项目骨架

交付：

1. Electron + Vue 3 项目初始化。
2. SQLite 初始化和 migration 机制。
3. 左侧菜单和基础页面路由。
4. preload IPC 白名单。

### 阶段 2：账号和浏览器会话

交付：

1. 添加账号入口。
2. 微博登录窗口。
3. 独立 session partition。
4. 账号列表。
5. 右侧微博页面切换。
6. 登录日志。

### 阶段 3：首页和日志

交付：

1. 首页统计。
2. 操作日志表。
3. 日志分页列表。
4. 基础筛选。

### 阶段 4：发帖任务

交付：

1. 账号选择。
2. 发帖正文编辑。
3. 图片校验和预览。
4. 单账号发帖任务。
5. 发帖结果记录。

### 阶段 5：多账号发帖

交付：

1. 按账号和分组选择。
2. 发布前确认。
3. 主任务和子任务。
4. 受控顺序执行。
5. 多账号结果表。

### 阶段 6：自动评论

交付：

1. 自动评论设置。
2. 评论任务创建。
3. 评论延迟和有限重试。
4. 评论结果记录。
5. 安全验证暂停提示。

### 阶段 7：分组和打磨

交付：

1. 分组 CRUD。
2. 账号加入分组。
3. 按分组发帖。
4. 空状态、错误提示、加载状态。
5. 验收测试和文档补充。

---

## 14. 后续扩展

V1.1：

1. 评论模板。
2. 话题库。
3. 图片素材库。
4. 失败任务重试。
5. 更完整日志筛选。

V1.2：

1. 定时发帖。
2. 批量任务看板。
3. 账号健康状态检测。
4. 发帖和评论数据统计。
5. 分组批量任务配置。

---

## 15. 关键风险

| 风险 | 影响 | 应对 |
|---|---|---|
| 微博页面结构变化 | 发帖或评论流程失效 | 封装页面操作适配层，失败时提示人工处理 |
| 登录态过期 | 任务无法执行 | 标记 `expired`，提示重新登录 |
| 安全验证 | 自动任务中断 | 暂停任务，用户手动处理 |
| 多账号频率过高 | 触发平台限制 | 默认顺序执行，发布前确认，限制频率 |
| 本地数据泄露 | 登录信息风险 | 不存密码，会话加密，按账号隔离 |
| 自动评论误用 | 合规风险 | 限定当前账号评论自己的新发内容，保留日志 |

---

## 16. 结论

MVP 的最佳落地路径是先把本地桌面端、独立会话、账号列表和右侧微博页面做稳，再实现单账号发帖、多账号任务和自动评论。任务系统、日志系统和合规边界应从第一阶段就纳入设计，否则后续很容易在批量发布和异常恢复上返工。

