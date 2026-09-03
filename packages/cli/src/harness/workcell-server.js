import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const MAX_BODY_BYTES = 8 * 1024
const MAX_STATE_BYTES = 256 * 1024
const MAX_FRAME_BYTES = 2 * 1024 * 1024
const MAX_STATIC_BYTES = 512 * 1024
const MAX_VIEWERS = 8
const MAX_SSE_BUFFER_BYTES = 512 * 1024
const STATIC_FILES = Object.freeze({
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/view-state.js': ['view-state.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
})
const FRAME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])
const DIGEST = /^sha256:[0-9a-f]{64}$/
const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/
const FRAME_PATH = /^\/api\/camera\/frame\/([0-9a-f]{64})$/
const EXECUTION_PATH = /^\/api\/execution\/(refresh|prepare|approve|stop|reconcile|select|receipt)$/
const RUN_ID = /^run-[0-9a-f]{32}$/
const FORBIDDEN_TEXT = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'"

class HttpError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new HttpError(400, 'invalid_body', 'Request body has unsupported or missing fields')
  }
  return value
}

function boundedText(value, maximum, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || FORBIDDEN_TEXT.test(value)) {
    throw new HttpError(400, 'invalid_body', `${label} must be bounded printable text`)
  }
  return value
}

function identifier(value, label) {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
    throw new HttpError(400, 'invalid_body', `${label} must be a bounded identifier`)
  }
  return value
}

function headers(response) {
  response.setHeader('Cache-Control', 'no-store, max-age=0')
  response.setHeader('Pragma', 'no-cache')
  response.setHeader('Content-Security-Policy', CSP)
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('X-Frame-Options', 'DENY')
  response.setHeader('Referrer-Policy', 'no-referrer')
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
}

function jsonBytes(value) {
  const encoded = JSON.stringify(value)
  if (typeof encoded !== 'string') throw new HttpError(503, 'state_unavailable', 'Workcell state is unavailable')
  const bytes = Buffer.from(encoded)
  if (bytes.length > MAX_STATE_BYTES) throw new HttpError(503, 'state_too_large', 'Workcell response exceeds the local view limit')
  return bytes
}

function sendJson(response, status, value) {
  if (response.destroyed || response.writableEnded) return
  const bytes = jsonBytes(value)
  headers(response)
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': bytes.length })
  response.end(bytes)
}

function sendError(response, error) {
  if (response.destroyed || response.writableEnded) return
  if (response.headersSent) {
    response.destroy()
    return
  }
  // Never forward a controller error message, stack, path, credential or URL.
  const own = error instanceof HttpError
  const status = own ? error.status : ([400, 404, 409, 422, 429, 503].includes(error?.status) ? error.status : 503)
  const code = own ? error.code : (status === 409 ? 'workcell_conflict' : 'workcell_action_failed')
  const message = own ? error.message : (status === 409 ? 'Workcell state changed; refresh before retrying' : 'Workcell action could not be completed')
  response.setHeader('Connection', 'close')
  sendJson(response, status, { error: message, code })
}

function readBody(request) {
  const mediaType = String(request.headers['content-type'] || '').toLowerCase().split(';', 1)[0].trim()
  if (mediaType !== 'application/json' || request.headers['content-encoding'] || request.headers['transfer-encoding']) {
    throw new HttpError(415, 'invalid_content_type', 'A bounded application/json request is required')
  }
  const rawLength = request.headers['content-length']
  if (typeof rawLength !== 'string' || !/^(0|[1-9][0-9]*)$/.test(rawLength)) {
    throw new HttpError(411, 'content_length_required', 'Content-Length is required')
  }
  const expected = Number(rawLength)
  if (!Number.isSafeInteger(expected) || expected > MAX_BODY_BYTES) {
    throw new HttpError(413, 'body_too_large', 'Request body exceeds 8 KiB')
  }
  return new Promise((resolveBody, reject) => {
    const chunks = []
    let total = 0
    let settled = false
    const timer = setTimeout(() => finish(new HttpError(408, 'body_timeout', 'Request body timed out')), 5_000)
    timer.unref()
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      request.off('data', onData)
      request.off('end', onEnd)
      request.off('error', onError)
      request.off('aborted', onAborted)
      if (error) {
        request.resume()
        reject(error)
      } else resolveBody(value)
    }
    const onData = (chunk) => {
      total += chunk.length
      if (total > MAX_BODY_BYTES || total > expected) finish(new HttpError(413, 'body_too_large', 'Request body exceeds its limit'))
      else chunks.push(chunk)
    }
    const onEnd = () => {
      if (total !== expected) return finish(new HttpError(400, 'invalid_body', 'Request body length does not match'))
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total))
        finish(null, JSON.parse(text))
      } catch {
        finish(new HttpError(400, 'invalid_json', 'Request body must be valid JSON'))
      }
    }
    const onError = () => finish(new HttpError(400, 'invalid_body', 'Request body could not be read'))
    const onAborted = () => finish(new HttpError(400, 'invalid_body', 'Request body was interrupted'))
    request.on('data', onData)
    request.once('end', onEnd)
    request.once('error', onError)
    request.once('aborted', onAborted)
  })
}

function validateAction(path, body) {
  if (EXECUTION_PATH.test(path)) {
    const kind = path.split('/').at(-1)
    const keys = { refresh: [], prepare: ['configurationId', 'expectedConfigurationDigest', 'routeReceiptDigest'],
      approve: ['runId', 'expectedRunDigest', 'approvalDigest', 'approved'], stop: ['runId', 'reason'],
      reconcile: ['runId', 'expectedRunDigest'], select: ['runId'], receipt: ['runId'] }[kind]
    exact(body, keys)
    for (const key of keys) {
      if (key === 'runId' && (typeof body[key] !== 'string' || !RUN_ID.test(body[key]))) throw new HttpError(400, 'invalid_body', 'Run ID is invalid')
      if (key.endsWith('Digest') && (typeof body[key] !== 'string' || !DIGEST.test(body[key]))) throw new HttpError(400, 'invalid_body', 'A SHA-256 digest is required')
    }
    if (kind === 'prepare') identifier(body.configurationId, 'Configuration ID')
    if (kind === 'approve' && body.approved !== true) throw new HttpError(400, 'invalid_body', 'Explicit operator approval is required')
    if (kind === 'stop' && body.reason !== 'operator-requested-stop') throw new HttpError(400, 'invalid_body', 'Unsupported stop reason')
    return body
  }
  if (path === '/api/refresh') return exact(body, [])
  if (path === '/api/intent') {
    exact(body, ['text'])
    boundedText(body.text, 2000, 'Intent')
  } else if (path === '/api/choice') {
    exact(body, ['choiceId', 'answer'])
    identifier(body.choiceId, 'Choice ID')
    if (body.answer !== null) boundedText(body.answer, 2000, 'Answer')
  } else if (path === '/api/camera/start') {
    exact(body, ['candidateId', 'expectedCandidateDigest'])
    identifier(body.candidateId, 'Candidate ID')
    if (typeof body.expectedCandidateDigest !== 'string' || !DIGEST.test(body.expectedCandidateDigest)) {
      throw new HttpError(400, 'invalid_body', 'Expected candidate digest must be a SHA-256 digest')
    }
  } else if (path === '/api/camera/stop') {
    exact(body, ['expectedCaptureSessionId'])
    identifier(body.expectedCaptureSessionId, 'Expected capture session ID')
  }
  return body
}

/** Serve only the npm Harness's local view; this is not a node API proxy.
 *
 * The fragment bearer is session-scoped. The view must remove the fragment from
 * browser history after reading it and keep the bearer only in memory. APIs,
 * including SSE via streamed fetch, always require Authorization: Bearer.
 */
export async function createWorkcellServer({ host, assetsDir = join(dirname(fileURLToPath(import.meta.url)), 'workcell-view'), port = 0 } = {}) {
  if (!host || ['snapshot', 'subscribe', 'refresh', 'submitIntent', 'answerChoice', 'cameraAction', 'cameraFrame'].some((name) => typeof host[name] !== 'function')) {
    throw new TypeError('A complete local workcell controller is required')
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('Workcell view port must be between 0 and 65535')
  const staticRoot = resolve(assetsDir)
  const token = randomBytes(32).toString('base64url')
  const expectedBearer = Buffer.from(`Bearer ${token}`)
  const viewers = new Set()
  const sockets = new Set()
  let pendingViewers = 0
  let origin = null
  let closing = false
  let closePromise = null

  function guard(request, api) {
    const count = (name) => request.rawHeaders.filter((_, index) => index % 2 === 0 && request.rawHeaders[index].toLowerCase() === name).length
    if (count('host') !== 1 || request.headers.host !== new URL(origin).host
      || count('origin') > 1 || (request.headers.origin !== undefined && request.headers.origin !== origin)) {
      throw new HttpError(403, 'loopback_origin_required', 'Only this local workcell view origin is accepted')
    }
    if (api) {
      const authorization = request.headers.authorization
      const supplied = typeof authorization === 'string' ? Buffer.from(authorization) : Buffer.alloc(0)
      if (count('authorization') !== 1 || supplied.length !== expectedBearer.length || !timingSafeEqual(supplied, expectedBearer)) {
        throw new HttpError(401, 'session_required', 'A workcell view session is required')
      }
    }
  }

  async function serveStatic(path, response, head) {
    const [filename, contentType] = STATIC_FILES[path]
    let bytes
    try {
      const root = await realpath(staticRoot)
      const file = join(root, filename)
      const stat = await lstat(file)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STATIC_BYTES) throw new Error('not an allowed asset')
      bytes = await readFile(file)
    } catch {
      throw new HttpError(404, 'not_found', 'Not found')
    }
    if (bytes.length > MAX_STATIC_BYTES) throw new HttpError(404, 'not_found', 'Not found')
    headers(response)
    response.writeHead(200, { 'Content-Type': contentType, 'Content-Length': bytes.length })
    response.end(head ? undefined : bytes)
  }

  async function serveEvents(request, response) {
    if (viewers.size + pendingViewers >= MAX_VIEWERS) throw new HttpError(429, 'viewer_limit', 'Too many workcell viewers')
    let initial
    pendingViewers += 1
    try {
      initial = jsonBytes(await host.snapshot())
    } finally {
      pendingViewers -= 1
    }
    if (closing || response.destroyed) return
    let active = true
    let unsubscribe = null
    let leaveViewer = null
    let heartbeat = null
    let blocked = false
    let pending = null
    let reading = false
    let dirty = false
    let lastState = initial.toString('utf8')
    const cleanup = () => {
      if (!active) return
      active = false
      pending = null
      clearInterval(heartbeat)
      viewers.delete(cleanup)
      response.off('drain', drain)
      try { unsubscribe?.() } catch { /* Cleanup errors never expose controller internals. */ }
      try { leaveViewer?.() } catch { /* The controller owns its lifecycle, not this transport. */ }
      if (response.headersSent && !response.writableEnded) response.end()
    }
    const write = (event) => {
      if (!active || response.destroyed || response.writableEnded) return cleanup()
      if (response.writableLength > MAX_SSE_BUFFER_BYTES) return response.destroy()
      if (blocked) {
        pending = event // At most one bounded latest snapshot, never an event backlog.
        return
      }
      blocked = !response.write(event)
    }
    const drain = () => {
      blocked = false
      const event = pending
      pending = null
      if (event !== null) write(event)
    }
    const update = () => {
      dirty = true
      if (reading || !active) return
      reading = true
      void (async () => {
        try {
          while (dirty && active) {
            dirty = false
            const snapshot = jsonBytes(await host.snapshot()).toString('utf8')
            if (active && snapshot !== lastState) {
              lastState = snapshot
              write(`event: state\ndata: ${snapshot}\n\n`)
            }
          }
        } catch {
          cleanup()
        } finally {
          reading = false
        }
      })()
    }
    response.once('close', cleanup)
    response.once('error', cleanup)
    request.once('aborted', cleanup)
    response.on('drain', drain)
    viewers.add(cleanup)
    try {
      unsubscribe = host.subscribe(update)
      if (typeof unsubscribe !== 'function') throw new Error('Invalid subscription')
      const callback = host.onViewerConnect?.()
      if (callback !== undefined && typeof callback !== 'function') throw new Error('Invalid viewer subscription')
      leaveViewer = callback || null
      headers(response)
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Accel-Buffering': 'no' })
      response.flushHeaders()
      write(`event: state\ndata: ${initial.toString('utf8')}\n\n`)
      update() // Close the snapshot-to-subscription race without duplicating state.
      heartbeat = setInterval(() => { if (!blocked) write(': heartbeat\n\n') }, 15_000)
      heartbeat.unref()
    } catch (error) {
      cleanup()
      throw error
    }
  }

  const server = createServer({ maxHeaderSize: 16 * 1024 }, (request, response) => {
    request.on('error', () => {}) // Broken peers never become uncaught process errors.
    void (async () => {
      if (closing) throw new HttpError(503, 'view_closing', 'Workcell view is closing')
      const path = request.url || ''
      // Compare raw targets. URL normalization must not turn traversal into an
      // allowed asset or accept query-token credentials/absolute proxy targets.
      if (!path.startsWith('/') || path.includes('?') || path.includes('#') || path.includes('%') || path.includes('\\')) {
        throw new HttpError(404, 'not_found', 'Not found')
      }
      const api = path.startsWith('/api/')
      guard(request, api)
      if (Object.hasOwn(STATIC_FILES, path) && ['GET', 'HEAD'].includes(request.method)) return serveStatic(path, response, request.method === 'HEAD')
      if (request.method === 'GET' && path === '/api/state') return sendJson(response, 200, await host.snapshot())
      if (request.method === 'GET' && path === '/api/events') return serveEvents(request, response)
      const frame = path.match(FRAME_PATH)
      if (request.method === 'GET' && frame) {
        const value = await host.cameraFrame(frame[1])
        if (!(value?.bytes instanceof Uint8Array) || !value.bytes.byteLength || value.bytes.byteLength > MAX_FRAME_BYTES || !FRAME_TYPES.has(value.contentType)) {
          throw new HttpError(503, 'frame_unavailable', 'Camera frame is unavailable or exceeds the local view limit')
        }
        headers(response)
        response.writeHead(200, { 'Content-Type': value.contentType, 'Content-Length': value.bytes.byteLength })
        return response.end(Buffer.from(value.bytes.buffer, value.bytes.byteOffset, value.bytes.byteLength))
      }
      if (request.method === 'POST' && (['/api/refresh', '/api/intent', '/api/choice', '/api/camera/start', '/api/camera/stop'].includes(path) || EXECUTION_PATH.test(path))) {
        const body = validateAction(path, await readBody(request))
        let result
        if (path === '/api/refresh') result = await host.refresh()
        else if (path === '/api/intent') result = await host.submitIntent(body.text)
        else if (path === '/api/choice') result = await host.answerChoice(body)
        else if (EXECUTION_PATH.test(path)) {
          if (typeof host.executionAction !== 'function') throw new HttpError(503, 'execution_unavailable', 'Execution integration is unavailable')
          result = await host.executionAction(path.split('/').at(-1), body)
        } else result = await host.cameraAction(path.endsWith('/start') ? 'start' : 'stop', body)
        return sendJson(response, 200, result ?? { ok: true })
      }
      throw new HttpError(404, 'not_found', 'Not found')
    })().catch((error) => sendError(response, error))
  })
  server.headersTimeout = 5_000
  server.requestTimeout = 10_000
  server.keepAliveTimeout = 1_000
  server.maxRequestsPerSocket = 100
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  server.on('clientError', (_error, socket) => {
    // No raw request, URL, bearer or parser error is logged or reflected.
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
  })
  await new Promise((resolveListening, reject) => {
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port }, () => {
      server.off('error', reject)
      resolveListening()
    })
  })
  origin = `http://127.0.0.1:${server.address().port}`
  return Object.freeze({
    origin,
    openUrl: `${origin}/#token=${token}`,
    close() {
      if (closePromise) return closePromise
      closing = true
      closePromise = new Promise((resolveClosed) => {
        for (const cleanup of [...viewers]) cleanup()
        server.close(() => resolveClosed())
        for (const socket of sockets) socket.destroy()
      })
      return closePromise
    },
  })
}
