import assert from 'node:assert/strict'
import test from 'node:test'

import { visibleWidth } from '@earendil-works/pi-tui'

import { createHarnessHeader, summarizeDeviceInventory } from '../src/harness/header.js'
import { VERSION } from '../src/version.js'

test('device inventory groups pairing records into concise product families', () => {
  const groups = summarizeDeviceInventory({
    structuredContent: {
      devices: [
        {
          device: 'jetson-agx-thor',
          model: 'NVIDIA Jetson AGX Thor Developer Kit',
          availability: { state: 'available' },
        },
        {
          device: 'jetson-orin-nano',
          model: 'NVIDIA Jetson Orin Nano Engineering Reference Developer Kit Super',
          availability: { state: 'offline' },
        },
        { device: 'jetson-orin-nano', model: 'NVIDIA Jetson Orin Nano', available: false },
        { device: 'raspberry-pi-5', model: 'Raspberry Pi 5 Model B Rev 1.1', available: false },
        { device: 'oppo-a74', model: 'OPPO CPH2219', available: true },
        { device: 'samsung-sm-p613', model: 'samsung SM-P613', available: false },
        { device: 'samsung-sm-p613', model: 'samsung SM-P613', available: false },
        { device: 'ubuntu-replay', model: 'Ubuntu workstation', available: true },
        { device: 'mystery-unit', model: 'Unclassified board', available: false },
      ],
    },
  })
  assert.deepEqual(groups, [
    { label: 'NVIDIA Jetson', available: 1, availabilityKnown: 3, total: 3 },
    { label: 'Raspberry Pi', available: 0, availabilityKnown: 1, total: 1 },
    { label: 'Mobile devices', available: 1, availabilityKnown: 3, total: 3 },
    { label: 'Other devices', available: 1, availabilityKnown: 2, total: 2 },
  ])
  assert.equal(groups.reduce((sum, group) => sum + group.total, 0), 9)
})

test('Harness header renders Physical Systems identity and honest device totals', () => {
  const component = createHarnessHeader({
    getState: () => ({
      connected: true,
      modelConfigured: true,
      deviceGroups: [{ label: 'NVIDIA Jetson', available: 1, availabilityKnown: 1, total: 2 }],
    }),
  })(null, { fg: (_style, value) => value })
  const lines = component.render(90)
  assert.match(lines.join('\n'), /PHYSICAL SYSTEMS/)
  assert.match(lines.join('\n'), new RegExp(`Harness v${VERSION.replaceAll('.', '\\.')}`))
  assert.match(lines.join('\n'), /TinyEdge account connected/)
  assert.match(lines.join('\n'), /Device family\s+Available\s+Paired/)
  assert.match(lines.join('\n'), /NVIDIA Jetson\s+1\+\?\s+2/)
  assert.doesNotMatch(lines.join('\n'), /Developer Kit|Engineering Reference/)
})

test('Harness header never renders wider than a narrow terminal', () => {
  const component = createHarnessHeader({
    getState: () => ({
      connected: false,
      modelConfigured: false,
      deviceGroups: [{ label: 'Raspberry Pi', available: 1, availabilityKnown: 1, total: 1 }],
    }),
  })(null, { fg: (_style, value) => value })

  for (const width of [0, 1, 8, 16, 23]) {
    assert.ok(component.render(width).every((line) => visibleWidth(line) <= width))
  }
  assert.match(component.render(24).join('\n'), /PHYSICAL SYSTEMS/)
})

test('compact Harness table keeps family counts visible', () => {
  const component = createHarnessHeader({
    getState: () => ({
      connected: true,
      modelConfigured: true,
      deviceGroups: [
        { label: 'NVIDIA Jetson', available: 1, availabilityKnown: 3, total: 3 },
        { label: 'Mobile devices', available: 0, availabilityKnown: 0, total: 2 },
      ],
    }),
  })(null, { fg: (_style, value) => value })

  for (const width of [24, 30]) {
    const rendered = component.render(width).join('\n')
    assert.match(rendered, /NVIDIA Jetson\s+1\/3/)
    assert.match(rendered, /Mobile devices\s+—\/2/)
  }
})

test('family grouping uses stable identifiers and keeps old-server availability unknown', () => {
  const groups = summarizeDeviceInventory({
    devices: [
      { device: 'jetson-orin-nano' },
      { device: 'samsung-sm-p613' },
      { device: 'unknown', model: 'Samsung laptop' },
    ],
  })
  assert.deepEqual(groups, [
    { label: 'NVIDIA Jetson', available: 0, availabilityKnown: 0, total: 1 },
    { label: 'Mobile devices', available: 0, availabilityKnown: 0, total: 1 },
    { label: 'Other devices', available: 0, availabilityKnown: 0, total: 1 },
  ])
})

test('Harness header measures wide and combined graphemes in terminal cells', () => {
  const component = createHarnessHeader({
    getState: () => ({
      connected: true,
      modelConfigured: true,
      deviceGroups: [{
        label: '界'.repeat(28) + ' e\u0301 👩🏽‍💻',
        available: 1,
        availabilityKnown: 1,
        total: 1,
      }],
    }),
  })(null, { fg: (_style, value) => value })

  assert.ok(component.render(52).every((line) => visibleWidth(line) <= 52))
})
