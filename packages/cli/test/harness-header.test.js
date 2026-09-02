import assert from 'node:assert/strict'
import test from 'node:test'

import { visibleWidth } from '@earendil-works/pi-tui'

import { createHarnessHeader } from '../src/harness/header.js'
import { VERSION } from '../src/version.js'

const theme = { fg: (_style, value) => value }

test('Harness header is local-first and reports only observed candidate count', () => {
  const component = createHarnessHeader({
    getState: () => ({
      nodeStatus: 'connected',
      nodeOrigin: 'http://127.0.0.1:8876',
      candidateCount: 3,
      modelConfigured: true,
    }),
  })(null, theme)
  const rendered = component.render(90).join('\n')
  assert.match(rendered, /PHYSICAL SYSTEMS/)
  assert.match(rendered, new RegExp(`Harness v${VERSION.replaceAll('.', '\\.')}`))
  assert.match(rendered, /Physical Systems node · connected · 3 devices observed/)
  assert.match(rendered, /Model provider · ready/)
  assert.doesNotMatch(rendered, /TinyEdge account|paired|device family|NVIDIA Jetson|Raspberry Pi/i)
})

test('Harness header renders honest local-node and provider setup states', () => {
  const unavailable = createHarnessHeader({
    getState: () => ({
      nodeStatus: 'unavailable',
      candidateCount: 0,
      modelConfigured: false,
    }),
  })(null, theme).render(90).join('\n')
  assert.match(unavailable, /Physical Systems node · unavailable · run \/physical to retry/)
  assert.match(unavailable, /Model provider · choose one with \/login/)
  assert.doesNotMatch(unavailable, /account|OAuth|paired/i)

  const connected = createHarnessHeader({
    getState: () => ({ nodeStatus: 'connected', candidateCount: 1, modelConfigured: true }),
  })(null, theme).render(90).join('\n')
  assert.match(connected, /1 device observed/)
  assert.doesNotMatch(connected, /1 devices observed/)
})

test('Harness header never renders wider than a narrow terminal', () => {
  const component = createHarnessHeader({
    getState: () => ({
      nodeStatus: 'checking',
      nodeOrigin: 'http://127.0.0.1:8876',
      candidateCount: 0,
      modelConfigured: false,
    }),
  })(null, theme)

  for (const width of [0, 1, 8, 16, 23, 52]) {
    assert.ok(component.render(width).every((line) => visibleWidth(line) <= width))
  }
  assert.match(component.render(24).join('\n'), /PHYSICAL SYSTEMS/)
})
