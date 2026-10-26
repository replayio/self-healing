import { z } from 'zod'

const ResourceSchema = z.object({ data: z.union([z.string(), z.instanceof(ArrayBuffer)]), contentType: z.string(), filename: z.string() })
const PayloadSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('string'), data: z.string() }),
  z.object({ type: z.literal('ArrayBuffer'), data: z.instanceof(ArrayBuffer) }),
  z.object({ type: z.literal('FormData'), data: z.record(z.union([z.string(), ResourceSchema, z.undefined()])) }),
])

function payload(value: unknown): { body: ArrayBuffer; binary: true } | { body?: BodyInit; binary: false } {
  if (value == null) return { binary: false }
  const parsed = PayloadSchema.parse(value)
  if (parsed.type === 'FormData') {
    const form = new FormData()
    for (const [name, item] of Object.entries(parsed.data)) {
      if (typeof item === 'string') form.append(name, item)
      else if (item) form.append(name, new Blob([item.data], { type: item.contentType }), item.filename)
    }
    return { body: form, binary: false }
  }
  return parsed.type === 'ArrayBuffer' ? { body: parsed.data, binary: true } : { body: parsed.data, binary: false }
}

/** FullStory's request/beacon hooks keep binary capture out of Netlify's text-body conversion. */
export function createFullstoryProxyTransport(
  baseUrl: string,
  key: string,
  send: typeof fetch = (...args) => fetch(...args),
) {
  const base = new URL(baseUrl)
  function target(value: string) {
    const url = new URL(value)
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname + '/')) throw new Error('Capture transport target mismatch')
    return url.href
  }
  return {
    async request(scheme: string, method: string, url: string, _credentials: boolean, inputHeaders: Record<string, string>, value: unknown) {
      const parsed = payload(value)
      const headers = new Headers(inputHeaders)
      headers.set('Authorization', `Bearer ${key}`)
      if (parsed.binary) headers.set('Content-Type', 'application/octet-stream')
      const response = await send(target(scheme + url), {
        method, headers, body: parsed.body, credentials: 'omit', redirect: 'error',
      })
      return { status: response.status, responseText: await response.text() }
    },
    beacon(url: string, value: unknown) {
      const parsed = payload(value)
      const size = parsed.body instanceof ArrayBuffer ? parsed.body.byteLength
        : typeof parsed.body === 'string' ? new TextEncoder().encode(parsed.body).byteLength : 0
      // Let the recorder use its normal upload fallback rather than claim an oversized keepalive.
      if (size > 60_000 || parsed.body instanceof FormData) return false
      const headers = new Headers({ Authorization: `Bearer ${key}` })
      if (parsed.binary) headers.set('Content-Type', 'application/octet-stream')
      // fetch keepalive supports the upload credential without putting it in an access-log URL.
      void send(target(url), { method: 'POST', body: parsed.body, headers, credentials: 'omit', keepalive: true, redirect: 'error' }).catch(() => {})
      return true
    },
  }
}
