import { facets } from './text.js';

const SERVICE = 'https://bsky.social';

async function createSession(env) {
  if (!env.BLUESKY_HANDLE) throw new Error('BLUESKY_HANDLE is not configured');
  if (!env.BLUESKY_APP_PASSWORD) throw new Error('BLUESKY_APP_PASSWORD is not configured');
  const res = await fetch(`${SERVICE}/xrpc/com.atproto.server.createSession`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: env.BLUESKY_HANDLE, password: env.BLUESKY_APP_PASSWORD }),
  });
  if (!res.ok) throw new Error(`Bluesky login failed: ${res.status} ${await res.text()}`);
  const session = await res.json();
  // Guard against posting to the wrong account if the password is ever mixed up.
  if (session.handle !== env.BLUESKY_HANDLE) throw new Error(`Logged in as ${session.handle}, expected ${env.BLUESKY_HANDLE}; refusing to post`);
  return session;
}

const postUrl = (handle, uri) => `https://bsky.app/profile/${handle}/post/${uri.split('/').pop()}`;

// post: { caption }. images: [{ type, data: ArrayBuffer, width, height, alt }].
// retry: an earlier attempt may have gone through even though its reply never came back, so look for it before posting.
export async function postToBluesky(env, post, images, { retry = false } = {}) {
  const { accessJwt, did, handle } = await createSession(env);
  const auth = { authorization: `Bearer ${accessJwt}` };

  const embedded = [];
  for (const im of images) {
    const upload = await fetch(`${SERVICE}/xrpc/com.atproto.repo.uploadBlob`, {
      method: 'POST',
      headers: { ...auth, 'content-type': im.type },
      body: im.data,
    });
    if (!upload.ok) throw new Error(`Bluesky image upload failed: ${upload.status} ${await upload.text()}`);
    embedded.push({
      alt: im.alt,
      image: (await upload.json()).blob,
      ...(im.width && im.height ? { aspectRatio: { width: im.width, height: im.height } } : {}),
    });
  }

  if (retry) {
    // Matched by photos, not caption: short captions like "✨" repeat. Blob ids come from the file bytes,
    // so re-uploading gives the same ids an earlier attempt used.
    const blobs = (images) => (images || []).map((im) => im.image?.ref?.$link).join(' ');
    const res = await fetch(`${SERVICE}/xrpc/com.atproto.repo.listRecords?repo=${did}&collection=app.bsky.feed.post&limit=10`, { headers: auth });
    if (!res.ok) throw new Error(`Bluesky check failed: ${res.status} ${await res.text()}`);
    const done = (await res.json()).records?.find((r) => blobs(r.value?.embed?.images) === blobs(embedded));
    if (done) return postUrl(handle, done.uri);
  }

  const record = {
    $type: 'app.bsky.feed.post',
    text: post.caption,
    facets: facets(post.caption),
    createdAt: new Date().toISOString(),
    embed: { $type: 'app.bsky.embed.images', images: embedded },
  };
  const res = await fetch(`${SERVICE}/xrpc/com.atproto.repo.createRecord`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ repo: did, collection: 'app.bsky.feed.post', record }),
  });
  if (!res.ok) throw new Error(`Bluesky post failed: ${res.status} ${await res.text()}`);
  return postUrl(handle, (await res.json()).uri);
}
