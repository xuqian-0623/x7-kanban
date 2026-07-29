# X7 智能制造看板后端

零门槛部署 — 群协同 + 实时同步 + WeCom 回调。

## 🎯 解决了什么问题

之前：群卡片按钮 → 跳浏览器 → 跳出工作流
现在：群卡片按钮 → 后端接住 → 自动更新 state → SSE 推送给所有看板 → 看板秒变绿

## 🚀 一键部署到 Render

1. 把整个项目推到 GitHub（已经完成）
2. 登录 [render.com](https://render.com)
3. 点 **New +** → **Blueprint**
4. 选 `render.yaml` 文件 → 部署
5. 拿到 URL：`https://x7-kanban-backend.onrender.com`

## 📡 API 端点

| 路径 | 方法 | 用途 |
|------|------|------|
| `/api/health` | GET | 健康检查 |
| `/api/projects` | GET | 列出所有项目 |
| `/api/state/:project` | GET/PUT | 读写项目 state |
| `/api/sse/:project` | GET | SSE 实时订阅 |
| `/api/wecom/callback` | POST | WeCom 群消息回调 |
| `/api/wecom/card-action` | POST | 卡片按钮回调 |

## 🤖 WeCom 智能机器人配置

### 后台配置（管理员）
1. 企业微信管理后台 → 应用管理 → 智能机器人
2. 选「API 接收消息」模式
3. Token：自定义（例：`x7kanban2026`）
4. EncodingAESKey：点随机生成
5. **API 接收消息 URL**：`https://x7-kanban-backend.onrender.com/api/wecom/callback`
6. 保存后启用

### 群机器人启用
1. 进入任意群 → 群机器人 → 添加
2. 选刚创建的智能机器人
3. 群内输入：`@智能机器人 延期` 即可触发卡片

## 🔌 前端连接后端

看板 URL 加参数 `?api=https://x7-kanban-backend.onrender.com`：

```
https://xuqian-0623.github.io/x7-kanban/?api=https://x7-kanban-backend.onrender.com
```

- ✅ 自动用后端存储 + SSE 同步
- ✅ 不带 `?api=` 参数时使用 localStorage（向后兼容）
- ✅ 后端不可达时自动降级到 localStorage

## 🧪 本地测试

```bash
cd backend
npm install
npm start
# 访问 http://localhost:3000/api/health
```

## 🗄 数据存储

- SQLite 数据库（`x7-kanban.db`）
- 表：`projects`（每个项目一行 state JSON）、`rework_records`、`action_log`
- Render 免费版自带 1GB 持久化磁盘（需在 `render.yaml` 中已配置）

## 📊 群指令识别（简单规则）

| 用户输入 | 系统响应 |
|---------|---------|
| `@机器人 延期 T2试模 模具开裂 8月1日` | 自动登记延期 + 推确认 |
| `@机器人 报修 节点名 原因` | 触发返修流程 |
| `@机器人 日报` | 推送今日日报 |
| `@机器人 当前进度` | 返回项目进度概览 |

## 🔐 安全建议

- 后端加 WeCom 签名校验（`verifyWecomSignature` 占位）
- 生产环境启用 HTTPS（Render 自动）
- 看板 URL 加鉴权 token（防止未授权访问）

## 📁 目录

```
backend/
├── package.json    # 依赖：express + better-sqlite3 + cors
├── server.js       # 主服务（约 200 行）
├── x7-kanban.db    # SQLite（运行后自动生成）
└── README.md       # 本文件
```