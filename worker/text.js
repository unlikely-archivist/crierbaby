// Pure helpers, kept free of Cloudflare APIs so they can be unit tested with node.

export const LIMIT = 300; // Bluesky's max post length in graphemes
export const MAX_IMAGES = 4; // Bluesky's max images per post
export const MAX_IMAGE_BYTES = 2_000_000; // Bluesky rejects bigger image blobs
export const TIMEZONE = 'UTC';
export const DRAFT_AHEAD_DAYS = 14;

export const graphemes = (s) => [...new Intl.Segmenter().segment(s)].length;

// Full URLs, or bare domains with common TLDs (so sentence typos are not linked).
const LINK = /(^|[\s(])(https?:\/\/[^\s]+|(?:[a-z0-9-]+\.)+(?:com|net|org|co|me|io|xyz|link|bio)\b(?:\/[^\s]*)?)/gi;

// Bluesky only makes links clickable when they're declared as facets (UTF-8 byte ranges).
export function facets(text) {
  const enc = new TextEncoder();
  const byteAt = (i) => enc.encode(text.slice(0, i)).length;
  const out = [];
  for (const m of text.matchAll(LINK)) {
    const url = m[2].replace(/[.,!?)…]+$/, '');
    const start = m.index + m[1].length;
    out.push({
      index: { byteStart: byteAt(start), byteEnd: byteAt(start + url.length) },
      features: [{ $type: 'app.bsky.richtext.facet#link', uri: /^https?:\/\//i.test(url) ? url : `https://${url}` }],
    });
  }
  return out;
}

export function localParts(date, timeZone = TIMEZONE) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(date).map((x) => [x.type, x.value]),
  );
  return { day: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

// Calendar math on YYYY-MM-DD strings (noon UTC keeps DST out of it).
export function addDays(day, n) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export const weekday = (day) => new Date(`${day}T12:00:00Z`).getUTCDay(); // 0 = Sunday

// Weekdays ~6 pm, Saturday ~5 pm, Sunday ~4 pm, each moved up to 20 minutes either way so it looks natural.
export function slotTime(day, rng = Math.random) {
  const base = { 0: 16 * 60, 6: 17 * 60 }[weekday(day)] ?? 18 * 60;
  const m = base + Math.round(rng() * 40) - 20;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

// Most days get a standard caption; one day in each seven-day run gets a minimal option.
export function planKinds(days, rng = Math.random) {
  const minimalAt = Math.floor(rng() * 7);
  return days.map((_, index) => (index % 7 === minimalAt ? 'minimal' : 'standard'));
}

const STYLE = `Write in first person for the account owner, posting to their own followers. Use a clear, natural, engaging voice without assuming the person's identity, gender, profession, relationship to the viewer, or reason for posting. Vary how captions end. At most one emoji. No hashtags. Under 250 characters. Never name a person, city, region, country, venue, brand, event, or business unless it appears in the account owner's instructions below. Do not guess where an image was taken.`;

// One angle per caption option, so the three options (and the days) don't all say the same thing.
export const ANGLES = [
  'a question for the account owner’s followers',
  'a confident statement about the image or moment',
  'a short observation about what is happening',
  'one small visible detail such as a prop, background element, color, or weather',
  'an invitation to respond',
  'a light, funny line',
  'a useful bit of context for the image',
  'what the account owner might be doing or thinking in this exact moment, without inventing facts',
  'something about the place or setting in the photo',
];
export function pickAngles(rng = Math.random) {
  const bag = [...ANGLES];
  for (let i = bag.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [bag[i], bag[j]] = [bag[j], bag[i]]; }
  return bag.slice(0, 3);
}

const KIND_BRIEF = {
  standard: 'An engaging caption about the image.',
  minimal: 'Very short: a single emoji, or one to four words. Nothing more.',
  custom: 'An engaging caption about the image.',
};

// Links appear on about every third day; voice instructions apply to every post.
export function notesFor(kind, day, notes) {
  const n = Math.round(new Date(`${day}T12:00:00Z`) / 864e5); // day number, so the pattern is stable
  const wantsLink = n % 3 === 0;
  return {
    links: wantsLink ? notes.filter((x) => x.kind === 'link').map((x) => x.text) : [],
    notes: notes.filter((x) => x.kind === 'voice'),
  };
}

// notes: [{ kind, text }] already chosen by notesFor; links: links it may use here (with any attached rules);
// day: the date the post goes out; recent: the account's latest captions; angles: one per option.
export function draftPrompt({ kind, day, today, notes = [], links = [], recent = [], banned = [], angles = ANGLES.slice(0, 3) }, imageCount) {
  const told = notes.length
    ? `\nThe account owner's instructions (today is ${today}; this post goes out ${day}. A date with no year means the next time that date comes around, so it is upcoming. Skip only dates that have clearly passed):\n${notes.map((n) => `- [${n.kind}] ${n.text}`).join('\n')}`
    : '';
  const linkRule = links.length
    ? `\nLinks: at most ONE per caption, only if it fits this photo, and follow any rule written next to it. If none fits, use no link. Write a link exactly as shown:\n${links.map((l) => `- ${l}`).join('\n')}`
    : '\nDo not include any links or website names.';
  const avoid = (recent.length
    ? `\nPast captions from this account. Every new caption must be clearly different: no reused ideas, openings, phrases or sentence shapes:\n${recent.map((c) => `- ${c}`).join('\n')}`
    : '') + (banned.length ? `\nPhrases this account has already overused. Never use any of them, even reworded slightly:\n${banned.map((p) => `- "${p}"`).join('\n')}` : '');
  const byAngle = kind === 'minimal' ? '' : ` Caption 1 is ${angles[0]}; caption 2 is ${angles[1]}; caption 3 is ${angles[2]}.`;
  return `Look closely at ${imageCount > 1 ? `these ${imageCount} images` : 'this image'} and reply with ONLY a JSON object:
{"captions": ["...", "...", "..."], "alts": [${Array(imageCount).fill('"..."').join(', ')}], "look": "... | ... | ..."}
- captions: three clearly different options. ${KIND_BRIEF[kind] ?? KIND_BRIEF.standard}${byAngle} ${STYLE} Base each on what is actually in the image.${told}${linkRule}${avoid}
- alts: one plain literal description per image, in order, for screen readers. One or two sentences each.
- look: the first image's subject, setting and lighting as three short plain phrases separated by " | ", e.g. "yellow ceramic mug | wooden desk | warm window light". Name colors and materials.`;
}

// The model often wraps its JSON in ``` fences. A refusal has no JSON at all, which throws.
export function parseJson(text) {
  const json = text.match(/\{[\s\S]*\}/)?.[0];
  if (!json) throw new Error(`AI reply had no JSON: ${text.slice(0, 200)}`);
  return JSON.parse(json);
}

// ---------- photo fingerprints ----------
// Each photo gets a tiny visual signature on upload: h = 64-bit difference hash (layout), c = 4x4 average colors
// (48 numbers: subject, setting, lighting). Photos from the same shoot score close together.

export function photoDistance(a, b) {
  if (!a?.h || !b?.h) return 0.5; // unknown: neither near nor far
  let bits = 0;
  for (let i = 0; i < 16; i++) bits += [...(parseInt(a.h[i], 16) ^ parseInt(b.h[i], 16)).toString(2)].filter((x) => x === '1').length;
  let color = 0;
  for (let i = 0; i < 48; i++) color += Math.abs((a.c[i] ?? 0) - (b.c[i] ?? 0));
  return 0.4 * (bits / 64) + 0.6 * (color / 48 / 255);
}

// Photos at least this different from everything nearby count as "not a look-alike".
export const DIFFERENT_ENOUGH = 0.2;

// A random stash photo that doesn't look like anything on the days around it. Random, so the same few photos
// don't keep winning; only if every photo looks like a neighbour does it fall back to the most different one.
export function pickPhoto(candidates, neighbours, rng = Math.random) {
  if (!candidates.length) return undefined;
  const score = (p) => (neighbours.length ? Math.min(...neighbours.map((n) => photoDistance(p.sig, n))) : 1);
  const fine = candidates.filter((p) => score(p) >= DIFFERENT_ENOUGH);
  if (fine.length) return fine[Math.floor(rng() * fine.length)];
  return candidates.reduce((best, p) => (score(p) > score(best) ? p : best));
}

// ---------- look-alikes by description ----------
// The AI's "subject | setting | lighting" note for each photo. Two posts clash if the subject matches,
// or if both the setting and the lighting match (same shoot).

const STOP = new Set(['a', 'an', 'the', 'and', 'with', 'in', 'on', 'of', 'at', 'by', 'is', 'light', 'lighting', 'room',
  'material', 'piece', 'set', 'style', 'bright', 'soft', 'natural']);
const words = (text) => new Set(String(text || '').toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 2 && !STOP.has(w)));
function overlap(a, b) {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return 0;
  let same = 0;
  for (const w of A) if (B.has(w)) same++;
  return same / Math.min(A.size, B.size);
}
const COLORS = new Set(['black', 'white', 'red', 'pink', 'purple', 'blue', 'green', 'yellow', 'orange', 'brown', 'beige', 'tan', 'gold', 'silver', 'grey', 'gray', 'cream', 'navy', 'teal', 'lavender', 'burgundy', 'maroon', 'striped', 'floral']);
const colorsOf = (text) => new Set([...words(text)].filter((w) => COLORS.has(w)));
export function looksClash(a, b) {
  if (!a || !b) return false;
  const [subjectA, settingA, lightA] = a.split('|');
  const [subjectB, settingB, lightB] = b.split('|');
  // "red canvas umbrella" and "white canvas umbrella" are different subjects.
  const cA = colorsOf(subjectA), cB = colorsOf(subjectB);
  const sameColors = !cA.size || !cB.size || [...cA].some((c) => cB.has(c));
  return (sameColors && overlap(subjectA, subjectB) >= 0.6) || (overlap(settingA, settingB) >= 0.6 && overlap(lightA, lightB) >= 0.6);
}

// ---------- no repeats ----------
// Four-word phrases, lowercased without punctuation: "Do you think you could build this" and
// "do you think you could build this..." share "do you think you", "you think you could", etc.
export function phrases(text, n = 4) {
  const w = String(text).toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);
  const out = new Set();
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(' '));
  return out;
}

// Phrases already used in two or more captions: named in the prompt so the AI steers clear.
export function worn(captions, limit = 30) {
  const counts = new Map();
  for (const c of captions) for (const p of [...phrases(c), opener(c)]) counts.set(p, (counts.get(p) || 0) + 1);
  return [...counts].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([p]) => p);
}

// How a caption opens (first two words): "Be honest, …" or "Do you …" over and over reads as a template.
export const opener = (text) => String(text).toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean).slice(0, 2).join(' ');

// How much a caption repeats past ones: shared four-word phrases, plus a same opening counts heavily.
// pastPhrases is a Set of phrases; pastOpeners (optional) a Set of openers.
export function repeats(caption, pastPhrases, pastOpeners = new Set()) {
  let hits = 0;
  for (const p of phrases(caption)) if (pastPhrases.has(p)) hits++;
  const o = opener(caption);
  if (o.split(' ').length === 2 && pastOpeners.has(o)) hits += 2;
  return hits;
}

// ---------- QA: the finished schedule, read in order ----------
// Filler words don't make a phrase or a caption distinctive; everything else does ("ceramic", "harbor", "sunrise").
const FILLER = new Set(['this', 'that', 'with', 'just', 'your', 'you\'re', 'have', 'what', 'when', 'will', 'would', 'could', 'about', 'there',
  'here', 'them', 'they', 'then', 'than', 'been', 'into', 'from', 'some', 'more', 'much', 'very', 'really', 'little', 'today', 'tonight',
  'feel', 'feeling', 'know', 'think', 'want', 'come', 'make', 'like', 'look', 'still', 'even', 'only', 'maybe', 'wonder', 'bit', 'week']);
const tokens = (text) => String(text).toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);
const distinctive = (w) => w.length >= 4 && !FILLER.has(w);

// Three-word phrases that include at least one distinctive word: "under this lamp" yes, "i have a" no.
export function keyPhrases(text) {
  const w = tokens(text), out = new Set();
  for (let i = 0; i + 3 <= w.length; i++) if (w.slice(i, i + 3).some(distinctive)) out.add(w.slice(i, i + 3).join(' '));
  return out;
}
export const keyWords = (text) => new Set(tokens(text).filter(distinctive));

// posts: in date order, [{ id, day, caption, status, rewrites }]. Returns ids of unapproved drafts to rewrite:
// ones that reuse a phrase or opening from an earlier caption, or lean on a distinctive word already used by
// two captions in the past week. A post is only sent back twice, so this can't loop.
export function qaFlags(posts) {
  const flags = [], seen = [];
  for (const p of posts) {
    if (!p.caption) continue;
    const prior = seen.filter((q) => q.day >= addDays(p.day, -7));
    const reused = seen.some((q) => opener(q.caption) === opener(p.caption) && opener(p.caption).split(' ').length === 2)
      || [...keyPhrases(p.caption)].some((ph) => seen.some((q) => q.phrases.has(ph)));
    const overused = [...keyWords(p.caption)].some((w) => prior.filter((q) => q.words.has(w)).length >= 2);
    if ((reused || overused) && p.status === 'draft' && (p.rewrites || 0) < 2) flags.push(p.id);
    else seen.push({ ...p, phrases: keyPhrases(p.caption), words: keyWords(p.caption) });
  }
  return flags;
}
