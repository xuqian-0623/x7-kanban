const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,PUT,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,X-API-Key',
  'Cache-Control': 'no-store'
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' } });
}

function normalize(value) {
  return String(value || '').replace(/[\s\u3000]/g, '').toLowerCase();
}

async function findProject(env, requested) {
  const exact = await env.KANBAN_DATA.get('project:' + requested, 'json');
  if (exact) return { name: requested, value: exact };
  const index = await env.KANBAN_DATA.get('projects:index', 'json') || [];
  const name = index.find((item) => normalize(item) === normalize(requested));
  if (!name) return null;
  return { name, value: await env.KANBAN_DATA.get('project:' + name, 'json') };
}

async function saveProject(env, name, state) {
  const updatedAt = Date.now();
  await env.KANBAN_DATA.put('project:' + name, JSON.stringify({ state, updatedAt }));
  const index = await env.KANBAN_DATA.get('projects:index', 'json') || [];
  if (!index.includes(name)) await env.KANBAN_DATA.put('projects:index', JSON.stringify(index.concat(name)));
  return updatedAt;
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);
    if (url.pathname === '/' || url.pathname === '/api/health') {
      const projects = await env.KANBAN_DATA.get('projects:index', 'json') || [];
      return json({ ok: true, time: Date.now(), projects: projects.length, version: 'cloudflare-kv' });
    }
    if (url.pathname === '/api/projects' && request.method === 'GET') {
      const names = await env.KANBAN_DATA.get('projects:index', 'json') || [];
      return json({ projects: names.map((name) => ({ name })), count: names.length });
    }
    const match = url.pathname.match(/^\/api\/state\/(.+)$/);
    if (match) {
      const project = decodeURIComponent(match[1]);
      if (request.method === 'GET') {
        const found = await findProject(env, project);
        if (!found || !found.value) return json({ error: 'not found' }, 404);
        return json({ state: found.value.state, updatedAt: found.value.updatedAt || null });
      }
      if (request.method === 'PUT') {
        if ((request.headers.get('x-api-key') || '') !== env.X7_API_KEY) return json({ error: 'invalid api key' }, 401);
        const body = await request.json().catch(() => null);
        if (!body || !body.state) return json({ error: 'missing state' }, 400);
        const updatedAt = await saveProject(env, project, body.state);
        return json({ ok: true, key: project, updatedAt });
      }
    }
    return json({ error: 'not found' }, 404);
  }
};
