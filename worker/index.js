import { draft } from './ai.js';
import { postToBluesky } from './bluesky.js';
import {
  addDays, DRAFT_AHEAD_DAYS, graphemes, keyPhrases, LIMIT, localParts, looksClash, notesFor, opener, phrases, qaFlags, repeats, worn, MAX_IMAGE_BYTES, MAX_IMAGES, pickAngles, pickPhoto, planKinds, slotTime,
} from './text.js';

// crierbaby: a daily Bluesky poster. D1 (DB) holds photos, posts, caption notes and settings;
// KV holds photo bytes (img:<key>), login sessions and the PIN attempt counter.

const SESSION_COOKIE = 'crierbaby_session';
const SESSION_TTL = 60 * 60 * 24 * 7;
const RATE_LIMIT_TTL = 15 * 60;
const MAX_WRONG_PINS = 5;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; "
    + "connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'X-Robots-Tag': 'noindex, nofollow',
  'Strict-Transport-Security': 'max-age=31536000',
};

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...headers } });
}

function error(message, status = 400, details = {}, headers = {}) {
  return json({ error: message, ...details }, status, headers);
}

function parseCookies(header) {
  const cookies = {};
  for (const part of (header || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (!name) continue;
    try {
      cookies[name] = decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      // Ignore malformed cookies instead of failing the whole request.
    }
  }
  return cookies;
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sameSecret(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  // Comparing fixed-length digests avoids leaking the PIN length or mismatch position.
  const leftHash = await sha256(left);
  const rightHash = await sha256(right);
  let mismatch = 0;
  for (let index = 0; index < leftHash.length; index++) {
    mismatch |= leftHash.charCodeAt(index) ^ rightHash.charCodeAt(index);
  }
  return mismatch === 0;
}

async function readPin(request) {
  const contentType = request.headers.get('content-type') || '';
  if (contentType.includes('application/json')) return (await request.json()).pin;
  if (contentType.includes('form')) return (await request.formData()).get('pin');
  return null;
}

async function unlock(request, env) {
  if (!env.POSTER_PIN) return error('POSTER_PIN is not configured', 500);

  // One shared counter, not per IP: switching IPs must not buy more guesses at a short PIN.
  const rateKey = 'pin-attempts:all';
  const now = Date.now();
  let attempts = null;
  try {
    attempts = JSON.parse(await env.KV.get(rateKey));
  } catch {
    attempts = null;
  }
  if (!attempts || !Number.isFinite(attempts.count) || !Number.isFinite(attempts.resetAt) || attempts.resetAt <= now) {
    attempts = { count: 0, resetAt: now + RATE_LIMIT_TTL * 1000 };
  }

  if (attempts.count >= MAX_WRONG_PINS) {
    const retryAfter = Math.max(1, Math.ceil((attempts.resetAt - now) / 1000));
    return error('Too many incorrect PIN attempts', 429, { retryAfter }, { 'retry-after': String(retryAfter) });
  }

  let pin;
  try {
    pin = await readPin(request);
  } catch {
    return error('Invalid request body');
  }

  if (!(await sameSecret(String(pin ?? ''), env.POSTER_PIN))) {
    attempts.count += 1;
    const ttl = Math.max(60, Math.ceil((attempts.resetAt - now) / 1000));
    await env.KV.put(rateKey, JSON.stringify(attempts), { expirationTtl: ttl });
    return error('Incorrect PIN', 401, { attemptsRemaining: MAX_WRONG_PINS - attempts.count });
  }

  await env.KV.delete(rateKey);
  const token = crypto.randomUUID();
  await env.KV.put(`session:${token}`, JSON.stringify({ createdAt: new Date(now).toISOString() }), {
    expirationTtl: SESSION_TTL,
  });
  const cookie = `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${SESSION_TTL}; HttpOnly; Secure; SameSite=Strict`;
  return json({ ok: true }, 200, { 'set-cookie': cookie });
}

async function isAuthorized(request, env) {
  const token = parseCookies(request.headers.get('cookie'))[SESSION_COOKIE];
  return Boolean(token && await env.KV.get(`session:${token}`));
}

// ---------- data helpers ----------

const parse = (value, fallback) => { try { return JSON.parse(value); } catch { return fallback; } };
const stamp = () => new Date().toISOString();
const all = async (env, sql, ...args) => (await env.DB.prepare(sql).bind(...args).all()).results || [];
const first = (env, sql, ...args) => env.DB.prepare(sql).bind(...args).first();
const run = (env, sql, ...args) => env.DB.prepare(sql).bind(...args).run();

async function getSetting(env, key) {
  return (await first(env, 'SELECT value FROM settings WHERE key = ?', key))?.value;
}
const setSetting = (env, key, value) =>
  run(env, 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);

function apiPost(row) {
  return {
    id: row.id,
    day: row.slot_day,
    time: row.slot_time,
    kind: row.kind,
    photos: parse(row.photos, []).map(({ key, width, height, alt }) => ({ key, width, height, alt })),
    status: row.status,
    caption: row.caption,
    captionOptions: parse(row.caption_options, []),
    manual: Boolean(row.manual),
    error: row.error,
    url: row.url,
  };
}

async function loadImages(env, photos) {
  return Promise.all(photos.map(async (photo) => {
    const data = await env.KV.get(`img:${photo.key}`, 'arrayBuffer');
    if (!data) throw new Error('A photo for this post is missing');
    return { ...photo, data };
  }));
}
const deleteImages = (env, photos) => Promise.allSettled(photos.map((p) => env.KV.delete(`img:${p.key}`)));

async function readJson(request) {
  try { return await request.json(); } catch { return {}; }
}

// ---------- captions ----------

// Writes caption options for a post that is waiting on one (status 'writing'). If the AI refuses, the photo is set
// aside for a manual caption. Results only land if the post is still waiting: if the owner approved, edited,
// or deleted it while the AI was working, the owner's version wins.
async function writeCaption(env, row) {
  const photos = parse(row.photos, []);
  const notes = await all(env, 'SELECT kind, text FROM notes ORDER BY id');
  // The last 100 captions: the AI reads them, and options that reuse their phrases are dropped.
  const recent = (await all(env, "SELECT caption FROM posts WHERE caption != '' AND id != ? ORDER BY COALESCE(posted_at, created_at) DESC LIMIT 100", row.id)).map((r) => r.caption);
  const past = new Set(recent.flatMap((c) => [...phrases(c), ...keyPhrases(c)]));
  const openers = new Set(recent.map(opener));
  try {
    const images = await loadImages(env, photos);
    const brief = { kind: row.kind, day: row.slot_day, today: localParts(new Date()).day, ...notesFor(row.kind, row.slot_day, notes), recent, banned: worn(recent) };
    const fits = (c) => graphemes(c) <= LIMIT; // Bluesky's limit: longer ones can't post
    let out = await draft(env, images, { ...brief, angles: pickAngles() });
    let fresh = out.captions.filter((c) => fits(c) && !repeats(c, past, openers));
    if (!fresh.length) { // every option repeated earlier copy or ran long: retry, then keep the least repetitive
      out = await draft(env, images, { ...brief, angles: pickAngles() });
      fresh = out.captions.filter((c) => fits(c) && !repeats(c, past, openers));
      if (!fresh.length) fresh = out.captions.filter(fits).sort((a, b) => repeats(a, past, openers) - repeats(b, past, openers));
      if (!fresh.length) throw new Error('AI captions were all too long');
    }
    out.captions = fresh;
    photos.forEach((p, i) => { p.alt = out.alts[i] || p.alt || ''; });
    if (out.look) photos[0].look = out.look;
    const saved = await run(env, `UPDATE posts SET caption = ?, caption_options = ?, photos = ?, manual = 0, error = NULL, status = 'draft' WHERE id = ? AND status = 'writing'`,
      out.captions[0], JSON.stringify(out.captions), JSON.stringify(photos), row.id);
    if (saved.meta.changes) await respace(env, row.id);
  } catch (cause) {
    const message = String(cause.message || cause).slice(0, 300);
    // A refusal comes back as text with no captions. Anything else (timeout, server error) is retried later.
    if (!/no JSON|no captions/.test(message)) {
      await run(env, "UPDATE posts SET error = ? WHERE id = ? AND status = 'writing'", message, row.id);
      return;
    }
    // Declined: set the photo aside for a manual caption and give its day another photo.
    const scheduled = row.kind !== 'custom' && row.kind !== 'held';
    const held = await run(env, `UPDATE posts SET kind = ?, caption = '', caption_options = '[]', manual = 1, error = ?, status = 'draft' WHERE id = ? AND status = 'writing'`,
      scheduled ? 'held' : row.kind, message, row.id);
    if (scheduled && held.meta.changes) await fillDays(env, row.slot_day, photos.map((p) => p.key));
  }
}

// Gives every open day from today through `until` a photo from the stash, marked for a caption to be written.
async function fillDays(env, until, avoid = []) {
  const { day: today, time: nowTime } = localParts(new Date());
  const taken = new Set((await all(env, "SELECT slot_day FROM posts WHERE kind NOT IN ('custom', 'held') AND slot_day >= ?", today)).map((r) => r.slot_day));
  const days = [];
  for (let d = today; d <= until; d = addDays(d, 1)) if (!taken.has(d)) days.push(d);
  const kinds = planKinds(days);
  let filled = 0;
  for (const [i, day] of days.entries()) {
    const time = slotTime(day);
    if (day === today && time <= nowTime) continue; // today's slot already passed
    const photo = await choosePhoto(env, day, avoid);
    if (!photo) break; // stash is empty
    // Captions come later, one AI call per request (a whole week in one request is too slow for a phone to wait on).
    // One transaction: the post is only made if the photo is still in the stash and the day is still free
    // (the timer and the app can fill at the same moment), and the photo only leaves the stash if its post was made.
    const [made] = await env.DB.batch([
      env.DB.prepare(`INSERT OR IGNORE INTO posts (slot_day, slot_time, kind, photos, status, created_at)
        SELECT ?, ?, ?, ?, 'writing', ? WHERE EXISTS (SELECT 1 FROM photos WHERE id = ?)`)
        .bind(day, time, kinds[i], JSON.stringify([{ key: photo.key, type: photo.type, width: photo.width, height: photo.height, alt: '', sig: parse(photo.sig, null), hash: photo.hash }]), stamp(), photo.id),
      env.DB.prepare("DELETE FROM photos WHERE id = ? AND EXISTS (SELECT 1 FROM posts WHERE slot_day = ? AND photos LIKE ?)")
        .bind(photo.id, day, `%"key":"${photo.key}"%`),
    ]);
    if (made.meta.changes) filled++;
  }
  return filled;
}

// Keeps look-alike photos (same shoot, subject or setting) off neighbouring days.
async function choosePhoto(env, day, avoid = []) {
  const next = await first(env, 'SELECT * FROM photos WHERE priority > 0 ORDER BY priority DESC, id LIMIT 1');
  if (next && !avoid.includes(next.key)) return next; // selected with "Post next"
  const candidates = (await all(env, 'SELECT * FROM photos ORDER BY id')).filter((c) => !avoid.includes(c.key));
  if (!candidates.length) return null;
  const around = await all(env, "SELECT photos FROM posts WHERE kind NOT IN ('custom', 'held') AND slot_day BETWEEN ? AND ? AND slot_day != ?", addDays(day, -3), addDays(day, 3), day);
  const neighbours = around.flatMap((r) => parse(r.photos, []).map((p) => p.sig).filter(Boolean));
  return pickPhoto(candidates.map((c) => ({ ...c, sig: parse(c.sig, null) })), neighbours);
}

const lookOf = (row) => parse(row?.photos, [])[0]?.look || '';

// Re-checks every unapproved post in date order (no AI calls), so look-alikes already on the schedule get spread out.
async function respaceAll(env) {
  const today = localParts(new Date()).day;
  for (const r of await all(env, "SELECT id FROM posts WHERE status = 'draft' AND kind NOT IN ('custom', 'held') AND slot_day >= ? ORDER BY slot_day", today)) {
    await respace(env, r.id);
  }
}

// If a post's subject | setting | lighting clashes with anything within 3 days, move it: trade days with a later
// unapproved post, or failing that swap in a different stash photo. Approved posts never move.
async function respace(env, id) {
  const row = await first(env, 'SELECT * FROM posts WHERE id = ?', id);
  if (!row || row.status !== 'draft' || row.kind === 'custom' || !lookOf(row)) return;
  const around = (day, exceptId) => all(env, "SELECT * FROM posts WHERE kind NOT IN ('custom', 'held') AND status != 'posted' AND slot_day BETWEEN ? AND ? AND slot_day != ? AND id != ?",
    addDays(day, -3), addDays(day, 3), day, exceptId);
  const clashes = (look, posts) => posts.some((n) => looksClash(look, lookOf(n)));
  const rowNeighbours = await around(row.slot_day, row.id);
  if (!clashes(lookOf(row), rowNeighbours)) return;

  // 1) Trade places with a later unapproved post that fits here and lets this one fit there.
  //    Same post type: captions travel with the photos. Different type: both get fresh captions for their new day.
  const later = await all(env, "SELECT * FROM posts WHERE status = 'draft' AND kind NOT IN ('custom', 'held') AND slot_day > ? ORDER BY kind != ?, slot_day", addDays(row.slot_day, 3), row.kind);
  for (const c of later) {
    if (!lookOf(c)) continue;
    const cNeighbours = (await around(c.slot_day, c.id)).filter((n) => n.id !== row.id);
    if (clashes(lookOf(row), cNeighbours) || clashes(lookOf(c), rowNeighbours.filter((n) => n.id !== c.id))) continue;
    const sameKind = c.kind === row.kind;
    const cols = sameKind ? ['photos', 'caption', 'caption_options', 'manual', 'error'] : ['photos'];
    const set = `UPDATE posts SET ${cols.map((col) => `${col} = ?`).join(', ')}${sameKind ? '' : ", status = 'writing'"} WHERE id = ?`;
    await env.DB.batch([
      env.DB.prepare(set).bind(...cols.map((col) => c[col]), row.id),
      env.DB.prepare(set).bind(...cols.map((col) => row[col]), c.id),
    ]);
    return;
  }

  // 2) Nothing to trade with: this photo goes back to the stash and the day gets a different one.
  await returnToStash(env, row);
  await run(env, 'DELETE FROM posts WHERE id = ?', row.id);
  await fillDays(env, row.slot_day, parse(row.photos, []).map((p) => p.key));
}

// Takes a post off the schedule and puts its photos back in the stash, in one transaction.
// Only a post that hasn't posted (or started posting) can be taken off; returns whether it was.
async function returnToStash(env, row) {
  const photos = parse(row.photos, []);
  const [taken] = await env.DB.batch([
    env.DB.prepare("UPDATE posts SET status = 'stashing' WHERE id = ? AND status NOT IN ('posting', 'posted')").bind(row.id),
    ...photos.map((p) => env.DB.prepare(`INSERT INTO photos (key, type, width, height, sig, hash, priority, created_at)
      SELECT ?, ?, ?, ?, ?, ?, 0, ? WHERE EXISTS (SELECT 1 FROM posts WHERE id = ? AND status = 'stashing')`)
      .bind(p.key, p.type, p.width, p.height, p.sig ? JSON.stringify(p.sig) : null, p.hash || null, stamp(), row.id)),
    env.DB.prepare("DELETE FROM posts WHERE id = ? AND status = 'stashing'").bind(row.id),
  ]);
  return taken.meta.changes > 0;
}

// ---------- posting ----------

const MAX_TRIES = 3;
const STUCK_MINUTES = 10; // a 'posting' claim this old means that attempt died partway

// Claims the post first, so two runs (or the timer and "post now") can't both post it. A failed scheduled post
// goes back to approved and is retried on the next run, up to MAX_TRIES; after that it shows as "didn't post".
async function publish(env, row) {
  const photos = parse(row.photos, []);
  const claimed = await run(env, "UPDATE posts SET status = 'posting', claimed_at = ?, tries = tries + 1 WHERE id = ? AND status = ? AND claimed_at IS ?",
    stamp(), row.id, row.status, row.claimed_at);
  if (!claimed.meta.changes) return { ok: false, error: 'It’s already being posted' };
  try {
    const url = await postToBluesky(env, { caption: row.caption }, await loadImages(env, photos), { retry: row.tries > 0 });
    await run(env, "UPDATE posts SET status = 'posted', posted_at = ?, url = ?, error = NULL WHERE id = ?", stamp(), url, row.id);
    await deleteImages(env, photos); // they live on Bluesky now
    return { ok: true, url };
  } catch (cause) {
    await run(env, 'UPDATE posts SET status = ?, error = ? WHERE id = ?', row.tries + 1 < MAX_TRIES ? 'approved' : 'failed', String(cause.message || cause).slice(0, 300), row.id);
    return { ok: false, error: cause.message };
  }
}

// The next day without an approved post, for a post that needs a day: that day's draft goes back to the stash.
// With every day approved, it's the day after the last one.
async function takeNextDay(env) {
  const today = localParts(new Date()).day;
  const target = await first(env, "SELECT * FROM posts WHERE kind NOT IN ('custom', 'held') AND status IN ('draft', 'writing') AND slot_day >= ? ORDER BY slot_day LIMIT 1", today);
  if (target) {
    await returnToStash(env, target);
    await run(env, 'DELETE FROM posts WHERE id = ?', target.id);
    return { day: target.slot_day, time: target.slot_time, kind: target.kind };
  }
  const last = (await first(env, "SELECT MAX(slot_day) AS d FROM posts WHERE kind NOT IN ('custom', 'held')")).d;
  const day = last && last >= today ? addDays(last, 1) : today;
  return { day, time: slotTime(day), kind: 'standard' };
}

// Approved posts whose day went by without posting (the timer missed it) move to the next open day instead of being lost.
async function moveMissed(env, today) {
  for (const row of await all(env, "SELECT id FROM posts WHERE status = 'approved' AND kind NOT IN ('custom', 'held') AND slot_day < ? ORDER BY slot_day, slot_time", today)) {
    const { day, time } = await takeNextDay(env);
    await run(env, 'UPDATE posts SET slot_day = ?, slot_time = ? WHERE id = ?', day, time, row.id);
  }
}

// Keeps the schedule filled for the next two weeks and spreads out look-alike photos.
async function tidySchedule(env) {
  const today = localParts(new Date()).day;
  await fillDays(env, addDays(today, DRAFT_AHEAD_DAYS - 1));
  await respaceAll(env);
  await qa(env);
}

// QA: reads the finished captions in date order (the last 2 weeks of posted ones included) and sends any
// unapproved one that repeats an earlier caption back for a rewrite.
async function qa(env) {
  const today = localParts(new Date()).day;
  const posts = await all(env, "SELECT id, slot_day AS day, caption, status, rewrites FROM posts WHERE kind != 'held' AND caption != '' AND slot_day >= ? ORDER BY slot_day, slot_time", addDays(today, -14));
  for (const id of qaFlags(posts)) {
    await run(env, "UPDATE posts SET status = 'writing', rewrites = rewrites + 1 WHERE id = ? AND status = 'draft' AND manual = 0", id);
  }
}

// Every 15 minutes: post today's approved posts once their time comes; tidy the schedule; write waiting captions.
export async function runSchedule(env, date = new Date()) {
  const { day, time } = localParts(date);
  // While paused nothing moves, so drafts aren't churned day after day; missed posts move once posting resumes.
  // A one-off assigned to a day that passed posts late rather than never.
  if ((await getSetting(env, 'paused')) !== '1') {
    await moveMissed(env, day);
    const stuck = new Date(date.getTime() - STUCK_MINUTES * 60000).toISOString();
    const due = await all(env, "SELECT * FROM posts WHERE (status = 'approved' AND (slot_day < ? OR (slot_day = ? AND slot_time <= ?))) OR (status = 'posting' AND claimed_at < ?)", day, day, time, stuck);
    for (const row of due) await publish(env, row);
  }
  await tidySchedule(env);
  // Captions not completed during the app request get written here, a few per run.
  for (const row of await all(env, "SELECT * FROM posts WHERE status = 'writing' ORDER BY slot_day LIMIT 12")) await writeCaption(env, row);
}

// ---------- routes ----------

async function stateBody(env) {
  const today = localParts(new Date()).day;
  const posts = await all(env, "SELECT * FROM posts WHERE status != 'posted' AND (slot_day >= ? OR status = 'failed') ORDER BY slot_day, slot_time, id", today);
  const stash = await first(env, 'SELECT COUNT(*) AS n FROM photos');
  const notes = await all(env, 'SELECT id, kind, text FROM notes ORDER BY id');
  return { today, posts: posts.map(apiPost), stash: stash.n, notes, paused: (await getSetting(env, 'paused')) === '1' };
}
const state = async (env, extra = {}) => json({ ...(await stateBody(env)), ...extra });

// Form: photo (one file, already shrunk on the phone), width, height.
async function addPhoto(request, env) {
  const form = await request.formData().catch(() => null);
  const file = form?.get('photo');
  if (!file || typeof file.arrayBuffer !== 'function') return error('No photo');
  if (!IMAGE_TYPES.includes(file.type)) return error('Use a JPEG, PNG or WebP photo');
  if (file.size > MAX_IMAGE_BYTES) return error('Photo must be under 2 MB');
  const width = Number(form.get('width')), height = Number(form.get('height'));
  if (!(width > 0 && height > 0)) return error('Missing photo size');
  // Same original photo uploaded again while it's still waiting (in the stash or on the schedule), e.g. retrying
  // after the client dropped the page: keep one copy. Once it is posted or removed it can be added again.
  const hash = /^[0-9a-f]{64}$/.test(form.get('hash')) ? form.get('hash') : null;
  if (hash && await first(env, "SELECT 1 FROM photos WHERE hash = ? UNION ALL SELECT 1 FROM posts WHERE status != 'posted' AND photos LIKE ?", hash, `%"hash":"${hash}"%`)) {
    return json({ ok: true, duplicate: true });
  }
  const key = crypto.randomUUID();
  await env.KV.put(`img:${key}`, await file.arrayBuffer(), { metadata: { type: file.type } });
  let sig = null;
  try {
    const s = JSON.parse(String(form.get('sig') || 'null'));
    if (/^[0-9a-f]{16}$/.test(s?.h) && Array.isArray(s.c) && s.c.length === 48) sig = JSON.stringify({ h: s.h, c: s.c.map((n) => Math.round(Number(n)) || 0) });
  } catch { /* no fingerprint: the photo still works, it just can't be spaced out */ }
  await run(env, 'INSERT INTO photos (key, type, width, height, sig, hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', key, file.type, width, height, sig, hash, stamp());
  return json({ ok: true }, 201);
}

async function listPhotos(env) {
  return json({ photos: await all(env, 'SELECT id, key, width, height FROM photos ORDER BY priority DESC, id') });
}

async function photoAction(request, env, action) {
  const { ids } = await readJson(request);
  if (!Array.isArray(ids) || !ids.every(Number.isInteger)) return error('ids must be a list');
  const rows = [];
  for (const id of ids) { const r = await first(env, 'SELECT * FROM photos WHERE id = ?', id); if (r) rows.push(r); }
  if (action === 'remove') {
    for (const r of rows) await run(env, 'DELETE FROM photos WHERE id = ?', r.id);
    await deleteImages(env, rows);
  } else {
    // "Post next": these go first; the earliest unapproved drafts give up their days to them.
    const top = (await first(env, 'SELECT MAX(priority) AS p FROM photos')).p || 0;
    for (const [i, r] of rows.entries()) await run(env, 'UPDATE photos SET priority = ? WHERE id = ?', top + rows.length - i, r.id);
    const today = localParts(new Date()).day;
    const bumped = await all(env, "SELECT * FROM posts WHERE status = 'draft' AND kind NOT IN ('custom', 'held') AND slot_day >= ? ORDER BY slot_day LIMIT ?", today, rows.length);
    for (const b of bumped) { await returnToStash(env, b); await run(env, 'DELETE FROM posts WHERE id = ?', b.id); }
    if (bumped.length) await fillDays(env, bumped[bumped.length - 1].slot_day);
  }
  return state(env);
}

async function writeMore(env) {
  const last = (await first(env, "SELECT MAX(slot_day) AS d FROM posts WHERE kind NOT IN ('custom', 'held')")).d;
  const today = localParts(new Date()).day;
  const start = last && last >= today ? addDays(last, 1) : today;
  if (!(await first(env, 'SELECT 1 FROM photos LIMIT 1'))) return error('The photo stash is empty. Add photos first.', 409);
  await fillDays(env, addDays(start, 6));
  return state(env);
}

async function approveAll(env) {
  await run(env, "UPDATE posts SET status = 'approved' WHERE status = 'draft' AND caption != ''");
  return state(env);
}

// Each action applies to one post; posted posts can't change.
async function postAction(request, env, id, action) {
  const row = await first(env, 'SELECT * FROM posts WHERE id = ?', id);
  if (!row) return error('Post not found', 404);
  if (row.status === 'posted') return error('That post already went out', 409);
  const body = await readJson(request);
  const caption = typeof body.caption === 'string' ? body.caption.trim() : null;
  if (caption !== null && graphemes(caption) > LIMIT) return error(`Caption is over ${LIMIT} characters`);

  if (action === 'caption') {
    await run(env, "UPDATE posts SET caption = ?, manual = 1, status = 'draft' WHERE id = ?", caption ?? '', id); // Manual copy is not replaced by QA or new notes.
  } else if (action === 'approve') {
    const text = caption ?? row.caption;
    if (!text) return error('Write a caption first');
    if (row.kind === 'held') {
      // A manual caption for a held photo takes the next day that is not approved yet.
      const { day, time, kind } = await takeNextDay(env);
      await run(env, "UPDATE posts SET caption = ?, kind = ?, slot_day = ?, slot_time = ?, status = 'approved', error = NULL WHERE id = ?", text, kind, day, time, id);
    } else {
      await run(env, "UPDATE posts SET caption = ?, status = 'approved', error = NULL WHERE id = ?", text, id);
    }
  } else if (action === 'delete') {
    // The photo is gone for good; that day gets another photo from the stash.
    await run(env, 'DELETE FROM posts WHERE id = ?', id);
    await deleteImages(env, parse(row.photos, []));
    if (row.kind !== 'custom' && row.kind !== 'held') await fillDays(env, row.slot_day);
  } else if (action === 'notnow') {
    // The photo goes back in the stash for later; that day gets a different photo.
    if (row.kind === 'custom' || row.kind === 'held') return error('This one isn’t on a day yet');
    await returnToStash(env, row);
    await run(env, 'DELETE FROM posts WHERE id = ?', id);
    await fillDays(env, row.slot_day, parse(row.photos, []).map((p) => p.key));
  } else if (action === 'redraft') {
    await run(env, "UPDATE posts SET status = 'writing' WHERE id = ?", id); // captions only land on a post waiting for them
    await writeCaption(env, row);
  } else if (action === 'now') {
    const text = caption ?? row.caption;
    if (!text) return error('Write a caption first');
    const result = await publish(env, { ...row, caption: text });
    if (!result.ok) {
      // Keep it on its day: a failed early post shouldn't give that day away.
      if (row.status !== 'failed') await run(env, 'UPDATE posts SET status = ?, error = NULL WHERE id = ?', row.status, id);
      return error(`Couldn't post: ${result.error}`, 502);
    }
    // Posting early frees this post's day, which gets refilled from the stash.
    const { day, time } = localParts(new Date());
    await run(env, "UPDATE posts SET caption = ?, kind = 'custom', slot_day = ?, slot_time = ? WHERE id = ?", text, day, time, id);
    if (row.kind !== 'custom' && row.kind !== 'held') await fillDays(env, row.slot_day);
  } else {
    return error('Unknown action', 404);
  }
  return state(env);
}

// One-off post. Form: photo (1-4), width<i>, height<i>, caption, day ('' = post now).
async function customPost(request, env) {
  const form = await request.formData().catch(() => null);
  if (!form) return error('Expected a form');
  const files = form.getAll('photo').filter((f) => typeof f?.arrayBuffer === 'function');
  if (!files.length || files.length > MAX_IMAGES) return error(`Pick 1 to ${MAX_IMAGES} photos`);
  for (const f of files) {
    if (!IMAGE_TYPES.includes(f.type)) return error('Use JPEG, PNG or WebP photos');
    if (f.size > MAX_IMAGE_BYTES) return error('Each photo must be under 2 MB');
  }
  const caption = String(form.get('caption') || '').trim();
  if (!caption) return error('Write a caption');
  if (graphemes(caption) > LIMIT) return error(`Caption is over ${LIMIT} characters`);
  const day = String(form.get('day') || '');
  if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) return error('Pick a valid day');

  const photos = [];
  for (const [i, f] of files.entries()) {
    const key = crypto.randomUUID();
    await env.KV.put(`img:${key}`, await f.arrayBuffer(), { metadata: { type: f.type } });
    photos.push({ key, type: f.type, width: Number(form.get(`width${i}`)) || null, height: Number(form.get(`height${i}`)) || null, alt: '' });
  }
  const now = localParts(new Date());
  const { meta } = await run(env, "INSERT INTO posts (slot_day, slot_time, kind, photos, status, caption, created_at) VALUES (?, ?, 'custom', ?, 'approved', ?, ?)",
    day || now.day, day ? slotTime(day) : now.time, JSON.stringify(photos), caption, stamp());
  if (!day) {
    const result = await publish(env, await first(env, 'SELECT * FROM posts WHERE id = ?', meta.last_row_id));
    if (!result.ok) return error(`Couldn't post: ${result.error}`, 502);
  }
  return state(env);
}

// Caption writer instructions are either link rules or general voice guidance.
export function noteKind(text) {
  if (/\b[a-z0-9-]+\.(com|net|org|co|me|io|xyz|link|bio)\b/i.test(text)) return 'link';
  return 'voice';
}

async function addNote(request, env) {
  const text = String((await readJson(request)).text || '').trim().slice(0, 300);
  if (!text) return error('Say something first');
  const kind = noteKind(text);
  await run(env, 'INSERT INTO notes (kind, text, created_at) VALUES (?, ?, ?)', kind, text, stamp());
  return state(env);
}

async function rewrite(request, env) {
  const { ids } = await readJson(request);
  if (!Array.isArray(ids)) return error('ids must be a list');
  for (const id of ids) {
    await run(env, "UPDATE posts SET status = 'writing' WHERE id = ? AND status = 'approved'", id);
  }
  return state(env);
}

async function serveImage(env, key) {
  const { value, metadata } = await env.KV.getWithMetadata(`img:${key}`, 'arrayBuffer');
  if (!value) return error('Photo not found', 404);
  return new Response(value, { headers: { 'content-type': metadata?.type || 'image/jpeg', 'cache-control': 'private, max-age=86400' } });
}

async function api(request, env, url) {
  const { pathname: p } = url;
  const m = request.method;
  if (m === 'GET' && p === '/api/setup-status') {
    const configured = {
      database: Boolean(env.DB),
      storage: Boolean(env.KV),
      pin: Boolean(env.POSTER_PIN),
      blueskyHandle: Boolean(env.BLUESKY_HANDLE),
      blueskyPassword: Boolean(env.BLUESKY_APP_PASSWORD),
      aiKey: Boolean(env.AI_API_KEY),
    };
    return json({ ready: Object.values(configured).every(Boolean), configured });
  }
  if (m === 'POST' && p === '/api/unlock') return unlock(request, env);
  if (!(await isAuthorized(request, env))) return error('Locked', 401);

  if (m === 'GET' && p === '/api/state') return state(env);
  if (m === 'GET' && p === '/api/photos') return listPhotos(env);
  if (m === 'POST' && p === '/api/photos') return addPhoto(request, env);
  if (m === 'POST' && p === '/api/photos/remove') return photoAction(request, env, 'remove');
  if (m === 'POST' && p === '/api/photos/next') return photoAction(request, env, 'next');
  if (m === 'POST' && p === '/api/write-more') return writeMore(env);
  if (m === 'POST' && p === '/api/fill') { await tidySchedule(env); return state(env); }
  if (m === 'POST' && p === '/api/approve-all') return approveAll(env);
  if (m === 'POST' && p === '/api/custom') return customPost(request, env);
  if (m === 'POST' && p === '/api/notes') return addNote(request, env);
  if (m === 'POST' && p === '/api/rewrite') return rewrite(request, env);
  if (m === 'POST' && p === '/api/settings') {
    const { paused } = await readJson(request);
    if (typeof paused !== 'boolean') return error('paused must be true or false');
    await setSetting(env, 'paused', paused ? '1' : '0');
    return state(env);
  }
  let r = p.match(/^\/api\/notes\/(\d+)\/delete$/);
  if (m === 'POST' && r) { await run(env, 'DELETE FROM notes WHERE id = ?', Number(r[1])); return state(env); }
  r = p.match(/^\/api\/images\/([0-9a-f-]{36})$/);
  if (m === 'GET' && r) return serveImage(env, r[1]);
  r = p.match(/^\/api\/posts\/(\d+)\/(caption|approve|delete|notnow|redraft|now)$/);
  if (m === 'POST' && r) return postAction(request, env, Number(r[1]), r[2]);
  return error('Not found', 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      const res = url.pathname.startsWith('/api/') ? await api(request, env, url) : await env.ASSETS.fetch(request);
      const out = new Response(res.body, res);
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
      if (!url.pathname.startsWith('/api/')) out.headers.set('cache-control', 'no-cache');
      if (env.CF_VERSION_METADATA?.id) out.headers.set('x-app-version', env.CF_VERSION_METADATA.id);
      return out;
    } catch (cause) {
      console.error('Unhandled request error', cause);
      return error('Something went wrong', 500);
    }
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runSchedule(env));
  },
};
