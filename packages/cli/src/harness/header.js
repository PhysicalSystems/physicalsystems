import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'

import { VERSION, versionLabel } from '../version.js'

function toolPayload(value) {
  if (value?.structuredContent && typeof value.structuredContent === 'object') {
    return value.structuredContent
  }
  for (const entry of value?.content || []) {
    if (entry?.type !== 'text' || typeof entry.text !== 'string') continue
    try {
      const parsed = JSON.parse(entry.text)
      if (parsed && typeof parsed === 'object') return parsed
    } catch {
      // A human-readable response cannot populate the structured startup table.
    }
  }
  return value && typeof value === 'object' ? value : {}
}

const DEVICE_FAMILY_ORDER = Object.freeze([
  'NVIDIA Jetson',
  'Raspberry Pi',
  'Mobile devices',
  'Other devices',
])

function deviceHints(device) {
  return [device?.device, device?.deviceType, device?.type, device?.kind, device?.model]
    .filter((value) => typeof value === 'string' && value.trim())
    .join(' ')
    .toLowerCase()
}

function deviceGroup(device) {
  const hints = deviceHints(device)
  if (/\b(?:jetson|orin|agx[ -]?thor)\b/.test(hints)) return 'NVIDIA Jetson'
  if (/\braspberry(?:[ -]?pi)?\b/.test(hints)) return 'Raspberry Pi'
  if (/\b(?:android|iphone|ipad|mobile|oppo|pixel|phone|tablet)\b|\bcph\d+\b|\bsm-[a-z]\d+\b/.test(hints)) {
    return 'Mobile devices'
  }
  return 'Other devices'
}

function deviceAvailability(device) {
  if (typeof device?.available === 'boolean') return device.available
  const state = device?.availability?.state
  if (state === 'available') return true
  if (state === 'busy' || state === 'offline') return false
  return null
}

export function summarizeDeviceInventory(value) {
  const payload = toolPayload(value)
  const devices = Array.isArray(payload?.devices) ? payload.devices : []
  const groups = new Map()
  for (const device of devices) {
    const label = deviceGroup(device)
    const current = groups.get(label) || { label, available: 0, availabilityKnown: 0, total: 0 }
    const available = deviceAvailability(device)
    current.total += 1
    if (available !== null) {
      current.availabilityKnown += 1
      if (available) current.available += 1
    }
    groups.set(label, current)
  }
  return Object.freeze([...groups.values()]
    .sort((left, right) => {
      const leftOrder = DEVICE_FAMILY_ORDER.indexOf(left.label)
      const rightOrder = DEVICE_FAMILY_ORDER.indexOf(right.label)
      return leftOrder - rightOrder || left.label.localeCompare(right.label)
    })
    .map((group) => Object.freeze({ ...group })))
}

const LOGO = Object.freeze([
  ' _____ _             _____    _            ',
  '|_   _(_)_ __  _   _| ____|__| | __ _  ___ ',
  '  | | | | \'_ \\| | | |  _| / _` |/ _` |/ _ \\',
  '  | | | | | | | |_| | |__| (_| | (_| |  __/',
  '  |_| |_|_| |_|\\__, |_____\\__,_|\\__, |\\___|',
  '                |___/              |___/      ',
])

function fit(value, width) {
  return truncateToWidth(value, width, '…')
}

function padEnd(value, width) {
  const fitted = truncateToWidth(value, width, '')
  return `${fitted}${' '.repeat(Math.max(0, width - visibleWidth(fitted)))}`
}

function availableLabel(group) {
  return group.availabilityKnown === group.total
    ? String(group.available)
    : group.availabilityKnown === 0
      ? '—'
      : `${group.available}+?`
}

function deviceRows(groups, width) {
  if (!groups.length) return ['No paired devices']
  if (width < 33) {
    const labelWidth = Math.max(6, Math.min(14, width - 7))
    return [
      `${padEnd('Family', labelWidth)}  A/P`,
      ...groups.map((group) => (
        `${padEnd(group.label, labelWidth)}  ${availableLabel(group)}/${group.total}`
      )),
    ]
  }
  const labelWidth = Math.max(14, Math.min(28, width - 19))
  const rows = [
    `${padEnd('Device family', labelWidth)}  ${'Available'.padStart(9)}  ${'Paired'.padStart(6)}`,
  ]
  for (const group of groups) {
    const available = availableLabel(group)
    rows.push(`${padEnd(group.label, labelWidth)}  ${available.padStart(9)}  ${String(group.total).padStart(6)}`)
  }
  return rows
}

export function createHarnessHeader({ getState, version = VERSION } = {}) {
  const label = version === VERSION ? versionLabel : `TinyEdge v${version}`
  return (_tui, theme) => ({
    render(width) {
      const state = getState()
      const availableWidth = Math.max(0, width)
      const wide = availableWidth >= 52
      const logo = wide ? LOGO : [label]
      const connection = state.connected
        ? 'TinyEdge account connected'
        : state.connecting
          ? 'Connecting TinyEdge account in your browser…'
          : 'TinyEdge account not connected · /tinyedge-login'
      const provider = state.modelConfigured
        ? 'Model provider ready'
        : 'Choose a model provider with /login'
      return [
        ...logo.map((line) => theme.fg('accent', fit(line, availableWidth))),
        ...(wide ? [theme.fg('muted', fit(label, availableWidth))] : []),
        theme.fg('muted', fit(`${connection} · ${provider}`, availableWidth)),
        '',
        ...deviceRows(state.deviceGroups || [], availableWidth)
          .map((line, index) => theme.fg(index === 0 ? 'muted' : 'text', fit(line, availableWidth))),
        '',
      ]
    },
    invalidate() {},
  })
}
