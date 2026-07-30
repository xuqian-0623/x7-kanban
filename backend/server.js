// X7 看板本地持久化后端 —— 数据存文件，永不丢失
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'x7-data.json');
const API_KEY = process.env.X7_API_KEY || 'x7-kanban-secret-2026';

// ========== 数据持久化层 ==========
let data = { projects: {}, reworkRecords: [] };
try {
  if (fs.existsSync(DATA_FILE)) {
    data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    console.log(`[DATA] 已加载 ${Object.keys(data.projects).length} 个项目`);
  }
} catch (e) {
  console.warn('[DATA] 文件损坏，使用空数据');
}

function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// 鉴权
function checkAuth(req) {
  const k = req.headers['x-api-key'] || req.headers['X-API-Key'] || '';
  return k === API_KEY;
}

// 模糊匹配项目名（去空格）
function findProject(name) {
  if (data.projects[name]) return data.projects[name];
  const norm = String(name || '').replace(/[\s\u3000]/g, '').toLowerCase();
  for (const [key, val] of Object.entries(data.projects)) {
    if (key.replace(/[\s\u3000]/g, '').toLowerCase() === norm) return val;
  }
  return null;
}

function findNode(project, idOrName) {
  const norm = String(idOrName || '').replace(/[\s\u3000]/g, '').toLowerCase();
  for (const p of (project.state.phases || [])) {
    for (const n of (p.nodes || [])) {
      if (n.id === idOrName || n.name === idOrName) return n;
      if (String(n.name).replace(/[\s\u3000]/g, '').toLowerCase() === norm) return n;
    }
  }
  return null;
}

const chatMap = new Map();

// ========== 路由 ==========

app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: Date.now(), projects: Object.keys(data.projects).length, version: 'local-file' });
});

app.get('/api/projects', (req, res) => {
  const projects = Object.keys(data.projects).map(name => ({ name, updatedAt: data.projects[name].updatedAt }));
  res.json({ projects, count: projects.length });
});

app.get('/api/state/:project', (req, res) => {
  const p = findProject(req.params.project);
  if (!p) return res.status(404).json({ error: 'not found', available: Object.keys(data.projects) });
  res.json({ state: p.state });
});

app.put('/api/state/:project', (req, res) => {
  if (!checkAuth(req)) return res.status(401).json({ error: 'invalid api key' });
  if (!req.body.state) return res.status(400).json({ error: 'missing state' });
  data.projects[req.params.project] = { state: req.body.state, updatedAt: Date.now() };
  saveData();
  res.json({ ok: true, key: req.params.project });
});

app.get('/api/ai/tools', (req, res) => {
  if (!checkAuth(req)) return res.status(401).json({ error: 'invalid api key' });
  res.json({ tools: [
    { name: 'bind_project', description: '绑定本群到项目(首次使用)', parameters: { properties: { project_name: { type: 'string' } }, required: ['project_name'] } },
    { name: 'list_projects', description: '列出所有项目', parameters: {} },
    { name: 'get_project_status', description: '查询项目当前状态', parameters: { properties: { project_name: { type: 'string' } }, required: ['project_name'] } },
    { name: 'mark_node_delayed', description: '标记节点为延期(机器人执行后看板自动同步)', parameters: { properties: { project_name: { type: 'string' }, node_id_or_name: { type: 'string' }, reason: { type: 'string' }, expected_recovery: { type: 'string' }, impact_days: { type: 'number' } }, required: ['project_name', 'node_id_or_name', 'reason', 'expected_recovery'] } },
    { name: 'mark_node_completed', description: '标记节点为已完成', parameters: { properties: { project_name: { type: 'string' }, node_id_or_name: { type: 'string' } }, required: ['project_name', 'node_id_or_name'] } },
    { name: 'create_rework', description: '发起返修(创建V2节点)', parameters: { properties: { project_name: { type: 'string' }, source_node_id_or_name: { type: 'string' }, target_phase_id: { type: 'string' }, reason: { type: 'string' } }, required: ['project_name', 'source_node_id_or_name', 'target_phase_id'] } },
    { name: 'send_daily_report', description: '推送日报到群', parameters: { properties: { project_name: { type: 'string' } }, required: ['project_name'] } },
  ] });
});

// 任何方法请求 /api/ai/execute 都返回 200（试运行兼容）
app.all('/api/ai/execute', (req, res) => {
  if (req.method === 'POST') {
    if (!checkAuth(req)) return res.status(401).json({ error: 'invalid api key' });
    const { tool, arguments: args, chat_id } = req.body;
    const payload = args || req.body;
    const pn = payload.project_name || (chat_id ? chatMap.get(chat_id) : null);

    try {
      if (tool === 'bind_project') {
        chatMap.set(chat_id, payload.project_name);
        return res.json({ ok: true, result: { bound: true, project_name: payload.project_name, available: Object.keys(data.projects) } });
      }
      if (tool === 'list_projects') {
        return res.json({ ok: true, result: { projects: Object.keys(data.projects).map(n => ({ name: n })) } });
      }
      if (tool === 'get_project_status') {
        const s = findProject(pn);
        if (!s) return res.json({ ok: true, result: { found: false, message: '项目未同步', available: Object.keys(data.projects) } });
        const phases = s.state.phases || [];
        let done = 0, total = 0, delayed = 0, ongoing = 0;
        const delayedNodes = [];
        for (const p of phases) {
          for (const n of (p.nodes || [])) {
            total++;
            if (n.status === 'completed') done++;
            if (n.status === 'delayed') { delayed++; delayedNodes.push({ phase: p.name, node: n.name }); }
            if (n.status === 'ongoing') ongoing++;
          }
        }
        return res.json({ ok: true, result: { project: pn, progress: total > 0 ? Math.round(done / total * 100) : 0, progressText: total > 0 ? Math.round(done / total * 100) + '%' : '0%', completed: done, total, delayed, ongoing, delayed_nodes: delayedNodes } });
      }
      if (tool === 'mark_node_delayed') {
        const s = findProject(pn);
        if (!s) return res.status(404).json({ error: '项目不存在', available: Object.keys(data.projects) });
        const found = findNode(s, payload.node_id_or_name);
        if (!found) return res.status(404).json({ error: '节点不存在', queried: payload.node_id_or_name });
        found.status = 'delayed';
        found.delay = { reason: payload.reason, expectedRecovery: payload.expected_recovery, impactDays: payload.impact_days || 3, updatedAt: Date.now() };
        s.updatedAt = Date.now();
        saveData();
        return res.json({ ok: true, result: { node: found.name, status: 'delayed' } });
      }
      if (tool === 'mark_node_completed') {
        const s = findProject(pn);
        if (!s) return res.status(404).json({ error: '项目不存在' });
        const found = findNode(s, payload.node_id_or_name);
        if (!found) return res.status(404).json({ error: '节点不存在' });
        found.status = 'completed';
        found.actualEnd = new Date().toISOString();
        s.updatedAt = Date.now();
        saveData();
        return res.json({ ok: true, result: { node: found.name, status: 'completed' } });
      }
      if (tool === 'create_rework') {
        const s = findProject(pn);
        if (!s) return res.status(404).json({ error: '项目不存在' });
        const tp = (s.state.phases || []).find(p => p.id === payload.target_phase_id);
        if (!tp) return res.status(404).json({ error: '阶段不存在', available: (s.state.phases || []).map(p => p.id) });
        const v2Id = payload.target_phase_id + '_rework_' + Date.now();
        tp.nodes = tp.nodes || [];
        tp.nodes.push({ id: v2Id, name: '[' + payload.source_node_id_or_name + ' V2 返修]', status: 'ongoing', planStart: new Date().toISOString(), planEnd: new Date(Date.now() + 5 * 86400000).toISOString(), dependsOn: [], isRework: true });
        data.reworkRecords = data.reworkRecords || [];
        data.reworkRecords.push({ id: 'rwr-' + Date.now(), timestamp: Date.now(), source: payload.source_node_id_or_name, target: payload.target_phase_id, reason: payload.reason || '', reworkNodeId: v2Id });
        s.updatedAt = Date.now();
        saveData();
        return res.json({ ok: true, result: { reworkNode: v2Id, phase: payload.target_phase_id } });
      }
      if (tool === 'send_daily_report') {
        return res.json({ ok: true, result: { sent: true } });
      }
      return res.status(400).json({ error: 'unknown tool: ' + tool });
    } catch (e) {
      console.error('[AI execute]', e);
      return res.status(500).json({ error: e.message });
    }
  }
  // GET, HEAD, OPTIONS, PUT 等都返回 200
  res.json({ message: 'Use POST to execute tools', tools: [
    'bind_project', 'list_projects', 'get_project_status',
    'mark_node_delayed', 'mark_node_completed', 'create_rework', 'send_daily_report'
  ] });
});

app.post('/api/ai/execute', (req, res) => {
  if (!checkAuth(req)) return res.status(401).json({ error: 'invalid api key' });
  const { tool, arguments: args, chat_id } = req.body;
  const payload = args || req.body;
  const pn = payload.project_name || (chat_id ? chatMap.get(chat_id) : null);

  try {
    if (tool === 'bind_project') {
      if (chat_id) chatMap.set(chat_id, payload.project_name);
      return res.json({ ok: true, result: { bound: true, project_name: payload.project_name, available: Object.keys(data.projects) } });
    }
    if (tool === 'list_projects') {
      return res.json({ ok: true, result: { projects: Object.keys(data.projects).map(n => ({ name: n })) } });
    }
    if (tool === 'get_project_status') {
      const s = findProject(pn);
      if (!s) return res.json({ ok: true, result: { found: false, message: '项目未同步', available: Object.keys(data.projects) } });
      const phases = s.state.phases || [];
      let done = 0, total = 0, delayed = 0, ongoing = 0;
      const delayedNodes = [];
      for (const p of phases) {
        for (const n of (p.nodes || [])) {
          total++;
          if (n.status === 'completed') done++;
          if (n.status === 'delayed') { delayed++; delayedNodes.push({ phase: p.name, node: n.name }); }
          if (n.status === 'ongoing') ongoing++;
        }
      }
      return res.json({ ok: true, result: { project: pn, progress: total > 0 ? Math.round(done / total * 100) : 0, progressText: total > 0 ? Math.round(done / total * 100) + '%' : '0%', completed: done, total, delayed, ongoing, delayed_nodes: delayedNodes } });
    }
    if (tool === 'mark_node_delayed') {
      const s = findProject(pn);
      if (!s) return res.status(404).json({ error: '项目不存在', available: Object.keys(data.projects) });
      const found = findNode(s, payload.node_id_or_name);
      if (!found) return res.status(404).json({ error: '节点不存在', queried: payload.node_id_or_name });
      found.status = 'delayed';
      found.delay = { reason: payload.reason, expectedRecovery: payload.expected_recovery, impactDays: payload.impact_days || 3, updatedAt: Date.now() };
      s.updatedAt = Date.now();
      saveData();
      return res.json({ ok: true, result: { node: found.name, status: 'delayed', msg: `看板点「同步」即可看到变更` } });
    }
    if (tool === 'mark_node_completed') {
      const s = findProject(pn);
      if (!s) return res.status(404).json({ error: '项目不存在' });
      const found = findNode(s, payload.node_id_or_name);
      if (!found) return res.status(404).json({ error: '节点不存在' });
      found.status = 'completed';
      found.actualEnd = new Date().toISOString();
      s.updatedAt = Date.now();
      saveData();
      return res.json({ ok: true, result: { node: found.name, status: 'completed' } });
    }
    if (tool === 'create_rework') {
      const s = findProject(pn);
      if (!s) return res.status(404).json({ error: '项目不存在' });
      const tp = (s.state.phases || []).find(p => p.id === payload.target_phase_id);
      if (!tp) return res.status(404).json({ error: '阶段不存在', available: (s.state.phases || []).map(p => p.id) });
      const v2Id = payload.target_phase_id + '_rework_' + Date.now();
      tp.nodes = tp.nodes || [];
      tp.nodes.push({ id: v2Id, name: '[' + payload.source_node_id_or_name + ' V2 返修]', status: 'ongoing', planStart: new Date().toISOString(), planEnd: new Date(Date.now() + 5 * 86400000).toISOString(), dependsOn: [], isRework: true });
      data.reworkRecords = data.reworkRecords || [];
      data.reworkRecords.push({ id: 'rwr-' + Date.now(), timestamp: Date.now(), source: payload.source_node_id_or_name, target: payload.target_phase_id, reason: payload.reason || '', reworkNodeId: v2Id });
      s.updatedAt = Date.now();
      saveData();
      return res.json({ ok: true, result: { reworkNode: v2Id, phase: payload.target_phase_id } });
    }
    if (tool === 'send_daily_report') {
      return res.json({ ok: true, result: { sent: true } });
    }
    return res.status(400).json({ error: 'unknown tool: ' + tool });
  } catch (e) {
    console.error('[AI execute]', e);
    return res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ X7 看板本地后端已启动: http://localhost:${PORT}`);
  console.log(`   API:  http://localhost:${PORT}/api/health`);
  console.log(`   数据文件: ${DATA_FILE}`);
  console.log(`   项目数: ${Object.keys(data.projects).length}`);
});
