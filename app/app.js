// crierbaby app: one page, state comes from /api/state and every action returns the new state.

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const LIMIT = 300;
const graphemes = (s) => [...new Intl.Segmenter().segment(s)].length;
const DEMO = new URLSearchParams(location.search).get('demo') === '1';

let S = { posts: [], notes: [], stash: 0, paused: true, today: '' };
let filter = 'all', sheetFor = null, wasCrying = null, stale = [];
let stashPhotos = [], picked = new Set(), staged = [], postFiles = [], when = 'now';

// ---------- server ----------

async function api(path, { body, form, method } = {}) {
  if (DEMO) throw new Error('This is a read-only portfolio demo. Deploy your own copy to use actions.');
  // Give up after 90 s: a phone that locks or switches apps can leave a request hanging forever.
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), 90_000);
  let res;
  try {
    res = await fetch(`/api/${path}`, {
      method: method || (body || form ? 'POST' : 'GET'),
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: form || (body ? JSON.stringify(body) : undefined),
      signal: stop.signal,
    });
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'Took too long. Try again.' : 'No connection. Try again.');
  } finally {
    clearTimeout(timer);
  }
  // A new deploy while the app was open: reload to avoid running old code against the new server.
  const version = res.headers.get('x-app-version');
  if (version) {
    if (api.version && version !== api.version) { location.reload(); throw new Error('Updating'); }
    api.version = version;
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== 'unlock') { lock(); throw new Error('Locked'); }
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}

// Runs an action, shows the crying baby while slow AI work happens, then redraws with the returned state.
// Every action changes something, so it's always a POST, even when there's nothing to send.
async function act(path, opts = {}, busyText = '') {
  if (busyText) { $('#busy-text').textContent = busyText; $('#busy').hidden = false; }
  try {
    const data = await api(path, { ...opts, method: 'POST' });
    if (data.posts) setState(data);
    return data;
  } catch (e) {
    if (e.message !== 'Locked' && e.message !== 'Updating') toast(/^Couldn't post/.test(e.message) ? plainError(e.message) : e.message);
    return null;
  } finally {
    $('#busy').hidden = true;
  }
}

function setState(data) {
  S = data;
  if (data.stale?.length) stale = data.stale;
  render();
  writeCaptions();
}

// Captions are written one post at a time while the app is open, so no single request runs long enough
// for the client to give up. Anything left when the app closes gets written by the server's timer.
let writingNow = false;
async function writeCaptions() {
  if (writingNow) return;
  writingNow = true;
  const tries = new Map();
  try {
    for (let next; (next = S.posts.find((p) => p.status === 'writing' && (tries.get(p.id) || 0) < 3));) {
      const left = S.posts.filter((p) => p.status === 'writing').length;
      $('#writing-text').textContent = `Writing captions · ${left} left`;
      $('#writing').hidden = false;
      tries.set(next.id, (tries.get(next.id) || 0) + 1);
      const data = await api(`posts/${next.id}/redraft`, { body: {} }).catch(() => null);
      if (data) { S = data; if (data.stale?.length) stale = data.stale; render(); continue; }
      // Failed or timed out: refresh (the post may have moved) and try again shortly.
      await new Promise((r) => setTimeout(r, 3000));
      const fresh = await api('state').catch(() => null);
      if (fresh) { S = fresh; render(); }
    }
  } finally {
    writingNow = false;
    $('#writing').hidden = true;
  }
}

// ---------- formatting ----------

function dayLabel(day) {
  if (day === S.today) return 'Today';
  const d = new Date(`${day}T12:00:00Z`);
  const t = new Date(`${S.today}T12:00:00Z`);
  if (d - t === 864e5) return 'Tomorrow';
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}
function timeLabel(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`; // nbsp keeps "5:07 pm" together
}
const when_ = (p) => (isHeld(p) ? 'No day yet' : `${dayLabel(p.day)} · ${timeLabel(p.time)}`);
const img = (ph, cls = '') => `<img class="${cls}" src="${ph.src ? esc(ph.src) : `/api/images/${esc(ph.key)}`}" alt="${esc(ph.alt)}" loading="lazy">`;
const needsYou = (p) => p.status === 'draft' || p.status === 'failed';
// Photos the AI declined wait here (no day yet) for a manual caption and approval.
const isHeld = (p) => p.kind === 'held';
const needsCaption = (p) => isHeld(p) || (p.status === 'draft' && !p.caption);
function tag(p) {
  if (p.status === 'writing') return '<span class="tag">Writing caption…</span>';
  if (p.status === 'failed') return '<span class="tag need">Didn’t post</span>';
  if (needsCaption(p)) return '<span class="tag need">Needs your caption</span>';
  return p.status === 'draft' ? '<span class="tag need">Needs approval</span>' : '';
}
// Show a plain sentence when a post fails, not the raw server message.
function plainError(err = '') {
  if (/login failed|password|BLUESKY_/i.test(err)) return 'Couldn’t sign in to Bluesky. Check the configured handle and app password.';
  if (/missing/i.test(err)) return 'A photo for this post went missing. Delete it and use another.';
  return 'Bluesky didn’t take this post. Try again in a bit.';
}
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.remove('show'), 3000);
}

// Consecutive approved days from the next scheduled post on.
function runway() {
  let n = 0, lastDay = null;
  for (const p of S.posts.filter((x) => x.kind !== 'custom' && !isHeld(x) && x.status !== 'failed')) {
    if (p.status !== 'approved') break;
    n++; lastDay = p.day;
  }
  return { n, lastDay };
}

// ---------- render ----------

function render() {
  const need = S.posts.filter(needsYou);
  const manual = S.posts.filter(needsCaption);
  const toApprove = need.length - manual.length;

  $('#badge').textContent = need.length; $('#badge').hidden = !need.length;
  $('#seg-n').textContent = need.length; $('#seg-n').hidden = !need.length;

  // The baby cries while anything needs attention and is happy when everything is queued.
  const baby = $('#baby'), happy = !need.length;
  baby.className = `baby ${happy ? 'happy' : 'cry'}`;
  if (happy && wasCrying) { void baby.offsetWidth; baby.classList.add('play'); }
  wasCrying = !happy;
  baby.setAttribute('aria-label', happy ? 'Everything is queued' : `${need.length} need you`);

  // Home: next up
  const upcoming = S.posts.filter((p) => p.status !== 'failed' && !isHeld(p));
  $('#carousel').innerHTML = upcoming.length ? upcoming.map((p) => `
    <button class="slide ${needsYou(p) ? 'need' : ''}" data-open="${p.id}">
      <div class="frame">${img(p.photos[0])}</div>
      <div class="info"><div class="when">${when_(p)}</div>${tag(p)}
        <p>${p.caption ? esc(p.caption) : `<span class="muted">${p.status === 'writing' ? 'Writing caption…' : 'No caption yet'}</span>`}</p></div>
    </button>`).join('') : '<div class="empty">Nothing scheduled</div>';

  // One row: what needs attention, or a way to queue more when everything is reviewed.
  const banner = $('#banner');
  const needParts = [toApprove && `${toApprove} to approve`, manual.length && `${manual.length} need${manual.length === 1 ? 's' : ''} your caption`].filter(Boolean);
  banner.className = needParts.length ? 'banner need' : 'banner';
  banner.innerHTML = needParts.length ? `<b>${needParts.join(' · ')}</b><span>›</span>` : '<b>Add more to approval queue</b><span>＋</span>';
  banner.dataset.go = needParts.length ? 'queue' : '';
  banner.dataset.filter = needParts.length ? 'need' : '';
  banner.dataset.more = needParts.length ? '' : '1';

  // Photo stash, out of 100 = full
  const parts = [
    ['k-ap', 'Approved', S.posts.filter((p) => p.status === 'approved').length],
    ['k-wr', 'To approve', toApprove + S.posts.filter((p) => p.status === 'writing').length],
    ['k-mn', 'Your caption', manual.length],
    ['k-ph', 'Not used yet', S.stash],
  ];
  const total = parts.reduce((n, x) => n + x[2], 0);
  $('#stock-count').textContent = `${total} / 100`;
  $('#pipe').innerHTML = parts.filter((x) => x[2]).map(([k, , n]) => `<i class="${k}" style="width:${Math.min(n, 100)}%"></i>`).join('');
  $('#pipe').setAttribute('aria-label', parts.map(([, l, n]) => `${l} ${n}`).join(', ') + `, ${total} of 100`);
  $('#legend').innerHTML = parts.map(([k, l, n]) => `<span><i class="${k}"></i>${l} <b>${n}</b></span>`).join('');
  $('#stock').classList.toggle('low', S.stash < 3);

  // Queue
  const shown = S.posts.filter((p) => filter === 'all' || (filter === 'need' ? needsYou(p) : p.status === 'approved'));
  $('#rows').innerHTML = shown.map((p) => `
    <div class="qrow ${needsYou(p) ? 'need' : ''}" data-open="${p.id}">
      <div class="thumb frame">${img(p.photos[0])}</div>
      <div>
        <div class="top">${when_(p)}</div>${tag(p)}
        ${needsCaption(p) && !p.caption ? '<div class="flag">The AI refused this one</div>' : `<div class="cap">${esc(p.caption)}</div>`}
        ${p.status === 'failed' ? `<div class="error-note">${esc(plainError(p.error))}</div>` : ''}
        <div class="qactions ${p.status === 'approved' || p.status === 'failed' ? '' : 'three'}">
          ${p.status === 'approved' ? '<span class="okline">✓ Approved</span>'
            : p.status === 'failed' ? `<button class="btn small" data-act="now" data-id="${p.id}">Try again</button>`
            : `<button class="btn small" data-act="approve" data-id="${p.id}" ${p.caption ? '' : 'disabled'}>Approve</button>
               <button class="btn plain small" data-act="delete" data-id="${p.id}">Delete</button>
               <button class="btn plain small" data-act="redraft" data-id="${p.id}">Reroll</button>`}
        </div>
      </div>
    </div>`).join('') || '<p class="muted" style="padding:12px 0">Nothing here</p>';
  const ready = S.posts.filter((p) => p.status === 'draft' && p.caption).length;
  $('#approve-all').textContent = `Approve all ready (${ready})`;
  $('#approve-all').hidden = !ready || filter === 'ok';

  // Caption writer
  $('#notes').innerHTML = S.notes.map((n) => `<div class="note"><span class="kind">${esc(n.kind)}</span><div>${esc(n.text)}</div><button class="x" data-note="${n.id}" aria-label="Remove">×</button></div>`).join('')
    || '<p class="muted" style="margin:0">Nothing yet</p>';
  $('#stale').hidden = !stale.length;
  $('#stale-text').textContent = `${stale.length} approved post${stale.length === 1 ? ' was' : 's were'} written before this. Rewrite ${stale.length === 1 ? 'it' : 'them'} to include it? ${stale.length === 1 ? 'It goes' : 'They go'} back to Needs you.`;

  $('#auto').setAttribute('aria-checked', String(!S.paused));
  if (sheetFor !== null) renderSheet();
}

// ---------- edit card ----------

function renderSheet() {
  const p = S.posts.find((x) => x.id === sheetFor);
  if (!p) { closeSheet(); return; }
  const others = p.captionOptions.filter((o) => o !== p.caption);
  $('#sheet').innerHTML = `
    <div class="sheet-top"><span class="grab" aria-hidden="true"></span><button class="btn" data-close="1">Done</button></div>
    <div class="frame">${img(p.photos[0])}</div>
    ${p.photos.length > 1 ? `<p class="muted" style="margin:6px 0 0">+ ${p.photos.length - 1} more photo${p.photos.length > 2 ? 's' : ''}</p>` : ''}
    <div class="sheet-head"><span style="white-space:nowrap">${when_(p)}</span>${tag(p)}</div>
    ${isHeld(p) ? '<div class="flag" style="margin-bottom:8px">The AI refused this one. Write a caption and approve it, and it takes the next open day.</div>' : ''}
    <textarea id="sheet-cap" aria-label="Caption" placeholder="Your caption">${esc(p.caption)}</textarea>
    <div class="count" id="sheet-count">${graphemes(p.caption)} / ${LIMIT}</div>
    ${others.length ? `<div class="alts">${others.map((o) => `<button data-pick="${esc(o)}">${esc(o)}</button>`).join('')}</div>` : ''}
    ${p.status === 'draft' || p.status === 'writing' ? `<div class="row-btns"><button class="btn" data-act="approve" data-id="${p.id}" ${p.caption ? '' : 'disabled'}>Approve</button><button class="btn plain" data-act="delete" data-id="${p.id}">Delete</button></div>` : ''}
    <div class="row-btns">
      <button class="btn plain small${p.kind === 'custom' || isHeld(p) ? ' span2' : ''}" data-act="redraft" data-id="${p.id}">Reroll captions</button>
      ${p.kind === 'custom' || isHeld(p) ? '' : `<button class="btn plain small" data-act="notnow" data-id="${p.id}">Not now</button>`}
    </div>
    <div class="row-btns"><button class="btn plain small span2" data-act="now" data-id="${p.id}">Post now</button></div>`;
}
function openSheet(id) { sheetFor = id; $('#sheet').hidden = false; $('#scrim').hidden = false; renderSheet(); }
function closeSheet() { sheetFor = null; $('#sheet').hidden = true; $('#sheet').style.transform = ''; $('#scrim').hidden = true; }
// Swipe the edit card down to close it (from the top of the card, not while scrolling or typing).
{
  const sheet = $('#sheet');
  let startY = null;
  sheet.addEventListener('touchstart', (e) => {
    startY = sheet.scrollTop <= 0 && e.target.tagName !== 'TEXTAREA' ? e.touches[0].clientY : null;
  }, { passive: true });
  sheet.addEventListener('touchmove', (e) => {
    if (startY === null) return;
    const dy = e.touches[0].clientY - startY;
    sheet.style.transition = 'none';
    sheet.style.transform = dy > 0 ? `translateY(${dy}px)` : '';
  }, { passive: true });
  sheet.addEventListener('touchend', async (e) => {
    if (startY === null) return;
    const dy = e.changedTouches[0].clientY - startY;
    startY = null;
    sheet.style.transition = '';
    if (dy > 90) { await saveSheetCaption(); closeSheet(); } else sheet.style.transform = '';
  });
}

// Saves an edited caption when the card closes, so nothing typed is lost.
async function saveSheetCaption() {
  const p = S.posts.find((x) => x.id === sheetFor);
  const box = $('#sheet-cap');
  if (p && box && box.value.trim() !== p.caption) await act(`posts/${p.id}/caption`, { body: { caption: box.value } });
}

// ---------- navigation ----------

function go(tab) {
  document.querySelectorAll('main section').forEach((s) => { s.hidden = s.id !== tab; });
  const navTab = tab === 'photos' ? 'home' : tab;
  document.querySelectorAll('nav button').forEach((x) => (x.dataset.go === navTab ? x.setAttribute('aria-current', 'page') : x.removeAttribute('aria-current')));
  if (tab === 'photos') loadStash();
  scrollTo(0, 0);
}
function setFilter(f) {
  filter = f;
  document.querySelectorAll('#queue .seg button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.filter === f)));
  render();
}

// ---------- photo stash ----------

async function loadStash() {
  const data = await api('photos').catch(() => null);
  if (!data) return;
  stashPhotos = data.photos; picked.clear(); renderStash();
}
function renderStash() {
  $('#photos-sub').textContent = `${stashPhotos.length} not used yet`;
  $('#pgrid').innerHTML = stashPhotos.map((ph) => `<button class="${picked.has(ph.id) ? 'on' : ''}" data-ppick="${ph.id}" aria-pressed="${picked.has(ph.id)}" aria-label="Photo">${img(ph)}</button>`).join('');
  $('#pbar').hidden = !picked.size;
  $('#psel').textContent = `${picked.size} selected`;
}

// ---------- adding photos ----------

// Shrinks to max 2000px JPEG under ~1.9 MB (Bluesky's image limit is 2 MB).
async function prepare(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
  const sig = fingerprint(bmp);
  bmp.close();
  let blob;
  for (let q = 0.9; q >= 0.5; q -= 0.08) {
    blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', q));
    if (blob.size <= 1_900_000) break;
  }
  canvas.width = canvas.height = 0; // release the canvas memory right away
  return { blob, width: w, height: h, sig };
}

// Tiny visual signature (see photoDistance in worker/text.js): 9x8 grey difference hash + 4x4 average colors.
function fingerprint(bmp) {
  const c = document.createElement('canvas');
  c.width = 9; c.height = 8;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(bmp, 0, 0, 9, 8);
  const g = x.getImageData(0, 0, 9, 8).data;
  const grey = (i) => g[i * 4] * 0.299 + g[i * 4 + 1] * 0.587 + g[i * 4 + 2] * 0.114;
  let bits = '';
  for (let r = 0; r < 8; r++) for (let col = 0; col < 8; col++) bits += grey(r * 9 + col) > grey(r * 9 + col + 1) ? '1' : '0';
  const h = bits.match(/.{4}/g).map((b) => parseInt(b, 2).toString(16)).join('');
  c.width = 4; c.height = 4;
  x.drawImage(bmp, 0, 0, 4, 4);
  const colors = [...x.getImageData(0, 0, 4, 4).data].filter((_, i) => i % 4 !== 3);
  c.width = c.height = 0;
  return { h, c: colors };
}
// Only a handful of previews: decoding 85 full-size phone photos at once crashes the page on iOS.
const PREVIEWS = 9;
const thumbs = (files, attr) => files.slice(0, PREVIEWS).map((f, i) => `<div><img src="${f.url}" alt=""><button data-${attr}="${i}" aria-label="Remove">×</button></div>`).join('')
  + (files.length > PREVIEWS ? `<div class="more">+${files.length - PREVIEWS}</div>` : '');
function renderStaged() {
  $('#staged').innerHTML = thumbs(staged, 'unstage');
  $('#upload').hidden = !staged.length;
  $('#upload').textContent = `Add ${staged.length} to stash`;
  $('#post-photos').innerHTML = thumbs(postFiles, 'unpost');
}
const withUrls = (files) => [...files].filter((f) => f.type.startsWith('image/')).map((f) => ({ file: f, url: URL.createObjectURL(f) }));
const sha256 = async (buf) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map((b) => b.toString(16).padStart(2, '0')).join('');

// One at a time, so a big batch never times out and each photo gets its own progress step.
async function uploadStaged() {
  const files = staged; staged = []; renderStaged();
  $('#up-status').hidden = false;
  const awake = await navigator.wakeLock?.request('screen').catch(() => null); // a sleeping phone stops the upload
  let failed = 0, repeats = 0;
  for (const [i, s] of files.entries()) {
    $('#up-text').textContent = `Uploading ${i + 1} of ${files.length}…`;
    $('#bar').style.width = `${((i + 1) / files.length) * 100}%`;
    try {
      // The fingerprint of the original file lets a retry after a crash skip photos that already made it.
      const hash = await sha256(await s.file.arrayBuffer());
      const { blob, width, height, sig } = await prepare(s.file);
      const form = new FormData();
      form.set('photo', blob, 'photo.jpg'); form.set('width', width); form.set('height', height); form.set('hash', hash); form.set('sig', JSON.stringify(sig));
      if ((await api('photos', { form })).duplicate) repeats++;
    } catch { failed++; }
    URL.revokeObjectURL(s.url);
  }
  awake?.release();
  const added = files.length - failed - repeats;
  $('#up-text').textContent = [`Added ${added}`, repeats && `${repeats} already in the stash`, failed && `${failed} didn’t upload`].filter(Boolean).join(' · ');
  const data = await api('fill', { method: 'POST' }).catch(() => null); // new photos fill any empty days right away
  if (data) setState(data);
}

async function makePost() {
  if (!postFiles.length) { toast('Pick a photo first'); return; }
  const caption = $('#post-cap').value.trim();
  if (!caption) { toast('Write a caption'); return; }
  if (when === 'day' && !$('#post-day').value) { toast('Pick a day'); return; }
  const form = new FormData();
  for (const [i, s] of postFiles.entries()) {
    const { blob, width, height } = await prepare(s.file);
    form.append('photo', blob, `photo${i}.jpg`); form.set(`width${i}`, width); form.set(`height${i}`, height);
  }
  form.set('caption', caption);
  form.set('day', when === 'day' ? $('#post-day').value : '');
  const data = await act('custom', { form }, when === 'now' ? 'Posting…' : 'Saving…');
  if (data) {
    toast(when === 'now' ? 'Posted' : 'Scheduled');
    postFiles.forEach((s) => URL.revokeObjectURL(s.url)); postFiles = []; $('#post-cap').value = ''; $('#post-count').textContent = `0 / ${LIMIT}`;
    renderStaged();
  }
}

// ---------- lock + open-app alert ----------

function lock() { $('#lock').hidden = false; $('#pin').value = ''; }
function checkAlert() {
  const { n, lastDay } = runway();
  if (n >= 3 || !S.posts.length) return;
  $('#alert-title').textContent = n ? `${n} day${n === 1 ? '' : 's'} left until you're out of posts` : 'Nothing is approved';
  $('#alert-text').textContent = n
    ? `Only ${n} post${n === 1 ? ' is' : 's are'} approved. After ${dayLabel(lastDay)}, nothing posts until you approve more.`
    : 'Nothing is approved yet, so nothing will post until you approve some.';
  $('#alert').hidden = false; $('#scrim').hidden = false;
}

$('#unlock').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#pin-error').textContent = '';
  try {
    await api('unlock', { body: { pin: $('#pin').value } });
    $('#lock').hidden = true;
    setState(await api('fill', { method: 'POST' }));
    checkAlert();
  } catch (err) { $('#pin-error').textContent = err.message; }
});

// ---------- events ----------

document.addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  const opener = e.target.closest('[data-open]');
  if (opener && (!b || b === opener)) { openSheet(Number(opener.dataset.open)); return; }
  if (!b) return;
  const d = b.dataset;

  if (d.alert) {
    $('#alert').hidden = true; $('#scrim').hidden = true;
    if (d.alert === 'go') { setFilter('need'); go('queue'); }
    return;
  }
  if (d.more) { await act('write-more', {}, 'Picking photos…'); return; }
  if (d.go) { if (d.filter) setFilter(d.filter); go(d.go); return; }
  if (d.filter) { setFilter(d.filter); return; }
  if (d.close) { await saveSheetCaption(); closeSheet(); return; }
  if (d.pick) { const box = $('#sheet-cap'); box.value = d.pick; $('#sheet-count').textContent = `${graphemes(d.pick)} / ${LIMIT}`; return; }

  if (d.act) {
    const id = Number(d.id);
    const inSheet = sheetFor === id && $('#sheet-cap');
    const caption = inSheet ? $('#sheet-cap').value : undefined;
    if (d.act === 'approve') { if (await act(`posts/${id}/approve`, { body: { caption } })) { toast('Approved'); closeSheet(); } return; }
    if (d.act === 'delete') { if (await act(`posts/${id}/delete`, {}, 'Finding another photo…')) { toast('Deleted. Another photo takes its day.'); closeSheet(); } return; }
    if (d.act === 'notnow') { if (await act(`posts/${id}/notnow`, {}, 'Finding another photo…')) { toast('Saved for later. Another photo takes its day.'); closeSheet(); } return; }
    if (d.act === 'redraft') { await act(`posts/${id}/redraft`, {}, 'Writing captions…'); return; }
    if (d.act === 'now') { if (await act(`posts/${id}/now`, { body: { caption } }, 'Posting…')) { toast('Posted'); closeSheet(); } return; }
  }
  if (b.id === 'approve-all') { if (await act('approve-all', {})) toast('Approved'); return; }
  if (d.ppick) { const id = Number(d.ppick); picked.has(id) ? picked.delete(id) : picked.add(id); renderStash(); return; }
  if (d.photos) {
    const ids = [...picked];
    if (await act(`photos/${d.photos}`, { body: { ids } }, d.photos === 'next' ? 'Moving them up…' : '')) {
      toast(d.photos === 'next' ? `${ids.length} moved to the front` : 'Removed');
      await loadStash();
    }
    return;
  }
  if (d.note) { await act(`notes/${d.note}/delete`, {}); return; }
  if (b.id === 'rewrite') { const ids = stale; stale = []; if (await act('rewrite', { body: { ids } })) toast('Rewriting. They’ll need approval again'); return; }
  if (b.id === 'keep') { stale = []; render(); return; }
  if (d.unstage) { URL.revokeObjectURL(staged[d.unstage].url); staged.splice(Number(d.unstage), 1); renderStaged(); return; }
  if (d.unpost) { URL.revokeObjectURL(postFiles[d.unpost].url); postFiles.splice(Number(d.unpost), 1); renderStaged(); return; }
  if (b.id === 'upload') { uploadStaged(); return; }
  if (d.when) {
    when = d.when;
    document.querySelectorAll('[data-when]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    $('#post-day').hidden = when !== 'day';
    $('#post-go').textContent = when === 'now' ? 'Post now' : 'Schedule';
    return;
  }
  if (b.id === 'post-go') { makePost(); return; }
  if (b.id === 'auto') { await act('settings', { body: { paused: !S.paused } }); toast(S.paused ? 'Posting paused' : 'Posting on'); }
});

$('#scrim').addEventListener('click', async () => {
  if (!$('#alert').hidden) return;
  await saveSheetCaption(); closeSheet();
});
document.addEventListener('input', (e) => {
  if (e.target.id === 'sheet-cap') {
    $('#sheet-count').textContent = `${graphemes(e.target.value)} / ${LIMIT}`;
    const a = $('#sheet [data-act="approve"]'); if (a) a.disabled = !e.target.value.trim();
  }
  if (e.target.id === 'post-cap') $('#post-count').textContent = `${graphemes(e.target.value)} / ${LIMIT}`;
});
$('#pick-stash').addEventListener('change', (e) => { staged = staged.concat(withUrls(e.target.files)); e.target.value = ''; renderStaged(); });
$('#pick-post').addEventListener('change', (e) => { postFiles = postFiles.concat(withUrls(e.target.files)).slice(0, 4); e.target.value = ''; renderStaged(); });
$('#tell-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('#tell').value.trim();
  if (!text) return;
  if (await act('notes', { body: { text } })) { $('#tell').value = ''; toast('Got it'); }
});

// Home fills exactly the space between the real header and tab bar.
function fitHome() {
  const root = document.documentElement.style;
  root.setProperty('--header-h', `${$('header').offsetHeight}px`);
  root.setProperty('--nav-h', `${$('nav').offsetHeight}px`);
}
addEventListener('resize', fitHome);
// Back from another app or an unlocked phone: refresh, fill empty days, and carry on writing captions.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && $('#lock').hidden) api('fill', { method: 'POST' }).then(setState).catch(() => {});
});
fitHome();

const demoState = {
  today: '2026-09-28', paused: true, stash: 12,
  notes: [
    { id: 1, kind: 'voice', text: 'Concise, warm, and informative' },
    { id: 2, kind: 'link', text: 'example.com on product posts only' },
  ],
  posts: [
    { id: 1, day: '2026-09-28', time: '18:04', kind: 'standard', status: 'draft', caption: 'A small look at what I’ve been building lately.', captionOptions: ['A small look at what I’ve been building lately.', 'Progress, one detail at a time.', 'What would you add next?'], manual: false, photos: [{ key: 'demo-1', src: 'icons/icon-512.png', alt: 'The crierbaby app icon' }] },
    { id: 2, day: '2026-09-29', time: '17:53', kind: 'standard', status: 'approved', caption: 'The next piece is ready to share.', captionOptions: ['The next piece is ready to share.'], manual: false, photos: [{ key: 'demo-2', src: 'crierbaby-tears.jpg', alt: 'A blue and gold teardrop pattern' }] },
    { id: 3, day: '2026-09-30', time: '18:12', kind: 'minimal', status: 'approved', caption: 'Coming together ✨', captionOptions: ['Coming together ✨'], manual: false, photos: [{ key: 'demo-3', src: 'crierbaby-sprite.png', alt: 'The animated crierbaby mascot sprite' }] },
  ],
};

async function showSetupStatus() {
  const labels = {
    database: 'Cloudflare D1 database', storage: 'Cloudflare KV storage', pin: 'App passcode',
    blueskyHandle: 'Bluesky handle', blueskyPassword: 'Bluesky app password', aiKey: 'AI API key',
  };
  try {
    const status = await fetch('/api/setup-status').then((r) => r.json());
    $('#setup-status').innerHTML = `<ul class="setup-list">${Object.entries(labels).map(([key, label]) =>
      `<li class="${status.configured?.[key] ? 'ok' : 'missing'}">${status.configured?.[key] ? 'Ready' : 'Missing'} · ${label}</li>`).join('')}</ul>`;
    if (!status.ready) $('#setup-help').open = true;
  } catch {
    $('#setup-status').textContent = 'Run through Cloudflare to check server configuration.';
  }
}

if (DEMO) {
  $('#lock').hidden = true;
  $('#demo-ribbon').hidden = false;
  setState(demoState);
} else {
  showSetupStatus();
  // Already signed in from earlier? Skip the lock. Opening the app also fills empty days.
  api('fill', { method: 'POST' }).then((data) => { $('#lock').hidden = true; setState(data); checkAlert(); }).catch(() => {});
}
