'use strict';
/* 聚一聚 · 房间服务端（SQLite 版）
 * 零第三方依赖：node:http + node:sqlite + SSE 实时广播
 * 用法：node server.js        → http://localhost:8080
 *      DB_PATH=/data/x.db PORT=3000 node server.js
 */
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const ROOT = __dirname;
const DB_PATH = process.env.DB_PATH || path.join(ROOT, 'data', 'meetup.db');
const MAX_BODY = 256 * 1024;
const ID_RE = /^[a-z0-9]{4,12}$/;

/* ---------------- 数据库 ---------------- */
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;

  CREATE TABLE IF NOT EXISTS rooms (
    id          TEXT PRIMARY KEY,
    title       TEXT    NOT NULL,
    expected    INTEGER NOT NULL DEFAULT 15,
    rev         INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS members (
    id          TEXT PRIMARY KEY,
    room_id     TEXT    NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    token       TEXT    NOT NULL UNIQUE,
    name        TEXT    NOT NULL,
    city        TEXT    NOT NULL DEFAULT '',
    max_hours   INTEGER NOT NULL DEFAULT 0,
    budget      INTEGER NOT NULL DEFAULT 0,
    months      TEXT    NOT NULL DEFAULT '[]',
    dests       TEXT    NOT NULL DEFAULT '[]',
    note        TEXT    NOT NULL DEFAULT '',
    pwd_salt    TEXT    NOT NULL DEFAULT '',
    pwd_hash    TEXT    NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    UNIQUE (room_id, name)
  );
  CREATE INDEX IF NOT EXISTS idx_members_room ON members(room_id);

  CREATE TABLE IF NOT EXISTS thoughts (
    id          TEXT PRIMARY KEY,
    room_id     TEXT    NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    member_id   TEXT    NOT NULL,
    name        TEXT    NOT NULL,
    text        TEXT    NOT NULL,
    ts          INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_thoughts_room ON thoughts(room_id, ts);

  CREATE TABLE IF NOT EXISTS identities (
    name        TEXT PRIMARY KEY,
    pwd_salt    TEXT NOT NULL,
    pwd_hash    TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    last_seen   INTEGER NOT NULL DEFAULT 0
  );
`);

/* 兼容老库：补上身份码两列 */
{
  const cols = db.prepare('PRAGMA table_info(members)').all().map(c => c.name);
  if (!cols.includes('pwd_salt')) db.exec("ALTER TABLE members ADD COLUMN pwd_salt TEXT NOT NULL DEFAULT ''");
  if (!cols.includes('pwd_hash')) db.exec("ALTER TABLE members ADD COLUMN pwd_hash TEXT NOT NULL DEFAULT ''");
}

/* 老库迁移：把成员上的身份码汇总成全局身份（同名取最早创建的一条） */
{
  const rows = db.prepare(`SELECT name, pwd_salt, pwd_hash, MIN(created_at) AS t FROM members
    WHERE pwd_hash <> '' GROUP BY name ORDER BY t ASC`).all();
  const ins = db.prepare('INSERT OR IGNORE INTO identities (name, pwd_salt, pwd_hash, created_at, last_seen) VALUES (?, ?, ?, ?, ?)');
  rows.forEach(r => ins.run(r.name, r.pwd_salt, r.pwd_hash, r.t, r.t));
}

const q = {
  room: db.prepare('SELECT * FROM rooms WHERE id = ?'),
  roomCount: db.prepare('SELECT COUNT(*) AS n FROM rooms'),
  insertRoom: db.prepare('INSERT INTO rooms (id, title, expected, rev, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)'),
  renameRoom: db.prepare('UPDATE rooms SET title = ?, updated_at = ? WHERE id = ?'),
  setExpected: db.prepare('UPDATE rooms SET expected = ?, updated_at = ? WHERE id = ?'),
  bump: db.prepare('UPDATE rooms SET rev = rev + 1, updated_at = ? WHERE id = ?'),

  members: db.prepare('SELECT * FROM members WHERE room_id = ? ORDER BY created_at ASC'),
  memberByToken: db.prepare('SELECT * FROM members WHERE token = ?'),
  memberByName: db.prepare('SELECT * FROM members WHERE room_id = ? AND name = ?'),
  membersByName: db.prepare(`SELECT m.*, r.title AS room_title, r.updated_at AS room_updated
    FROM members m JOIN rooms r ON r.id = m.room_id WHERE m.name = ? ORDER BY m.updated_at DESC`),

  identity: db.prepare('SELECT * FROM identities WHERE name = ?'),
  identities: db.prepare('SELECT * FROM identities ORDER BY last_seen DESC'),
  insertIdentity: db.prepare('INSERT INTO identities (name, pwd_salt, pwd_hash, created_at, last_seen) VALUES (?, ?, ?, ?, ?)'),
  setIdentityPwd: db.prepare('UPDATE identities SET pwd_salt = ?, pwd_hash = ? WHERE name = ?'),
  touchIdentity: db.prepare('UPDATE identities SET last_seen = ? WHERE name = ?'),
  deleteIdentity: db.prepare('DELETE FROM identities WHERE name = ?'),
  insertMember: db.prepare(`INSERT INTO members
    (id, room_id, token, name, city, max_hours, budget, months, dests, note, pwd_salt, pwd_hash, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  setPwd: db.prepare('UPDATE members SET pwd_salt = ?, pwd_hash = ?, updated_at = ? WHERE id = ?'),
  setToken: db.prepare('UPDATE members SET token = ?, updated_at = ? WHERE id = ?'),
  updateMember: db.prepare(`UPDATE members SET name = ?, city = ?, max_hours = ?, budget = ?,
    months = ?, dests = ?, note = ?, updated_at = ? WHERE id = ?`),
  deleteMember: db.prepare('DELETE FROM members WHERE id = ?'),

  thoughts: db.prepare('SELECT * FROM thoughts WHERE room_id = ? ORDER BY ts ASC LIMIT 200'),
  insertThought: db.prepare('INSERT INTO thoughts (id, room_id, member_id, name, text, ts) VALUES (?, ?, ?, ?, ?, ?)'),
  thoughtById: db.prepare('SELECT * FROM thoughts WHERE id = ?'),
  deleteThought: db.prepare('DELETE FROM thoughts WHERE id = ?')
};

/* ---------------- 工具 ---------------- */
const now = () => Date.now();
const newToken = () => crypto.randomBytes(18).toString('hex');
const newId = (n) => crypto.randomBytes(16).toString('hex').slice(0, n || 8);
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const int = (v, min, max, dflt) => {
  const n = Number(v);
  if (!isFinite(n)) return dflt || 0;
  return Math.max(min, Math.min(max, Math.round(n)));
};
function parseJson(text, fallback) {
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v : fallback;
  } catch { return fallback; }
}

/* ---------------- 在线状态（只存在内存） ---------------- */
const watchers = new Map();   // roomId -> Set(conn)
const bcastTimers = new Map();

function onlineIds(roomId) {
  const set = new Set();
  const conns = watchers.get(roomId);
  if (conns) conns.forEach(c => { if (c.memberId) set.add(c.memberId); });
  return set;
}

/* ---------------- 房间快照 ---------------- */
function payload(roomId) {
  const room = q.room.get(roomId);
  if (!room) return null;
  const online = onlineIds(roomId);
  return {
    id: room.id,
    title: room.title,
    expected: room.expected,
    rev: room.rev,
    updatedAt: room.updated_at,
    online: online.size,
    members: q.members.all(roomId).map(m => ({
      id: m.id,
      name: m.name,
      city: m.city,
      maxHours: m.max_hours,
      budget: m.budget,
      months: parseJson(m.months, []),
      dests: parseJson(m.dests, []),
      note: m.note,
      updatedAt: m.updated_at,
      online: online.has(m.id)
    })),
    thoughts: q.thoughts.all(roomId).map(t => ({
      id: t.id, memberId: t.member_id, name: t.name, text: t.text, ts: t.ts
    }))
  };
}

function publish(roomId) {
  if (!q.room.get(roomId)) return;
  q.bump.run(now(), roomId);
  if (bcastTimers.has(roomId)) return;
  bcastTimers.set(roomId, setTimeout(() => {
    bcastTimers.delete(roomId);
    const conns = watchers.get(roomId);
    if (!conns || !conns.size) return;
    const data = payload(roomId);
    if (!data) return;
    const msg = 'event: room\ndata: ' + JSON.stringify(data) + '\n\n';
    conns.forEach(c => { try { c.res.write(msg); } catch { } });
  }, 60));
}

/* ---------------- HTTP 工具 ---------------- */
function send(res, status, obj, headers) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  }, headers || {}));
  res.end(body);
}
const need = (cond, status, msg) => { if (!cond) throw Object.assign(new Error(msg), { status }); };

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('请求太大'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('JSON 格式错误'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function cleanMember(input) {
  const out = {};
  if (input.name !== undefined) out.name = str(input.name, 12);
  if (input.city !== undefined) out.city = str(input.city, 20);
  if (input.maxHours !== undefined) out.maxHours = int(input.maxHours, 0, 48, 0);
  if (input.budget !== undefined) out.budget = int(input.budget, 0, 1000000, 0);
  if (input.note !== undefined) out.note = str(input.note, 80);
  if (input.months !== undefined) {
    out.months = [...new Set((Array.isArray(input.months) ? input.months : [])
      .map(Number).filter(x => x >= 1 && x <= 12))].sort((a, b) => a - b).slice(0, 12);
  }
  if (input.dests !== undefined) {
    out.dests = (Array.isArray(input.dests) ? input.dests : []).map(s => str(s, 20)).filter(Boolean).slice(0, 8);
  }
  return out;
}

/* ---------------- 业务 ---------------- */
function createRoom(title) {
  const id = (() => {
    for (let i = 0; i < 50; i++) {
      const cand = newId(6);
      if (!q.room.get(cand)) return cand;
    }
    return newId(8);
  })();
  const t = now();
  q.insertRoom.run(id, str(title, 20) || '我们的群', 15, t, t);
  return q.room.get(id);
}

/* ---------------- 身份码（每个人自己的简单密码） ---------------- */
const CODE_RE = /^[A-Za-z0-9]{4,12}$/;
const attempts = new Map();

function hashPwd(code, salt) {
  return crypto.scryptSync(String(code), salt, 32).toString('hex');
}
function sameHash(a, b) {
  try {
    const A = Buffer.from(String(a), 'hex'), B = Buffer.from(String(b), 'hex');
    return A.length === B.length && A.length > 0 && crypto.timingSafeEqual(A, B);
  } catch { return false; }
}
function attemptKey(roomId, name) { return roomId + '\u0000' + name; }
function lockedOut(key) {
  const rec = attempts.get(key);
  if (!rec) return false;
  if (now() - rec.ts > 5 * 60 * 1000) { attempts.delete(key); return false; }
  return rec.n >= 10;
}
function noteFail(key) {
  const rec = attempts.get(key) || { n: 0, ts: now() };
  rec.n++;
  rec.ts = now();
  attempts.set(key, rec);
}

/**
 * 昵称 + 身份码登录（身份是全局的，不按房间区分）：
 *  - 昵称没见过 → 建身份，这串身份码成为该昵称的密码
 *  - 昵称已存在 → 必须对上身份码，否则拒绝（换房间也一样）
 */
function authJoin(roomId, name, code) {
  const key = attemptKey(roomId, name);
  need(!lockedOut(key), 429, '身份码错太多次了，等几分钟再试');

  const t = now();
  let identity = q.identity.get(name);

  if (!identity) {
    const salt = crypto.randomBytes(16).toString('hex');
    q.insertIdentity.run(name, salt, hashPwd(code, salt), t, t);
    identity = q.identity.get(name);
  } else if (!identity.pwd_hash) {
    // 老数据没有密码：第一次输入的码成为密码
    const salt = crypto.randomBytes(16).toString('hex');
    q.setIdentityPwd.run(salt, hashPwd(code, salt), name);
    identity = q.identity.get(name);
  } else if (!sameHash(hashPwd(code, identity.pwd_salt), identity.pwd_hash)) {
    noteFail(key);
    throw Object.assign(new Error('身份码不对'), { status: 403 });
  }
  attempts.delete(key);
  q.touchIdentity.run(t, name);

  const token = newToken();
  const exist = q.memberByName.get(roomId, name);

  if (exist) {
    q.setToken.run(token, t, exist.id);
    q.setPwd.run(identity.pwd_salt, identity.pwd_hash, t, exist.id);
    publish(roomId);
    return { token, memberId: exist.id, isNew: false };
  }

  const id = newId(8);
  try {
    q.insertMember.run(id, roomId, token, name, '', 0, 0, '[]', '[]', '', identity.pwd_salt, identity.pwd_hash, t, t);
  } catch (err) {
    if (/UNIQUE/i.test(String(err.message))) {
      throw Object.assign(new Error('这个昵称已经有人在用了，换一个吧'), { status: 409 });
    }
    throw err;
  }
  publish(roomId);
  return { token, memberId: id, isNew: true };
}

function updateMember(member, patch) {
  if (patch.name && patch.name !== member.name) {
    need(!q.identity.get(patch.name), 409, '这个昵称已经有人在用了');
    db.prepare('UPDATE identities SET name = ? WHERE name = ?').run(patch.name, member.name);
    db.prepare('UPDATE members SET name = ? WHERE name = ?').run(patch.name, member.name);
    member.name = patch.name;
  }
  const next = {
    name: patch.name !== undefined ? patch.name : member.name,
    city: patch.city !== undefined ? patch.city : member.city,
    maxHours: patch.maxHours !== undefined ? patch.maxHours : member.max_hours,
    budget: patch.budget !== undefined ? patch.budget : member.budget,
    months: patch.months !== undefined ? patch.months : parseJson(member.months, []),
    dests: patch.dests !== undefined ? patch.dests : parseJson(member.dests, []),
    note: patch.note !== undefined ? patch.note : member.note
  };
  q.updateMember.run(next.name, next.city, next.maxHours, next.budget,
    JSON.stringify(next.months), JSON.stringify(next.dests), next.note, now(), member.id);
  publish(member.room_id);
  return next;
}

/* ---------------- SSE ---------------- */
function openStream(req, res, roomId, token) {
  const member = token ? q.memberByToken.get(token) : null;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('retry: 3000\n\n');

  const conn = { res, memberId: member ? member.id : null };
  if (!watchers.has(roomId)) watchers.set(roomId, new Set());
  watchers.get(roomId).add(conn);

  const data = payload(roomId);
  if (data) { try { res.write('event: room\ndata: ' + JSON.stringify(data) + '\n\n'); } catch { } }

  const ka = setInterval(() => { try { res.write(': keepalive\n\n'); } catch { } }, 25000);

  const cleanup = () => {
    clearInterval(ka);
    const set = watchers.get(roomId);
    if (set) { set.delete(conn); if (!set.size) watchers.delete(roomId); }
    publish(roomId);
  };
  req.on('close', cleanup);
  req.on('error', cleanup);

  publish(roomId);
}

/* ---------------- 路由 ---------------- */
async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean);
  const method = req.method;

  if (parts[1] === 'ping') {
    return send(res, 200, { ok: true, db: 'sqlite', rooms: q.roomCount.get().n, ts: now() });
  }

  /* ---------- 身份（全局，先校验再列房间） ---------- */
  if (parts[1] === 'identity' && parts[2] === 'rooms' && method === 'POST') {
    const body = await readBody(req);
    const name = str(body.name, 12);
    const code = String(body.code == null ? '' : body.code).trim();
    need(!!name, 400, '昵称不能为空');
    need(CODE_RE.test(code), 400, '身份码要 4~12 位字母或数字');
    const identity = q.identity.get(name);
    need(!!identity, 404, '没有这个身份，先用它进一次房间');
    need(sameHash(hashPwd(code, identity.pwd_salt), identity.pwd_hash), 403, '身份码不对');
    const rooms = q.membersByName.all(name).map(m => ({
      id: m.room_id, title: m.room_title, city: m.city, updatedAt: m.updated_at
    }));
    return send(res, 200, { name, rooms });
  }

  if (parts[1] === 'identity' && parts[2] === 'leave' && method === 'POST') {
    const body = await readBody(req);
    const name = str(body.name, 12);
    const code = String(body.code == null ? '' : body.code).trim();
    const roomId = str(body.room, 16);
    need(CODE_RE.test(code) && !!name, 400, '参数不全');
    const identity = q.identity.get(name);
    need(!!identity, 404, '没有这个身份');
    need(sameHash(hashPwd(code, identity.pwd_salt), identity.pwd_hash), 403, '身份码不对');
    const m = q.memberByName.get(roomId, name);
    need(!!m, 404, '这个房间里没有你的资料');
    q.deleteMember.run(m.id);
    publish(roomId);
    return send(res, 200, { ok: true });
  }

  /* ---------- 管理员 ---------- */
  if (parts[1] === 'admin') {
    const given = req.headers['x-admin-token'] || url.searchParams.get('token') || '';
    need(!!ADMIN_TOKEN && given === ADMIN_TOKEN, 403, ADMIN_TOKEN ? '管理员口令不对' : '服务端没有设置 ADMIN_TOKEN');

    if (parts[2] === 'summary' && method === 'GET') {
      const rooms = db.prepare(`SELECT r.id, r.title, r.expected, r.created_at, r.updated_at,
        (SELECT COUNT(*) FROM members m WHERE m.room_id = r.id) AS members
        FROM rooms r ORDER BY r.updated_at DESC`).all();
      const identities = q.identities.all().map(i => ({
        name: i.name, lastSeen: i.last_seen,
        rooms: db.prepare('SELECT COUNT(*) AS n FROM members WHERE name = ?').get(i.name).n
      }));
      return send(res, 200, { rooms, identities });
    }

    if (parts[2] === 'room' && parts[3] && method === 'DELETE') {
      const roomId = str(parts[3], 16);
      need(!!q.room.get(roomId), 404, '房间不存在');
      db.prepare('DELETE FROM thoughts WHERE room_id = ?').run(roomId);
      db.prepare('DELETE FROM members WHERE room_id = ?').run(roomId);
      db.prepare('DELETE FROM rooms WHERE id = ?').run(roomId);
      return send(res, 200, { ok: true });
    }

    if (parts[2] === 'identity' && parts[3] && method === 'DELETE') {
      const name = decodeURIComponent(parts[3]);
      db.prepare('DELETE FROM members WHERE name = ?').run(name);
      q.deleteIdentity.run(name);
      return send(res, 200, { ok: true });
    }

    if (parts[2] === 'cleanup' && method === 'POST') {
      const orphanMembers = db.prepare('DELETE FROM members WHERE name NOT IN (SELECT name FROM identities)').run();
      const idleIdentities = db.prepare('DELETE FROM identities WHERE name NOT IN (SELECT name FROM members)').run();
      return send(res, 200, {
        removedMembers: Number(orphanMembers.changes || 0),
        removedIdentities: Number(idleIdentities.changes || 0)
      });
    }

    throw Object.assign(new Error('未知管理接口'), { status: 404 });
  }

  if (parts[1] === 'room' && !parts[2]) {
    need(method === 'POST', 405, '用 POST 建房间');
    const body = await readBody(req);
    const room = createRoom(body.title);
    return send(res, 201, { room: payload(room.id) });
  }

  const roomId = parts[2];
  need(ID_RE.test(roomId || ''), 400, '房间号不合法');
  const room = q.room.get(roomId);
  need(!!room, 404, '房间不存在或已过期');

  const action = parts[3];

  if (action === 'stream' && method === 'GET') {
    return openStream(req, res, roomId, url.searchParams.get('token') || '');
  }

  if (!action && method === 'GET') {
    const member = url.searchParams.get('token') ? q.memberByToken.get(url.searchParams.get('token')) : null;
    return send(res, 200, {
      room: payload(roomId),
      me: member ? { id: member.id, name: member.name } : null
    });
  }

  const body = await readBody(req);

  if (action === 'join' && method === 'POST') {
    const name = str(body.name, 12);
    const code = String(body.code == null ? '' : body.code).trim();
    need(!!name, 400, '昵称不能为空');
    need(CODE_RE.test(code), 400, '身份码要 4~12 位字母或数字');
    const out = authJoin(roomId, name, code);
    return send(res, 200, {
      token: out.token, memberId: out.memberId, isNew: out.isNew,
      room: payload(roomId)
    });
  }

  const member = body.token ? q.memberByToken.get(String(body.token)) : null;

  if (action === 'member' && method === 'POST') {
    need(!!member && member.room_id === roomId, 401, '身份已失效，请重新进入房间');
    const patch = cleanMember(body.member || {});
    updateMember(member, patch);
    return send(res, 200, { room: payload(roomId), me: { id: member.id, name: patch.name || member.name } });
  }

  if (action === 'member' && method === 'DELETE') {
    need(!!member && member.room_id === roomId, 401, '身份已失效');
    q.deleteMember.run(member.id);
    publish(roomId);
    return send(res, 200, { room: payload(roomId) });
  }

  if (action === 'thought' && method === 'POST') {
    need(!!member && member.room_id === roomId, 401, '身份已失效，请重新进入房间');
    const text = str(body.text, 200);
    need(!!text, 400, '说点什么吧');
    const t = { id: newId(8), ts: now() };
    q.insertThought.run(t.id, roomId, member.id, member.name, text, t.ts);
    publish(roomId);
    return send(res, 200, { room: payload(roomId), thought: { id: t.id, memberId: member.id, name: member.name, text, ts: t.ts } });
  }

  if (action === 'thought' && method === 'DELETE') {
    need(!!member && member.room_id === roomId, 401, '身份已失效');
    const t = q.thoughtById.get(str(body.id, 40));
    need(!!t && t.room_id === roomId, 404, '这条想法不存在');
    need(t.member_id === member.id, 403, '只能删自己发的');
    q.deleteThought.run(t.id);
    publish(roomId);
    return send(res, 200, { room: payload(roomId) });
  }

  if (action === 'meta' && method === 'PUT') {
    need(!!member && member.room_id === roomId, 401, '身份已失效');
    if (body.title !== undefined) {
      const title = str(body.title, 20) || room.title;
      q.renameRoom.run(title, now(), roomId);
    }
    if (body.expected !== undefined) {
      q.setExpected.run(int(body.expected, 1, 999, room.expected), now(), roomId);
    }
    publish(roomId);
    return send(res, 200, { room: payload(roomId) });
  }

  throw Object.assign(new Error('未知接口'), { status: 404 });
}

/* ---------------- 静态文件 ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

async function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  if (rel === '/admin' || rel === '/admin/') rel = '/admin.html';
  const file = path.join(ROOT, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(ROOT)) return send(res, 403, { error: 'forbidden' });
  if (path.basename(file) === 'server.js' || file.includes(path.sep + 'data' + path.sep)
    || file.endsWith('.db') || file.endsWith('.db-wal') || file.endsWith('.db-shm')) {
    return send(res, 403, { error: 'forbidden' });
  }
  try {
    const buf = await fsp.readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(req.method === 'HEAD' ? undefined : buf);
  } catch {
    send(res, 404, { error: '文件不存在' });
  }
}

/* ---------------- 启动 ---------------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method' });
    return await serveStatic(req, res, url.pathname);
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error('[500]', req.method, url.pathname, err.message);
    if (!res.headersSent) send(res, status, { error: err.message || '服务器错误' });
    else res.end();
  }
});

function shutdown(signal) {
  console.log('\n收到 ' + signal + '，正在关闭…');
  server.close(() => {
    try { db.close(); } catch { }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

server.listen(PORT, HOST, () => {
  const os = require('node:os');
  const ips = Object.values(os.networkInterfaces()).flat()
    .filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
  console.log('聚一聚 · 房间服务已启动');
  console.log('  数据库：' + DB_PATH);
  console.log('  本机：  http://localhost:' + PORT);
  ips.forEach(ip => console.log('  局域网：http://' + ip + ':' + PORT));
  console.log('  打开后点「创建房间」，把 ?r=xxx 的链接发群里');
});
