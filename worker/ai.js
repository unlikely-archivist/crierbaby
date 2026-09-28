import { draftPrompt, parseJson } from './text.js';

const DEFAULT_BASE_URL = 'https://integrate.api.nvidia.com/v1';
const DEFAULT_MODEL = 'google/gemma-4-31b-it';

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

async function chat(env, content) {
  if (!env.AI_API_KEY) throw new Error('AI_API_KEY is not configured');
  const baseUrl = (env.AI_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '');
  const model = env.AI_MODEL || DEFAULT_MODEL;
  // Compatible providers can return occasional 500s and 429s; retry those a couple of times.
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.AI_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 700, temperature: 0.8, messages: [{ role: 'user', content }] }),
    });
    if (res.ok) return (await res.json()).choices?.[0]?.message?.content ?? '';
    const retryable = res.status >= 500 || res.status === 429;
    if (!retryable || attempt === 3) throw new Error(`AI request failed: ${res.status} ${await res.text()}`);
    await new Promise((r) => setTimeout(r, attempt * 3000));
  }
}

// images: [{ type, data: ArrayBuffer }]; brief: { kind, day, today, notes }.
// Returns captions, alt text, and a visual summary. Throws when the model refuses or returns no captions.
export async function draft(env, images, brief) {
  const reply = parseJson(await chat(env, [
    { type: 'text', text: draftPrompt(brief, images.length) },
    ...images.map((im) => ({ type: 'image_url', image_url: { url: `data:${im.type};base64,${toBase64(im.data)}` } })),
  ]));
  const captions = Array.isArray(reply.captions) ? reply.captions.map(String).filter((c) => c.trim()).slice(0, 3) : [];
  if (!captions.length) throw new Error('AI returned no captions');
  return {
    captions,
    alts: images.map((_, i) => String(reply.alts?.[i] ?? '')),
    look: String(reply.look ?? '').slice(0, 200),
  };
}
