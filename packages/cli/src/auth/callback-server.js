import http from 'node:http'

const SUCCESS_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TinyEdge authentication successful</title><style>
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#08090b;color:#f7f4ef}*{box-sizing:border-box}body{margin:0;display:grid;min-height:100vh;place-items:center;background:radial-gradient(circle at 50% 42%,#211b16 0,#101011 28%,#08090b 62%)}main{width:min(480px,calc(100vw - 40px));text-align:center}.mark{display:grid;width:64px;height:64px;margin:0 auto 24px;place-items:center;border:1px solid #51483f;border-radius:18px;background:#151310;box-shadow:0 18px 70px #ee7b3d24}.mark svg{width:39px;height:39px}h1{margin:0;font-size:27px;line-height:1.16;letter-spacing:-.04em}p{margin:10px auto 0;color:#aaa49b;font-size:14px;line-height:1.55}.wordmark{margin-top:26px;color:#6f6961;font-size:12px;font-weight:700;letter-spacing:.16em;text-transform:uppercase}
</style></head><body><main><div class="mark" role="img" aria-label="TinyEdge logo"><svg viewBox="0 0 64 64" fill="none" aria-hidden="true"><path d="M32 7 55 20 32 33 9 20 32 7Z" fill="#2b211b"/><path d="M9 20 32 33v25L9 45V20Z" fill="#171514"/><path d="M55 20 32 33v25l23-13V20Z" fill="#201915"/><path d="M32 7 55 20v25L32 58 9 45V20L32 7Z" stroke="#ee7b3d" stroke-width="2" stroke-linejoin="round"/><path d="M32 33v25M32 33 9 20m23 13 23-13" stroke="#ee7b3d" stroke-width="1.5" stroke-linejoin="round" opacity=".55"/><rect x="26.5" y="15" width="11" height="11" rx="2" fill="#ee7b3d"/><rect x="29" y="17.5" width="6" height="6" rx="1" fill="#17130f"/></svg></div><h1>Authentication successful</h1><p>TinyEdge authentication completed. You can close this window.</p><div class="wordmark">TinyEdge</div></main></body></html>`

export const DEFAULT_OAUTH_CALLBACK_TIMEOUT_MS = 5 * 60_000

export async function startOAuthCallback({
  expectedState,
  timeoutMs = DEFAULT_OAUTH_CALLBACK_TIMEOUT_MS,
} = {}) {
  if (!expectedState) throw new TypeError('OAuth callback requires an expected state')

  let settle
  const result = new Promise((resolve, reject) => {
    settle = { resolve, reject }
  })
  let settled = false
  let timer

  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url || '/', 'http://127.0.0.1')
    if (request.method !== 'GET' || requestUrl.pathname !== '/callback') {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('Not found')
      return
    }

    const state = requestUrl.searchParams.get('state')
    const code = requestUrl.searchParams.get('code')
    const oauthError = requestUrl.searchParams.get('error')
    if (state !== expectedState) {
      response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('Invalid OAuth state. Return to the terminal and try again.')
      finish(new Error('OAuth callback state did not match'))
      return
    }
    if (oauthError) {
      response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('TinyEdge authorization was not completed.')
      finish(new Error(`TinyEdge authorization failed: ${oauthError}`))
      return
    }
    if (!code) {
      response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('Authorization code is missing.')
      finish(new Error('OAuth callback did not contain an authorization code'))
      return
    }

    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
    })
    response.end(SUCCESS_PAGE)
    finish(null, { code, state })
  })

  function finish(error, value) {
    if (settled) return
    settled = true
    clearTimeout(timer)
    server.close()
    if (error) settle.reject(error)
    else settle.resolve(value)
  }

  server.on('error', (error) => finish(error))
  await new Promise((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
    server.listen(0, '127.0.0.1')
  })

  const address = server.address()
  const redirectUri = `http://127.0.0.1:${address.port}/callback`
  timer = setTimeout(() => finish(new Error('TinyEdge authorization timed out')), timeoutMs)
  timer.unref?.()

  return Object.freeze({
    redirectUri,
    result,
    close() {
      finish(new Error('TinyEdge authorization was cancelled'))
    },
  })
}
