import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gzipSync, gunzipSync } from 'node:zlib'
import { createFullstoryProxyTransport } from '../packages/capture/src/recorder-transport.ts'
test('compressed uploads and unload keepalive carry the QA key only in a header', async () => {
  const calls: RequestInit[] = []
  const transport = createFullstoryProxyTransport('https://qa.test/capture/client', 'upload-key', async (url, init) => {
    assert.equal(String(url).includes('upload-key'), false)
    calls.push(init!)
    assert.equal(new Headers(init!.headers).get('authorization'), 'Bearer upload-key')
    assert.equal(new Headers(init!.headers).get('content-type'), 'application/octet-stream')
    assert.equal(gunzipSync(Buffer.from(await new Response(init!.body).arrayBuffer())).toString(), 'session events')
    return new Response('{}')
  })
  const payload = { type: 'ArrayBuffer', data: Uint8Array.from(gzipSync('session events')).buffer }
  await transport.request('https:', 'POST', '//qa.test/capture/client/rec/bundle', true, { 'Content-Type': 'text/plain' }, payload)
  assert.equal(transport.beacon('https://qa.test/capture/client/rec/beacon', payload), true)
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(calls.length, 2)
  assert.equal(calls[1]!.keepalive, true)
  assert.equal(calls[0]!.credentials, 'omit')
  await assert.rejects(transport.request('https:', 'POST', '//other.test/rec/page', false, {}, payload), /target mismatch/)
})
test('oversized unload payloads return false so the recorder can fall back to a regular upload', () => {
  const transport = createFullstoryProxyTransport('https://qa.test/capture/client', 'upload-key', async () => { throw new Error('Must not send') })
  assert.equal(transport.beacon('https://qa.test/capture/client/rec/beacon', { type: 'ArrayBuffer', data: new ArrayBuffer(65_536) }), false)
})

import { managedCapture } from '../packages/capture/src/managed.ts';
test('managed options hide routing configuration and reject arbitrary origins and malformed keys', () => {
  const key = `lqc_${'a'.repeat(43)}`;
  const client = managedCapture({ publishableKey: key }, fetch);
  assert.equal(client.recorderOptions.orgId, 'replay');
  assert.equal(client.endpoint.href, 'https://qa.replay.io/api/monitoring-register');
  assert.deepEqual(JSON.parse(client.encode(JSON.stringify({ session_url: 'https://qa.replay.io/ui/replay/client-session/device%3Asession', auxiliary_data: [] }))),
    { session: { id: 'device:session', kind: 'client-session' }, auxiliary_data: [] });
  assert.throws(() => managedCapture({ publishableKey: 'secret' }, fetch));
  for (const serviceUrl of ['http://qa.test', 'https://secret@qa.test', 'https://qa.test/path', 'https://qa.test?token=x'])
    assert.throws(() => managedCapture({ publishableKey: key, serviceUrl }, fetch));
  assert.throws(() => client.encode(JSON.stringify({ session_url: 'https://app.fullstory.com/ui/ORG/session/a%3Ab', auxiliary_data: [] })));
  assert.equal(client.isTransport('https://qa.replay.io/api/fullstory-capture/rec/page'), true);
  assert.equal(client.isTransport('https://qa.replay.io/api/monitoring-register'), true);
  assert.equal(client.isTransport('https://qa.replay.io.example.com/api/monitoring-register'), false);
});
