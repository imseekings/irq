// Industrial Revolution: a Kahoot-style quiz server. No dependencies; needs Node 16+.
// Run: node server.js   (optionally PORT=8080 node server.js)
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const games = new Map();
const rid = () => crypto.randomBytes(8).toString('hex');
const send = (res, code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
const readBody = req => new Promise(r => {
  let b = ''; req.on('data', c => { b += c; if (b.length > 1e6) req.destroy(); });
  req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } });
});

function cleanQuestions(qs) {
  if (!Array.isArray(qs) || !qs.length || qs.length > 100) return null;
  const out = [];
  for (const q of qs) {
    if (!q || typeof q.q !== 'string' || !q.q.trim() || !Array.isArray(q.o)) return null;
    const o = q.o.filter(x => typeof x === 'string' && x.trim()).slice(0, 4).map(x => x.trim().slice(0, 120));
    if (o.length < 2 || !Number.isInteger(q.c) || q.c < 0 || q.c >= o.length) return null;
    out.push({ q: q.q.trim().slice(0, 300), o, c: q.c, s: Math.min(120, Math.max(5, +q.s || 20)) });
  }
  return out;
}

// Streak bonus: starts at 3 correct answers in a row (x1.5), +0.5 per extra answer, capped at x3.
const streakMult = n => n >= 3 ? Math.min(3, 1 + 0.5 * (n - 2)) : 1;
const ranked = g => [...g.players.values()].sort((a, b) => b.score - a.score);

// What each client is allowed to see. Correct answers are only sent after the reveal.
function view(g, client) {
  const q = g.questions[g.qi], ps = ranked(g), showAns = g.phase === 'reveal' || g.phase === 'final';
  const v = { pin: g.pin, phase: g.phase, qi: g.qi, total: g.questions.length, players: ps.map(p => ({ name: p.name, score: p.score, streak: p.streak })) };
  if (g.phase === 'question' || g.phase === 'reveal') {
    v.q = { text: q.q, options: q.o, seconds: q.s };
    v.answered = ps.filter(p => p.ans[g.qi]).length;
    if (g.phase === 'question') v.endsIn = Math.max(0, g.qStart + q.s * 1000 - Date.now());
    else { v.correct = q.c; v.counts = q.o.map((_, k) => ps.filter(p => p.ans[g.qi] && p.ans[g.qi].c === k).length); }
  }
  if (client.role === 'player') {
    const p = g.players.get(client.id);
    if (p) {
      const a = p.ans[g.qi];
      v.me = { name: p.name, score: p.score, rank: ps.indexOf(p) + 1, answered: !!a, streak: p.streak };
      if (showAns && g.phase === 'reveal') { v.me.correct = !!a && a.c === q.c; v.me.points = p.pts[g.qi] || 0; v.me.mult = p.mult[g.qi] || 1; }
    }
  }
  return v;
}
function broadcast(g) {
  for (const c of g.clients) c.res.write('data: ' + JSON.stringify(view(g, c)) + '\n\n');
}
function startQuestion(g, i) {
  g.qi = i; g.phase = 'question'; g.qStart = Date.now();
  clearTimeout(g.timer);
  g.timer = setTimeout(() => reveal(g), g.questions[i].s * 1000 + 500);
  broadcast(g);
}
function reveal(g) {
  if (g.phase !== 'question') return;
  clearTimeout(g.timer);
  const q = g.questions[g.qi];
  for (const p of g.players.values()) {
    const a = p.ans[g.qi]; let pts = 0, mult = 1;
    if (a && a.c === q.c) {
      const base = Math.round(1000 * (1 - Math.min(1, (a.t - g.qStart) / (q.s * 1000)) / 2));
      p.streak++; mult = streakMult(p.streak); pts = Math.round(base * mult);
    } else p.streak = 0;
    p.score += pts; p.pts[g.qi] = pts; p.mult[g.qi] = mult;
  }
  g.phase = 'reveal'; broadcast(g);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    return fs.readFile(path.join(__dirname, 'index.html'), (e, d) => {
      if (e) return send(res, 500, { error: 'index.html missing' });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(d);
    });
  }
  if (req.method === 'GET' && url.pathname === '/api/events') {
    const g = games.get(url.searchParams.get('pin')), role = url.searchParams.get('role');
    if (!g) return send(res, 404, { error: 'No such game' });
    const id = url.searchParams.get('id') || '';
    if (role === 'host' ? url.searchParams.get('token') !== g.hostToken : !(role === 'player' && g.players.has(id))) return send(res, 403, { error: 'Not allowed' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const client = { res, role, id }; g.clients.add(client);
    res.write('data: ' + JSON.stringify(view(g, client)) + '\n\n');
    const ka = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { clearInterval(ka); g.clients.delete(client); });
    return;
  }
  if (req.method !== 'POST') return send(res, 404, { error: 'Not found' });
  const b = await readBody(req);

  if (url.pathname === '/api/create') {
    const questions = cleanQuestions(b.questions);
    if (!questions) return send(res, 400, { error: 'Invalid questions' });
    let pin; do pin = String(1000 + Math.floor(Math.random() * 9000)); while (games.has(pin));
    games.set(pin, { pin, hostToken: rid(), questions, phase: 'lobby', qi: 0, qStart: 0, players: new Map(), clients: new Set(), timer: null, created: Date.now() });
    return send(res, 200, { pin, token: games.get(pin).hostToken });
  }
  const g = games.get(String(b.pin));
  if (!g) return send(res, 404, { error: 'No game with that PIN' });

  if (url.pathname === '/api/join') {
    const name = String(b.name || '').trim().slice(0, 20);
    if (!name) return send(res, 400, { error: 'Enter a nickname' });
    if ([...g.players.values()].some(p => p.name.toLowerCase() === name.toLowerCase())) return send(res, 409, { error: 'That nickname is taken' });
    const id = rid(); g.players.set(id, { name, score: 0, streak: 0, ans: {}, pts: {}, mult: {} });
    broadcast(g); return send(res, 200, { id });
  }
  if (url.pathname === '/api/host') {
    if (b.token !== g.hostToken) return send(res, 403, { error: 'Not allowed' });
    if (b.action === 'start' && g.phase === 'lobby' && g.players.size) startQuestion(g, 0);
    else if (b.action === 'reveal') reveal(g);
    else if (b.action === 'next' && g.phase === 'reveal') {
      if (g.qi + 1 < g.questions.length) startQuestion(g, g.qi + 1); else { g.phase = 'final'; broadcast(g); }
    }
    return send(res, 200, { ok: true });
  }
  if (url.pathname === '/api/answer') {
    const p = g.players.get(b.id), q = g.questions[g.qi], now = Date.now();
    if (!p || g.phase !== 'question' || p.ans[g.qi] || now > g.qStart + q.s * 1000 + 500) return send(res, 400, { error: 'Too late' });
    if (!Number.isInteger(b.choice) || b.choice < 0 || b.choice >= q.o.length) return send(res, 400, { error: 'Bad choice' });
    p.ans[g.qi] = { c: b.choice, t: now };
    if ([...g.players.values()].every(x => x.ans[g.qi])) reveal(g); else broadcast(g);
    return send(res, 200, { ok: true });
  }
  send(res, 404, { error: 'Not found' });
});

setInterval(() => { for (const [pin, g] of games) if (Date.now() - g.created > 6 * 3600e3) { clearTimeout(g.timer); games.delete(pin); } }, 600e3);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Industrial Revolution quiz running:\n  Host (this computer): http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) console.log(`  Players on your network: http://${i.address}:${PORT}`);
});
