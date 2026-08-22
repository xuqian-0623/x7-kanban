# Cloudflare Workers 后端

1. 创建 Workers KV 命名空间 `x7-kanban-data`。
2. 将命名空间 ID 填入 `wrangler.jsonc`。
3. 设置 Worker secret `X7_API_KEY`。
4. 运行 `npm install && npx wrangler deploy`，或在 Cloudflare 控制台连接此 GitHub 仓库部署。

数据保存在 Workers KV，不依赖 Render 文件系统。
