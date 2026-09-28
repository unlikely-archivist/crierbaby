import test from 'node:test';
import assert from 'node:assert/strict';
import { postToBluesky } from '../worker/bluesky.js';

// Fake Bluesky: uploads return blob `uploaded`; recent posts are `recent`. Records which endpoints were hit.
function fakeBluesky({ uploaded, recent }) {
  const calls = [];
  globalThis.fetch = async (url) => {
    const method = new URL(url).pathname.split('/').pop();
    calls.push(method);
    const reply = {
      'com.atproto.server.createSession': { accessJwt: 'jwt', did: 'did:plc:example', handle: 'creator.example' },
      'com.atproto.repo.uploadBlob': { blob: { $type: 'blob', ref: { $link: uploaded }, mimeType: 'image/jpeg', size: 3 } },
      'com.atproto.repo.listRecords': { records: recent },
      'com.atproto.repo.createRecord': { uri: 'at://did:plc:example/app.bsky.feed.post/new' },
    }[method];
    return new Response(JSON.stringify(reply));
  };
  return calls;
}

const earlier = (cid, uri) => ({
  uri,
  value: { text: '✨', embed: { images: [{ image: { ref: { $link: cid } } }] } },
});
const post = { caption: 'A test post' };
const images = [{ type: 'image/jpeg', data: new ArrayBuffer(3), width: 1, height: 1, alt: '' }];

test('a retry does not mistake an earlier post with the same caption for this one', async () => {
  const calls = fakeBluesky({ uploaded: 'cid-today', recent: [earlier('cid-last-week', 'at://did:plc:example/app.bsky.feed.post/old')] });
  const url = await postToBluesky({ BLUESKY_HANDLE: 'creator.example', BLUESKY_APP_PASSWORD: 'test-password' }, post, images, { retry: true });
  assert.ok(calls.includes('com.atproto.repo.createRecord'));
  assert.equal(url, 'https://bsky.app/profile/creator.example/post/new');
});

test('a retry finds the earlier attempt that went through by its photos, and does not post twice', async () => {
  const calls = fakeBluesky({ uploaded: 'cid-today', recent: [earlier('cid-today', 'at://did:plc:example/app.bsky.feed.post/done')] });
  const url = await postToBluesky({ BLUESKY_HANDLE: 'creator.example', BLUESKY_APP_PASSWORD: 'test-password' }, post, images, { retry: true });
  assert.ok(!calls.includes('com.atproto.repo.createRecord'));
  assert.equal(url, 'https://bsky.app/profile/creator.example/post/done');
});
