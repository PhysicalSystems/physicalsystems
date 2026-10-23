// SPDX-License-Identifier: Apache-2.0
import http from 'node:http'
import { Readable } from 'node:stream'

/** A fetch-shaped transport for the one authenticated Node behind an SSH tunnel.
 * Node's built-in fetch ignores Host overrides, so use HTTP directly here.
 * No redirects, alternate origins, browser cookies or proxy environment are used.
 */
export function createSshNodeFetch(endpoint, remotePort) {
  const origin = new URL(endpoint).origin
  return (input, init = {}) => new Promise((resolve, reject) => {
    const url = new URL(input)
    if (url.origin !== origin || url.username || url.password || url.hash || url.protocol !== 'http:') {
      reject(new TypeError('Invalid SSH Node endpoint')); return
    }
    const headers = new Headers(init.headers)
    headers.set('Host', `127.0.0.1:${remotePort}`)
    const body = init.body
    if (body !== undefined && typeof body !== 'string' && !(body instanceof Uint8Array)) {
      reject(new TypeError('Unsupported SSH request body')); return
    }
    if (body !== undefined) headers.set('Content-Length', String(Buffer.byteLength(body)))
    // Node's bounded API handlers close each socket; never reuse a connection
    // while its remote FIN is still travelling through the tunnel.
    const request = http.request(url, { method: init.method || 'GET', headers: Object.fromEntries(headers), signal: init.signal, agent: false }, response => {
      const responseHeaders = new Headers()
      for (let i = 0; i < response.rawHeaders.length; i += 2) responseHeaders.append(response.rawHeaders[i], response.rawHeaders[i + 1])
      const status = response.statusCode
      if (status >= 300 && status < 400 && init.redirect === 'error') {
        response.destroy(); reject(new TypeError('SSH Node redirects are not allowed')); return
      }
      const empty = init.method === 'HEAD' || [204, 205, 304].includes(status)
      if (empty) response.resume()
      resolve(new Response(empty ? null : Readable.toWeb(response), { status, headers: responseHeaders }))
    })
    request.once('error', reject)
    request.end(body)
  })
}
