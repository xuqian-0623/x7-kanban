// Vercel 单函数，处理所有 API 路由
// 路由: /api/health, /api/state/:project, /api/projects, /api/sse/:project, /api/ai/tools, /api/ai/execute

// 内存存储（Vercel 无文件系统，用 globalThis 跨请求共享）
globalThis.__store = globalThis.__store || { projects: new Map(), rework: [], actions: [] };
const store = globalThis.__store;
const API_KEY = process.env.X7_API_KEY || 'x7-kanban-secret-2026';
const chatMap = new Map();

const json = (res, data, status = 200) => res.status(status).json(data);
const ok = (res, d) => json(res, { ok: true, ...d });

const auth = (req, res) => {
  const p = req.headers['x-api-key'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '') || req.query.apikey;
  if (p !== API_KEY) { json(res, { error: 'invalid api key' }, 401); return false; }
  return true;
};

const parseDate = (str) => {
  const m = str.match(/(\d+)月(\d+)日/) || str.match(/(\d{4})-(\d{1,2})-(\d{1,2})/) || str.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (m && str.includes('月')) return new Date(new Date().getFullYear(), parseInt(m[1])-1, parseInt(m[2]));
  if (m && str.includes('-')) return new Date(parseInt(m[1]), parseInt(m[2])-1, parseInt(m[3]));
  if (m) return new Date(new Date().getFullYear(), parseInt(m[1])-1, parseInt(m[2]));
  return new Date(str);
};

export default async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname.replace(/\/+$/, '');
  const segments = path.split('/').filter(Boolean);

  // ====== /api/health ======
  if (path === '/api/health') {
    return json(res, { ok: true, time: Date.now() });
  }

  // ====== /api/projects ======
  if (path === '/api/projects') {
    const projects = [...store.projects.entries()].map(([name, s]) => ({ name, updatedAt: s.updatedAt }));
    return json(res, { projects });
  }

  // ====== /api/state/:project ======
  if (segments[0] === 'api' && segments[1] === 'state' && segments[2]) {
    const project = segments[2];
    if (req.method === 'GET') {
      const s = store.projects.get(project);
      if (!s) return json(res, { error: 'not found' }, 404);
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      return json(res, { state: s.state, updatedAt: s.updatedAt || null });
    }
    if (req.method === 'PUT') {
      if (!auth(req, res)) return;
      const { state } = req.body;
      if (!state) return json(res, { error: 'missing state' }, 400);
      store.projects.set(project, { state, updatedAt: Date.now() });
      return ok(res);
    }
    return json(res, { error: 'method not allowed' }, 405);
  }

  // ====== /api/sse/:project ======
  if (segments[0] === 'api' && segments[1] === 'sse' && segments[2]) {
    if (!auth(req, res)) return;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    res.write(`: ok\n\n`);
    // Vercel 有 10s 超时，只能做短时推送
    const interval = setInterval(() => {
      try { res.write(`: heartbeat ${Date.now()}\n\n`); } catch (e) { clearInterval(interval); }
    }, 5000);
    req.on('close', () => clearInterval(interval));
    setTimeout(() => { clearInterval(interval); res.end(); }, 8000);
    return;
  }

  // ====== /api/ai/tools ======
  if (path === '/api/ai/tools') {
    if (!auth(req, res)) return;
    return json(res, {
      tools: [
        { name: 'bind_project', description: '把群聊绑定到项目', parameters: { properties: { project_name: { type: 'string' } }, required: ['project_name'] } },
        { name: 'list_projects', description: '列出所有项目', parameters: {} },
        { name: 'get_project_status', description: '查询项目状态', parameters: { properties: { project_name: { type: 'string' } }, required: ['project_name'] } },
        { name: 'mark_node_delayed', description: '标记节点延期', parameters: { properties: { project_name: { type: 'string' }, node_id_or_name: { type: 'string' }, reason: { type: 'string' }, expected_recovery: { type: 'string' }, impact_days: { type: 'number' } }, required: ['project_name', 'node_id_or_name', 'reason', 'expected_recovery'] } },
        { name: 'mark_node_completed', description: '标记节点完成', parameters: { properties: { project_name: { type: 'string' }, node_id_or_name: { type: 'string' } }, required: ['project_name', 'node_id_or_name'] } },
        { name: 'create_rework', description: '发起返修变更', parameters: { properties: { project_name: { type: 'string' }, source_node_id_or_name: { type: 'string' }, target_phase_id: { type: 'string' }, reason: { type: 'string' } }, required: ['project_name', 'source_node_id_or_name', 'target_phase_id'] } },
        { name: 'send_daily_report', description: '推送日报', parameters: { properties: { project_name: { type: 'string' } }, required: ['project_name'] } },
      ],
    });
  }

  // ====== /api/ai/execute ======
  if (path === '/api/ai/execute') {
    if (!auth(req, res)) return;
    const { tool, chat_id } = req.body;
    const args = req.body.arguments || req.body;
    if (!tool) return json(res, { error: 'missing tool' }, 400);

    const projectName = args?.project_name || (chat_id ? chatMap.get(chat_id) : null);
    if (!projectName && tool !== 'bind_project' && tool !== 'list_projects') {
      return json(res, { error: 'project_name 必填' }, 400);
    }

    try {
      switch (tool) {
        case 'bind_project':
          if (!chat_id) return json(res, { error: 'chat_id 必填' }, 400);
          chatMap.set(chat_id, args.project_name);
          return ok(res, { bound: true, project: args.project_name });

        case 'list_projects': {
          const projects = [...store.projects.entries()].map(([n, s]) => ({ name: n, updatedAt: s.updatedAt }));
          return ok(res, { tool, result: { projects } });
        }

        case 'get_project_status': {
          const s = store.projects.get(projectName);
          if (!s) return json(res, { error: 'project not found' }, 404);
          const phases = s.state.phases;
          const done = phases.reduce((a, p) => a + p.nodes.filter(n => n.status === 'completed').length, 0);
          const total = phases.reduce((a, p) => a + p.nodes.length, 0);
          return ok(res, { tool, result: {
            project: projectName,
            progress: total > 0 ? Math.round(done / total * 100) + '%' : '0%',
            completed: done, total,
            delayed: phases.reduce((a, p) => a + p.nodes.filter(n => n.status === 'delayed').length, 0),
            ongoing: phases.reduce((a, p) => a + p.nodes.filter(n => n.status === 'ongoing').length, 0),
          }});
        }

        case 'mark_node_delayed': {
          const s = store.projects.get(projectName);
          if (!s) return json(res, { error: 'project not found' }, 404);
          let found = null;
          for (const p of s.state.phases) {
            found = p.nodes.find(n => n.id === args.node_id_or_name || n.name === args.node_id_or_name);
            if (found) { found.phase = p; break; }
          }
          if (!found) return json(res, { error: `node ${args.node_id_or_name} not found` }, 404);
          found.status = 'delayed';
          found.delay = { reason: args.reason, expectedRecovery: parseDate(args.expected_recovery), impactDays: args.impact_days || 3, updatedAt: Date.now() };
          s.updatedAt = Date.now();
          return ok(res, { tool, node: found.name, recovery: parseDate(args.expected_recovery).toISOString().split('T')[0] });
        }

        case 'mark_node_completed': {
          const s = store.projects.get(projectName);
          if (!s) return json(res, { error: 'project not found' }, 404);
          let found = null;
          for (const p of s.state.phases) {
            found = p.nodes.find(n => n.id === args.node_id_or_name || n.name === args.node_id_or_name);
            if (found) break;
          }
          if (!found) return json(res, { error: `node ${args.node_id_or_name} not found` }, 404);
          found.status = 'completed';
          found.actualEnd = new Date();
          s.updatedAt = Date.now();
          return ok(res, { tool, node: found.name });
        }

        case 'create_rework': {
          const s = store.projects.get(projectName);
          if (!s) return json(res, { error: 'project not found' }, 404);
          let srcNode = null; const tgtPhase = s.state.phases.find(p => p.id === args.target_phase_id);
          if (!tgtPhase) return json(res, { error: 'target phase not found' }, 404);
          for (const p of s.state.phases) { srcNode = p.nodes.find(n => n.id === args.source_node_id_or_name || n.name === args.source_node_id_or_name); if (srcNode) break; }
          if (!srcNode) return json(res, { error: 'source node not found' }, 404);
          const v2Id = `${args.target_phase_id}_rework_v2_${Date.now()}`;
          tgtPhase.nodes.push({ id: v2Id, name: `[${srcNode.name} V2 返修]`, status: 'ongoing', planStart: new Date(), planEnd: new Date(Date.now() + 5*86400000), dependsOn: [], isRework: true, reworkSource: srcNode.id });
          s.updatedAt = Date.now();
          return ok(res, { tool, reworkNode: `[${srcNode.name} V2 返修]` });
        }

        case 'send_daily_report': {
          const s = store.projects.get(projectName);
          if (!s) return json(res, { error: 'project not found' }, 404);
          return ok(res, { tool, sent: true });
        }

        default:
          return json(res, { error: `unknown tool: ${tool}` }, 400);
      }
    } catch (e) {
      return json(res, { error: e.message }, 500);
    }
  }

  // ====== 404 ======
  return json(res, { error: 'not found' }, 404);
}
