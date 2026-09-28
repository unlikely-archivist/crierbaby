import test from 'node:test';
import assert from 'node:assert/strict';
import { addDays, draftPrompt, facets, keyPhrases, looksClash, notesFor, opener, parseJson, phrases, qaFlags, repeats, worn, photoDistance, pickAngles, pickPhoto, planKinds, slotTime, weekday } from '../worker/text.js';

const linked = (text) => {
  const bytes = new TextEncoder().encode(text);
  return facets(text).map((f) => [
    new TextDecoder().decode(bytes.slice(f.index.byteStart, f.index.byteEnd)),
    f.features[0].uri,
  ]);
};

test('bare domains become https links, byte offsets survive emoji', () => {
  assert.deepEqual(linked('read more at example.com'), [['example.com', 'https://example.com']]);
});

test('trailing punctuation is not part of the link', () => {
  assert.deepEqual(linked('details at example.org.'), [['example.org', 'https://example.org']]);
});

test('full urls keep their scheme and path', () => {
  assert.deepEqual(linked('see https://example.com/events!'), [['https://example.com/events', 'https://example.com/events']]);
});

test('ellipses and missing spaces are not links', () => {
  assert.deepEqual(linked('almost done… see you there.Ready?'), []);
});

test('slot times: weekdays ~6 pm, Saturday ~5 pm, Sunday ~4 pm, within 20 minutes', () => {
  assert.equal(slotTime('2026-09-28', () => 0.5), '18:00'); // Monday, no jitter
  assert.equal(slotTime('2026-09-26', () => 0), '16:40'); // Saturday, 20 min early
  assert.equal(slotTime('2026-09-27', () => 1), '16:20'); // Sunday, 20 min late
});

test('addDays crosses months and DST without drifting', () => {
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(addDays('2026-11-01', 1), '2026-11-02'); // DST ends Nov 1
  assert.equal(weekday('2026-09-27'), 0);
});

test('planKinds: each week has one minimal post, the rest standard', () => {
  const days = Array.from({ length: 7 }, (_, i) => addDays('2026-09-28', i));
  const kinds = planKinds(days, () => 0.3);
  assert.equal(kinds.filter((k) => k === 'minimal').length, 1);
  assert.equal(kinds.filter((k) => k === 'standard').length, 6);
});

test('draftPrompt carries the post day and account instructions', () => {
  const p = draftPrompt({ kind: 'standard', day: '2026-10-01', today: '2026-09-25', notes: [{ kind: 'voice', text: 'Keep it short' }] }, 2);
  assert.match(p, /\[voice\] Keep it short/);
  assert.match(p, /goes out 2026-10-01/);
  assert.match(p, /"alts": \["\.\.\.", "\.\.\."\]/);
  assert.doesNotMatch(draftPrompt({ kind: 'minimal' }, 1), /The account owner's instructions \(today/i);
});

test('parseJson strips code fences', () => {
  assert.deepEqual(parseJson('```json\n{"captions": ["hi"]}\n```'), { captions: ['hi'] });
});

test('draftPrompt gives each option its own angle and steers away from recent captions and clichés', () => {
  const p = draftPrompt({ kind: 'standard', recent: ['A familiar opening line'], angles: ['A', 'B', 'C'] }, 1);
  assert.match(p, /Caption 1 is A; caption 2 is B; caption 3 is C/);
  assert.match(p, /must be clearly different[\s\S]*A familiar opening line/);
  assert.match(p, /Past captions from this account/);
  assert.match(p, /Never name a person, city, region, country, venue, brand, event, or business unless it appears in the account owner's instructions/);
  assert.doesNotMatch(draftPrompt({ kind: 'minimal', angles: ['A', 'B', 'C'] }, 1), /Caption 1 is/);
  assert.equal(new Set(pickAngles()).size, 3);
});

const sig = (h, v) => ({ h, c: Array(48).fill(v) });
test('photoDistance: same shoot is close, different shoot is far, unknown is in between', () => {
  const pool = sig('f0f0f0f0f0f0f0f0', 200);
  assert.ok(photoDistance(pool, sig('f0f0f0f0f0f0f0f1', 198)) < 0.05);
  assert.ok(photoDistance(pool, sig('0f0f0f0f0f0f0f0f', 40)) > 0.7);
  assert.equal(photoDistance(pool, null), 0.5);
});

test('pickPhoto picks at random among photos unlike the neighbours, never the look-alike', () => {
  const yesterday = sig('f0f0f0f0f0f0f0f0', 200);
  const sameShoot = { id: 1, sig: sig('f0f0f0f0f0f0f0f0', 201) };
  const a = { id: 2, sig: sig('0f0f0f0f0f0f0f0f', 60) };
  const b = { id: 3, sig: sig('00ff00ff00ff00ff', 40) };
  const picks = new Set([0, 0.4, 0.99].map((r) => pickPhoto([sameShoot, a, b], [yesterday], () => r).id));
  assert.ok(!picks.has(1));
  assert.deepEqual([...picks].sort(), [2, 3]); // both good photos get chosen, not always the same one
  assert.equal(pickPhoto([sameShoot], [yesterday]).id, 1); // no choice left: still fills the day
});

test('looksClash: same subject, or same setting and lighting, clash; a different shoot does not', () => {
  const a = 'black ceramic mug | wooden desk with red notebook | warm window light';
  assert.ok(looksClash(a, 'black ceramic mug | kitchen counter | bright overhead light'));
  assert.ok(looksClash(a, 'white teapot | wooden desk, red notebook | warm window glow'));
  assert.ok(!looksClash(a, 'red bicycle | city street, parked cars | harsh midday sun'));
  assert.ok(!looksClash(a, ''));
  assert.ok(!looksClash('red canvas umbrella | beach | sun', 'white canvas umbrella | park | window'));
  assert.ok(looksClash('red canvas umbrella | beach | sun', 'red canvas umbrella stand | patio | shade'));
});

test('notesFor: links only on about every third day; voice notes every day', () => {
  const notes = [{ kind: 'link', text: 'example.com' }, { kind: 'link', text: 'example.org (product posts only)' }, { kind: 'voice', text: 'less emoji' }];
  const days = Array.from({ length: 14 }, (_, i) => addDays('2026-09-28', i));
  const linkDays = days.filter((d) => notesFor('standard', d, notes).links.length);
  assert.ok(linkDays.length >= 4 && linkDays.length <= 5);
  assert.ok(days.every((d) => notesFor('standard', d, notes).notes.some((n) => n.kind === 'voice')));
});

test('draftPrompt: no link means no links; a chosen link appears exactly once; yearless dates are upcoming', () => {
  assert.match(draftPrompt({ kind: 'standard' }, 1), /Do not include any links/);
  assert.match(draftPrompt({ kind: 'standard', links: ['example.org (product posts only)'] }, 1), /at most ONE per caption, only if it fits this photo[\s\S]*product posts only/);
  assert.match(draftPrompt({ kind: 'standard', notes: [{ kind: 'voice', text: 'mention the sale ends may 2' }] }, 1), /date with no year means the next time/);
});

test('repeat check catches a reused line even with different punctuation, and names worn phrases', () => {
  const past = ['Do you think you could build this in a day?', 'Do you think you could try it too? 🙂', 'Fresh paint and waiting…'];
  const pastPhrases = new Set(past.flatMap((c) => [...phrases(c)]));
  assert.ok(repeats('do you think you could guess the color...', pastPhrases) > 0);
  assert.equal(repeats('The water was warmer than I expected', pastPhrases), 0);
  assert.ok(worn(past).includes('do you think you'));
  assert.match(draftPrompt({ kind: 'standard', recent: past, banned: worn(past) }, 1), /already overused[\s\S]*"do you think you"/);
});

test('same two-word opening counts as a repeat', () => {
  const past = ['Be honest, is this too much color?'];
  const openers = new Set(past.map(opener));
  assert.ok(repeats('Be honest, would you change anything?', new Set(), openers) > 0);
  assert.equal(repeats('Honestly the paint dried fast', new Set(), openers), 0);
});

test('keyPhrases catch "under this lamp" but not filler like "i have a"', () => {
  assert.ok(keyPhrases('The paint dries slowly under this lamp...').has('under this lamp'));
  assert.ok(!keyPhrases('I have a few ideas').has('i have a'));
});

test('QA sends back later drafts that repeat a phrase or overuse a word; approved posts and max rewrites are left alone', () => {
  const posts = [
    { id: 1, day: '2026-10-01', status: 'draft', caption: 'The paint is still wet under this lamp...' },
    { id: 2, day: '2026-10-02', status: 'draft', caption: 'Fresh from the studio and ready for trouble.' },
    { id: 3, day: '2026-10-03', status: 'draft', caption: 'This mug looks tiny under this lamp' },
    { id: 4, day: '2026-10-04', status: 'approved', caption: 'Warm light under this lamp' },
    { id: 5, day: '2026-10-05', status: 'draft', caption: 'Trouble looks good on this shelf.', rewrites: 2 },
    { id: 6, day: '2026-10-06', status: 'draft', caption: 'Pure trouble, and proud of it.' },
    { id: 7, day: '2026-10-07', status: 'draft', caption: 'Guess what I found in the garden?' },
  ];
  assert.deepEqual(qaFlags(posts), [3, 6]);
});
