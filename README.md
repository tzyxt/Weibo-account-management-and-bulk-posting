# Weibo Account Management and Bulk Posting

一个基于 `Electron + Vue 3 + SQLite` 的本地桌面端微博账号管理工具，用于管理本人或已获得授权的微博账号，并辅助完成多账号发帖、定时发帖、自动评论和操作记录管理。

> 本项目仅适用于合法授权的账号运营场景。请勿用于垃圾营销、恶意刷屏、骚扰评论或任何违反平台规则的行为。

## 功能概览

- 多账号管理：添加多个微博账号，每个账号使用独立 Electron 会话，登录状态互不影响。
- 人工登录：通过独立登录窗口完成微博登录，不在代码中保存微博明文密码。
- 账号分组：支持创建分组，并将账号归入不同分组，便于批量选择。
- 右侧浏览器区域：在应用内查看和操作当前选中的微博账号页面。
- 单账号发帖：选择一个账号创建发帖任务。
- 多账号批量发帖：选择多个账号后，为每个账号创建独立发帖子任务。
- 定时发帖：创建任务时可指定具体发布时间，到点后由本地任务调度器自动执行。
- 图片发帖：支持选择本地图片作为微博配图。
- 话题/超话辅助：支持插入话题，并提供超话搜索和选择入口。
- 自动评论：发帖成功后可自动发布一条评论。
- 指定评论账号：评论账号可以跟随发帖账号，也可以选择其他已登录且已授权的微博账号。
- 评论后回复：支持在第一条评论下继续回复一条二级评论。
- 状态日志：记录登录、发帖、评论、分组和异常等操作日志。
- 首页统计：展示账号总数、在线账号、发帖总数、评论总数、失败任务等数据。

## 技术栈

- Electron 33
- Vue 3
- TypeScript
- SQLite / better-sqlite3
- electron-vite
- lucide-vue-next

## 本地运行

先安装依赖：

```powershell
npm install
```

如果是第一次安装或更新了 Electron / better-sqlite3，建议重建 native 依赖：

```powershell
npm run rebuild:native
```

启动开发环境：

```powershell
npm run dev
```

如果当前终端里存在 `ELECTRON_RUN_AS_NODE=1`，Electron 可能会被当成 Node 运行。启动前可以先清掉：

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
npm run dev
```

## 常用命令

类型检查：

```powershell
npm run typecheck
```

构建：

```powershell
npm run build
```

预览构建结果：

```powershell
npm run preview
```

## 数据存储说明

账号登录状态、SQLite 数据库和浏览器会话数据保存在本机 Electron `userData` 目录中，不会保存在仓库代码里。

Windows 下通常类似：

```text
C:\Users\<用户名>\AppData\Roaming\weibo-account-manager\weibo-account-manager\
```

其中可能包含：

- `data/app.sqlite`：本地数据库，保存账号列表、任务、日志等。
- `profiles/`：每个账号独立的浏览器会话数据。
- `uploads/`：本地上传文件缓存。

分享代码或上传 GitHub 时，不要上传这些本地数据目录，也不要上传 `node_modules/`、`out/`、`logs/`。

## 任务流程

### 发帖任务

1. 选择一个或多个微博账号。
2. 输入微博正文、话题和配图。
3. 可选择立即发布或指定具体发布时间。
4. 系统为每个账号创建独立任务。
5. 到点后，使用对应账号的独立会话执行发布。

### 评论任务

1. 发帖成功后，如果开启自动评论，会创建评论任务。
2. 评论账号默认使用发帖账号，也可以手动指定其他已登录授权账号。
3. 可设置评论延迟秒数。
4. 可开启“评论后继续回复”，在第一条评论下追加二级评论。

## 风险和限制

- 微博页面结构变化可能导致自动发帖或评论流程失效，需要更新页面定位逻辑。
- 遇到验证码、安全验证或风控提示时，程序不会绕过验证，需要用户手动处理。
- 定时任务依赖本地应用运行；如果应用关闭，到点任务不会自动执行。
- 多账号批量操作应控制频率，避免触发平台限制。

## Git 忽略项

项目已配置 `.gitignore`，默认忽略：

- `node_modules/`
- `out/`
- `logs/`
- `.env*`
- `*.sqlite`
- `profiles/`
- `uploads/`

这些文件可能包含本地构建结果、日志或登录会话数据，不应提交到 GitHub。
