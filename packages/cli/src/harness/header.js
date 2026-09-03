import { truncateToWidth } from '@earendil-works/pi-tui'

import { VERSION } from '../version.js'

const LOGO = Object.freeze([
  '┌─ PHYSICAL SYSTEMS ─────────────────────────┐',
  '│ Local orchestration for real-world hardware │',
  '└─────────────────────────────────────────────┘',
])

function fit(value, width) {
  return truncateToWidth(value, width, '…')
}

function observedLabel(count) {
  const safeCount = Number.isInteger(count) && count >= 0 ? count : 0
  return `${safeCount} device${safeCount === 1 ? '' : 's'} observed`
}

function physicalNodeLine(state) {
  if (state.nodeStatus === 'checking') return 'Physical Systems node · checking local hardware…'
  if (state.nodeStatus === 'connected') {
    return `Physical Systems node · connected · ${observedLabel(state.candidateCount)}`
  }
  if (state.nodeStatus === 'unavailable') {
    return 'Physical Systems node · unavailable · run /physical to retry'
  }
  return `Physical Systems node · waiting at ${state.nodeOrigin || 'http://127.0.0.1:8876'}`
}

export function createHarnessHeader({ getState, version = VERSION } = {}) {
  const label = `PHYSICAL SYSTEMS · Harness v${version}`
  return (_tui, theme) => ({
    render(width) {
      const state = getState()
      const availableWidth = Math.max(0, width)
      const wide = availableWidth >= 52
      const logo = wide ? LOGO : [label]
      // The extension supplies model selection, not proof of usable credentials.
      // Rendering must not authenticate, refresh tokens, or claim provider readiness.
      const provider = state.modelConfigured
        ? 'Model · selected · credentials checked when sending'
        : 'Model provider · choose one with /login'
      return [
        ...logo.map((line) => theme.fg('accent', fit(line, availableWidth))),
        ...(wide ? [theme.fg('muted', fit(label, availableWidth))] : []),
        theme.fg('muted', fit(physicalNodeLine(state), availableWidth)),
        theme.fg('muted', fit(provider, availableWidth)),
        '',
      ]
    },
    invalidate() {},
  })
}
