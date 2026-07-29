// X7 智能制造看板后端
// 群协同：WeCom 卡片回调 → state 更新 → SSE 推送给所有看板客户端
import express from 'express';
import cors from 'cors';
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'x7-kanban.db');

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));

// ============================================================
// 数据库
// ============================================================
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// state 表：每个项目一行 JSON
db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    name TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    updated_at INTEGER DEFAULT (strftime('%s','now'))
  );
  CREATE TABLE IF NOT EXISTS rework_records (
    id TEXT PRIMARY KEY,
    project_name TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );
  CREATE TABLE IF NOT EXISTS action_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_name TEXT,
    action TEXT,
    payload TEXT,
    source TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );
`);

const getProject = db.prepare('SELECT state FROM projects WHERE name = ?');
const saveProject = db.prepare(`
  INSERT INTO projects (name, state, updated_at) VALUES (?, ?, strftime('%s','now'))
  ON CONFLICT(name) DO UPDATE SET state = excluded.state, updated_at = strftime('%s','now')
`);
const listProjects = db.prepare('SELECT name, updated_at FROM projects ORDER BY updated_at DESC');
const insertReworkRecord = db.prepare(`INSERT INTO rework_records (id, project_name, payload) VALUES (?, ?, ?)`);
const getReworkRecords = db.prepare(`SELECT payload FROM rework_records WHERE project_name = ? ORDER BY created_at DESC LIMIT 100`);
const insertActionLog = db.prepare(`INSERT INTO action_log (project_name, action, payload, source) VALUES (?, ?, ?, ?)`);

// ============================================================
// SSE 实时推送（所有看板客户端共享）
// ============================================================
const sseClients = new Map(); // projectName → Set<res>
const MAX_SSE_PER_PROJECT = 50;

function addSseClient(projectName, res) {
  if (!sseClients.has(projectName)) sseClients.set(projectName, new Set());
  const set = sseClients.get(projectName);
  if (set.size >= MAX_SSE_PER_PROJECT) {
    // 简单限流：拒绝超额连接
    res.status(503).end();
    return;
  }
  set.add(res);
  res.on('close', () => set.delete(res));
}

function broadcast(projectName, payload) {
  const set = sseClients.get(projectName);
  if (!set) return;
  const data = JSON.stringify(payload);
  for (const res of set) {
    try { res.write(`data: ${data}\n\n`); } catch (e) {}
  }
}

function broadcastAll(payload) {
  const data = JSON.stringify(payload);
  for (const set of sseClients.values()) {
    for (const res of set) {
      try { res.write(`data: ${data}\n\n`); } catch (e) {}
    }
  }
}

// ============================================================
// API 路由
// ============================================================

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: Date.now(), clients: [...sseClients.values()].reduce((a, s) => a + s.size, 0) });
});

// 列出所有项目
app.get('/api/projects', (req, res) => {
  const rows = listProjects.all();
  res.json({ projects: rows });
});

// 获取项目 state（看板打开页面时拉取）
app.get('/api/state/:projectName', (req, res) => {
  const row = getProject.get(req.params.projectName);
  if (!row) return res.status(404).json({ error: 'project not found' });
  try {
    const state = JSON.parse(row.state);
    res.json({ state });
  } catch (e) {
    res.status(500).json({ error: 'state parse failed' });
  }
});

// 保存项目 state（前端自动保存调用）
app.put('/api/state/:projectName', (req, res) => {
  const { state } = req.body;
  if (!state) return res.status(400).json({ error: 'missing state' });
  try {
    saveProject.run(req.params.projectName, JSON.stringify(state));
    insertActionLog.run(req.params.projectName, 'state_save', JSON.stringify({ tick: state.tick || 0 }), 'web');
    broadcast(req.params.projectName, { type: 'STATE_UPDATED', state });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// SSE 订阅（前端 EventSource）
app.get('/api/sse/:projectName', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  // 初始连接成功事件
  res.write(`event: connected\ndata: {"project":"${req.params.projectName}"}\n\n`);
  // 心跳（防止代理超时）
  const heartbeat = setInterval(() => {
    try { res.write(`: heartbeat ${Date.now()}\n\n`); } catch (e) {}
  }, 30000);
  addSseClient(req.params.projectName, res);
  req.on('close', () => clearInterval(heartbeat));
});

// ============================================================
// WeCom 智能机器人 Callback
// 群内点击卡片按钮 → 企微 POST 到这里
// ============================================================

// 验证 WeCom 回调签名（生产环境启用）
function verifyWecomSignature(req) {
  // TODO: 实现签名校验
  // WeCom 智能机器人回调：校验 msg_signature（加密签名）
  return true;
}

// 群成员在群里 @机器人 时触发
app.post('/api/wecom/callback', (req, res) => {
  if (!verifyWecomSignature(req)) return res.status(401).json({ error: 'invalid signature' });

  const { msg_type, text, from, chat_id, chat_type } = req.body;
  insertActionLog.run(chat_id, 'wecom_msg', JSON.stringify(req.body), 'wecom');

  // 群消息处理：识别 "延期" 等指令
  if (msg_type === 'text' && chat_type === 'group' && text) {
    handleGroupCommand(chat_id, from, text);
  }

  // 默认 200 OK（WeCom 要求 5 秒内返回，否则重试）
  res.json({ errcode: 0, errmsg: 'ok' });
});

// 处理群指令
async function handleGroupCommand(projectName, userId, text) {
  // 简单指令识别（后续可扩展为 NLP）
  const trimmed = text.trim();
  // 匹配「延期 节点 原因 日期」
  // 例：「延期 T2试模 模具开裂 8月1日」
  if (trimmed.startsWith('延期') || trimmed.startsWith('@机器人 延期')) {
    // 解析参数
    const m = trimmed.match(/延期\s+(\S+)\s+(.+?)\s+(\d{1,2}月\d{1,2}日|\d{4}-\d{2}-\d{2})/);
    if (m) {
      const [, nodeName, reason, dateStr] = m;
      const row = getProject.get(projectName);
      if (!row) return;
      const state = JSON.parse(row.state);
      // 找节点
      let targetNode = null, targetPhase = null;
      for (const p of state.phases) {
        const n = p.nodes.find(x => x.name === nodeName || x.id === nodeName);
        if (n) { targetNode = n; targetPhase = p; break; }
      }
      if (targetNode) {
        targetNode.status = 'delayed';
        targetNode.delay = { reason, expectedRecovery: new Date(dateStr.replace(/(\d+)月(\d+)日/, '$1-$2')), impactDays: 3, updatedAt: Date.now() };
        saveProject.run(projectName, JSON.stringify(state));
        insertActionLog.run(projectName, 'delay_register', JSON.stringify({ node: nodeName, reason, date: dateStr }), 'wecom');
        broadcast(projectName, { type: 'NODE_DELAYED', nodeId: targetNode.id, reason, expectedRecovery: dateStr });
        // 推送到企微群确认
        await pushWecomMarkdown(projectName, `✅ 已登记延期\n> 节点：${nodeName}\n> 原因：${reason}\n> 恢复：${dateStr}`);
      }
    }
  }
}

// 通用推送到企微 webhook（用户在看板配置后会同步过来）
async function pushWecomMarkdown(projectName, content) {
  const row = getProject.get(projectName);
  if (!row) return;
  const state = JSON.parse(row.state);
  const webhook = state.wecomWebhook;
  if (!webhook) return;
  try {
    await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'markdown', markdown: { content } }),
    });
  } catch (e) { console.warn('[WeCom push]', e.message); }
}

// ============================================================
// 卡片按钮回调（用户在群内卡片上点击按钮）
// ============================================================
app.post('/api/wecom/card-action', async (req, res) => {
  const { action, project_name, node_id, payload } = req.body;
  insertActionLog.run(project_name, 'card_action', JSON.stringify(req.body), 'wecom');
  const row = getProject.get(project_name);
  if (!row) return res.status(404).json({ error: 'project not found' });
  const state = JSON.parse(row.state);

  // 处理不同 action 类型
  if (action === 'delay_confirm' && node_id) {
    // 用户在卡片中确认登记延期
    const node = state.phases.flatMap(p => p.nodes).find(n => n.id === node_id);
    if (node) {
      node.status = 'delayed';
      node.delay = payload?.delay || node.delay;
      saveProject.run(project_name, JSON.stringify(state));
      broadcast(project_name, { type: 'NODE_DELAYED', nodeId: node_id });
    }
  } else if (action === 'rework_confirm' && node_id) {
    // 返修确认
    const srcNode = state.phases.flatMap(p => p.nodes).find(n => n.id === node_id);
    if (srcNode && payload?.targetPhaseId) {
      const v2Id = payload.targetPhaseId + '_rework_v2_' + Date.now();
      const newRework = { id: v2Id, name: `[${srcNode.name} V2 返修]`, status: 'ongoing', planStart: new Date(), planEnd: new Date(Date.now() + 5 * 86400000), dependsOn: [], isRework: true, reworkSource: node_id };
      state.phases = state.phases.map(p => p.id === payload.targetPhaseId ? { ...p, nodes: [...p.nodes, newRework] } : p);
      const record = { id: 'rwr-' + Date.now(), timestamp: Date.now(), sourceNodeId: node_id, sourceNodeName: srcNode.name, targetPhaseId: payload.targetPhaseId, reason: payload.reason || '', status: 'ongoing' };
      state.reworkRecords = [...(state.reworkRecords || []), record];
      saveProject.run(project_name, JSON.stringify(state));
      broadcast(project_name, { type: 'REWORK_CREATED', nodeId: node_id, reworkNodeId: v2Id });
    }
  }

  res.json({ errcode: 0, errmsg: 'ok' });
});

// ============================================================
// 静态托管（生产环境：编译好的前端）
// ============================================================
app.use(express.static(path.join(__dirname, '..', 'deploy')));

// ============================================================
// ============================================================
// AI 智能机器人 API 插件（结构化命令执行）
// AI 智能机器人按 MCP/OpenAPI 协议调用这些端点
// ============================================================

// 项目映射表（chat_id → project_name）
// 在企微群启动时人工绑定，或通过 `绑定 X7` 指令自动记录
const chatProjectMap = new Map();
const getProjectByChat = (chatId) => chatProjectMap.get(chatId) || null;
const bindProject = (chatId, projectName) => { chatProjectMap.set(chatId, projectName); return true; };

// 列出 AI 可调用的函数（OpenAPI 风格，AI 智能机器人「API/MCP 插件」导入）
app.get('/api/ai/tools', (req, res) => {
  res.json({
    tools: [
      {
        name: 'bind_project',
        description: '把当前群聊绑定到某个项目（必须先调用一次，后续指令才能识别项目）',
        parameters: {
          type: 'object',
          properties: { project_name: { type: 'string', description: '项目名称，如"智能空气炸锅 X7"' } },
          required: ['project_name'],
        },
      },
      {
        name: 'list_projects',
        description: '列出所有项目，返回 [{name, updated_at}]',
        parameters: { type: 'object', properties: {} },
      },
      {
        name: 'get_project_status',
        description: '获取项目当前状态：进度、延期、进行中、待开始节点列表',
        parameters: {
          type: 'object',
          properties: { project_name: { type: 'string', description: '项目名称' } },
          required: ['project_name'],
        },
      },
      {
        name: 'mark_node_delayed',
        description: '把某个节点标记为延期，触发实时推送 + SSE 广播到所有看板',
        parameters: {
          type: 'object',
          properties: {
            project_name: { type: 'string' },
            node_id_or_name: { type: 'string', description: '节点 ID 或名称（如 m4 / T2试模）' },
            reason: { type: 'string', description: '延期原因' },
            expected_recovery: { type: 'string', description: '预计恢复日期 YYYY-MM-DD 或 X月X日' },
            impact_days: { type: 'number', description: '影响天数，默认 3' },
          },
          required: ['project_name', 'node_id_or_name', 'reason', 'expected_recovery'],
        },
      },
      {
        name: 'mark_node_completed',
        description: '标记节点完成',
        parameters: {
          type: 'object',
          properties: {
            project_name: { type: 'string' },
            node_id_or_name: { type: 'string' },
          },
          required: ['project_name', 'node_id_or_name'],
        },
      },
      {
        name: 'create_rework',
        description: '发起返修变更（创建 V2 任务），不冻结源节点',
        parameters: {
          type: 'object',
          properties: {
            project_name: { type: 'string' },
            source_node_id_or_name: { type: 'string' },
            target_phase_id: { type: 'string', description: '目标阶段 ID（design/mold/ebo/eb1/batch）' },
            reason: { type: 'string' },
          },
          required: ['project_name', 'source_node_id_or_name', 'target_phase_id'],
        },
      },
      {
        name: 'send_daily_report',
        description: '推送每日项目进度汇报到群',
        parameters: {
          type: 'object',
          properties: { project_name: { type: 'string' } },
          required: ['project_name'],
        },
      },
    ],
  });
});

// 工具执行入口（AI 智能机器人配置时会指向这里）
app.post('/api/ai/execute', async (req, res) => {
  const { tool, arguments: args, chat_id } = req.body;
  if (!tool) return res.status(400).json({ error: 'missing tool name' });
  insertActionLog.run(getProjectByChat(chat_id) || 'unknown', 'ai_tool_call', JSON.stringify({ tool, args }), 'ai-bot');

  // 通过 chat_id 自动识别项目（如果传了 chat_id）
  const autoProject = chat_id ? getProjectByChat(chat_id) : null;
  const projectName = args?.project_name || autoProject;
  if (!projectName && tool !== 'bind_project' && tool !== 'list_projects') {
    return res.status(400).json({ error: 'project_name 必填（可先调用 bind_project 绑定）' });
  }

  try {
    let result;
    switch (tool) {
      case 'bind_project':
        if (!chat_id) return res.status(400).json({ error: 'chat_id 必填' });
        if (!args.project_name) return res.status(400).json({ error: 'project_name 必填' });
        bindProject(chat_id, args.project_name);
        result = { bound: true, chat_id, project_name: args.project_name };
        break;

      case 'list_projects':
        result = { projects: listProjects.all() };
        break;

      case 'get_project_status': {
        const row = getProject.get(projectName);
        if (!row) return res.status(404).json({ error: 'project not found' });
        const state = JSON.parse(row.state);
        const summary = {
          project: projectName,
          progress: (() => {
            const { done, total } = countCompleted(state.phases);
            return total > 0 ? Math.round((done / total) * 100) + '%' : '0%';
          })(),
          total_nodes: state.phases.reduce((a, p) => a + p.nodes.length, 0),
          completed: state.phases.reduce((a, p) => a + p.nodes.filter(n => n.status === 'completed').length, 0),
          delayed: state.phases.reduce((a, p) => a + p.nodes.filter(n => n.status === 'delayed').length, 0),
          ongoing: state.phases.reduce((a, p) => a + p.nodes.filter(n => n.status === 'ongoing').length, 0),
          delayed_nodes: state.phases.flatMap(p => p.nodes.filter(n => n.status === 'delayed').map(n => ({ id: n.id, name: n.name, reason: n.delay?.reason, recovery: n.delay?.expectedRecovery }))),
        };
        result = summary;
        break;
      }

      case 'mark_node_delayed': {
        const row = getProject.get(projectName);
        if (!row) return res.status(404).json({ error: 'project not found' });
        const state = JSON.parse(row.state);
        let targetNode = null, targetPhase = null;
        for (const p of state.phases) {
          const n = p.nodes.find(x => x.id === args.node_id_or_name || x.name === args.node_id_or_name);
          if (n) { targetNode = n; targetPhase = p; break; }
        }
        if (!targetNode) return res.status(404).json({ error: `node ${args.node_id_or_name} not found` });
        // 解析日期：支持 8月1日 / 2026-08-01 / 8/1
        let recovery;
        const dateStr = args.expected_recovery;
        const m = dateStr.match(/(\d+)月(\d+)日/) || dateStr.match(/(\d{4})-(\d{1,2})-(\d{1,2})/) || dateStr.match(/^(\d{1,2})\/(\d{1,2})$/);
        if (m && dateStr.includes('月')) recovery = new Date(new Date().getFullYear(), parseInt(m[1])-1, parseInt(m[2]));
        else if (m && dateStr.includes('-')) recovery = new Date(parseInt(m[1]), parseInt(m[2])-1, parseInt(m[3]));
        else if (m) recovery = new Date(new Date().getFullYear(), parseInt(m[1])-1, parseInt(m[2]));
        else recovery = new Date(dateStr);

        targetNode.status = 'delayed';
        targetNode.delay = { reason: args.reason, expectedRecovery: recovery, impactDays: args.impact_days || 3, updatedAt: Date.now() };
        saveProject.run(projectName, JSON.stringify(state));
        broadcast(projectName, { type: 'NODE_DELAYED', nodeId: targetNode.id, reason: args.reason });
        result = { ok: true, node: targetNode.name, status: 'delayed', recovery: recovery.toISOString().split('T')[0] };
        break;
      }

      case 'mark_node_completed': {
        const row = getProject.get(projectName);
        if (!row) return res.status(404).json({ error: 'project not found' });
        const state = JSON.parse(row.state);
        let targetNode = null;
        for (const p of state.phases) {
          const n = p.nodes.find(x => x.id === args.node_id_or_name || x.name === args.node_id_or_name);
          if (n) { targetNode = n; break; }
        }
        if (!targetNode) return res.status(404).json({ error: `node ${args.node_id_or_name} not found` });
        targetNode.status = 'completed';
        targetNode.actualEnd = new Date();
        saveProject.run(projectName, JSON.stringify(state));
        broadcast(projectName, { type: 'NODE_COMPLETED', nodeId: targetNode.id });
        result = { ok: true, node: targetNode.name, status: 'completed' };
        break;
      }

      case 'create_rework': {
        const row = getProject.get(projectName);
        if (!row) return res.status(404).json({ error: 'project not found' });
        const state = JSON.parse(row.state);
        let srcNode = null;
        for (const p of state.phases) {
          const n = p.nodes.find(x => x.id === args.source_node_id_or_name || x.name === args.source_node_id_or_name);
          if (n) { srcNode = n; break; }
        }
        if (!srcNode) return res.status(404).json({ error: 'source node not found' });
        const targetPhase = state.phases.find(p => p.id === args.target_phase_id);
        if (!targetPhase) return res.status(404).json({ error: 'target phase not found' });
        const v2Id = `${args.target_phase_id}_rework_v2_${Date.now()}`;
        const newRework = { id: v2Id, name: `[${srcNode.name} V2 返修]`, status: 'ongoing', planStart: new Date(), planEnd: new Date(Date.now() + 5 * 86400000), dependsOn: [], isRework: true, reworkSource: srcNode.id };
        state.phases = state.phases.map(p => p.id === args.target_phase_id ? { ...p, nodes: [...p.nodes, newRework] } : p);
        const record = { id: 'rwr-' + Date.now(), timestamp: Date.now(), sourceNodeId: srcNode.id, sourceNodeName: srcNode.name, targetPhaseId: args.target_phase_id, targetPhaseName: targetPhase.name, reason: args.reason || '', status: 'ongoing' };
        state.reworkRecords = [...(state.reworkRecords || []), record];
        saveProject.run(projectName, JSON.stringify(state));
        broadcast(projectName, { type: 'REWORK_CREATED', nodeId: srcNode.id, reworkNodeId: v2Id });
        result = { ok: true, reworkNode: newRework.name };
        break;
      }

      case 'send_daily_report': {
        const row = getProject.get(projectName);
        if (!row) return res.status(404).json({ error: 'project not found' });
        const state = JSON.parse(row.state);
        await pushWecomMarkdown(projectName, `📈 **项目日报：${projectName}**\n> 自动生成于 ${new Date().toLocaleString('zh-CN')}`);
        result = { ok: true, sent: true };
        break;
      }

      default:
        return res.status(400).json({ error: `unknown tool: ${tool}` });
    }

    insertActionLog.run(projectName, 'ai_tool_result', JSON.stringify(result), 'ai-bot');
    res.json({ ok: true, tool, result });
  } catch (e) {
    console.error('[AI tool]', e);
    res.status(500).json({ error: e.message });
  }
});

// 启动
// ============================================================
app.listen(PORT, () => {
  console.log(`✅ X7 看板后端已启动: http://localhost:${PORT}`);
  console.log(`   健康检查: http://localhost:${PORT}/api/health`);
  console.log(`   WeCom 回调: http://localhost:${PORT}/api/wecom/callback`);
  console.log(`   AI 工具列表: http://localhost:${PORT}/api/ai/tools`);
  console.log(`   AI 工具执行: http://localhost:${PORT}/api/ai/execute`);
  console.log(`   数据库: ${DB_PATH}`);
});

// 优雅关闭
process.on('SIGTERM', () => {
  console.log('收到 SIGTERM，关闭服务器');
  db.close();
  process.exit(0);
});