import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker, { noteKind } from '../worker/index.js';

class MemoryKV {
  constructor() {
    this.values = new Map();
    this.puts = [];
  }

  async get(key) {
    return this.values.get(key) ?? null;
  }

  async put(key, value, options) {
    this.values.set(key, value);
    this.puts.push({ key, value, options });
  }

  async delete(key) {
    this.values.delete(key);
  }
}


function pinRequest(pin, ip = '203.0.113.7') {
  return new Request('https://poster.example/api/unlock', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify({ pin }),
  });
}

test('unlock creates a KV-backed HttpOnly session cookie', async () => {
  const KV = new MemoryKV();
  const response = await worker.fetch(pinRequest('2468'), { KV, POSTER_PIN: '2468' });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie, /^crierbaby_session=[^;]+;/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Strict/);
  assert.equal([...KV.values.keys()].filter((key) => key.startsWith('session:')).length, 1);
});

test('unlock permits five wrong PINs in a 15-minute KV window, then rate limits', async () => {
  const KV = new MemoryKV();
  const env = { KV, POSTER_PIN: '2468' };

  for (let attempt = 1; attempt <= 5; attempt++) {
    const response = await worker.fetch(pinRequest('0000'), env);
    assert.equal(response.status, 401);
    assert.equal((await response.json()).attemptsRemaining, 5 - attempt);
  }

  const blocked = await worker.fetch(pinRequest('2468'), env);
  assert.equal(blocked.status, 429);
  assert.match(blocked.headers.get('retry-after'), /^\d+$/);
  assert.ok(KV.puts.some(({ key, options }) => key.startsWith('pin-attempts:') && options.expirationTtl <= 900));
});

// D1 stand-in: node's built-in SQLite, loaded with the real schema.
function memoryD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const statement = (sql, args = []) => ({
    bind: (...values) => statement(sql, values),
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    first: async () => db.prepare(sql).get(...args) ?? null,
    run: async () => {
      const r = db.prepare(sql).run(...args);
      return { meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } };
    },
  });
  return {
    sqlite: db,
    prepare: (sql) => statement(sql),
    batch: async (list) => { const out = []; for (const s of list) out.push(await s.run()); return out; },
  };
}

async function signedIn() {
  const env = { KV: new MemoryKV(), DB: memoryD1() };
  await env.KV.put('session:test', '{}');
  return env;
}

function upload(hash) {
  const form = new FormData();
  form.set('photo', new File([new Uint8Array([1, 2, 3])], 'photo.jpg', { type: 'image/jpeg' }));
  form.set('width', '800');
  form.set('height', '1000');
  form.set('hash', hash);
  return new Request('https://poster.example/api/photos', { method: 'POST', headers: { cookie: 'crierbaby_session=test' }, body: form });
}

test('the same photo is only kept once while it waits, and can be added again after it leaves', async () => {
  const env = await signedIn();
  const hash = 'a'.repeat(64);

  assert.equal((await worker.fetch(upload(hash), env)).status, 201);
  assert.equal(env.DB.sqlite.prepare('SELECT hash FROM photos').get().hash, hash);
  assert.equal((await (await worker.fetch(upload(hash), env)).json()).duplicate, true);

  // On the schedule but not posted yet: still waiting.
  env.DB.sqlite.exec('DELETE FROM photos');
  env.DB.sqlite.prepare("INSERT INTO posts (slot_day, slot_time, kind, photos, status, created_at) VALUES ('2026-10-01', '18:00', 'standard', ?, 'draft', 'x')")
    .run(JSON.stringify([{ key: 'k', hash }]));
  assert.equal((await (await worker.fetch(upload(hash), env)).json()).duplicate, true);

  // Removed from the stash (or posted): the owner can add it again.
  env.DB.sqlite.exec("UPDATE posts SET status = 'posted'");
  assert.equal((await worker.fetch(upload(hash), env)).status, 201);
});

test('caption writer notes are sorted into link and voice', () => {
  assert.equal(noteKind('Include example.com twice a week'), 'link');
  assert.equal(noteKind('Less emoji, more questions'), 'voice');
});
