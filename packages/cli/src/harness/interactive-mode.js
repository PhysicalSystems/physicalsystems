const OFFLINE_TOOL_WARNING = /Offline mode enabled, skipping download/

/**
 * Wrap Pi's interactive mode so the public Harness does not show upstream
 * changelog notes, managed-tool download warnings, or extension inventory.
 */
export function createTinyEdgeInteractiveMode(InteractiveMode) {
  return class TinyEdgeInteractiveMode extends InteractiveMode {
    getChangelogForDisplay() {
      return undefined
    }

    handleChangelogCommand() {
      this.showStatus('TinyEdge product updates are documented at https://tinyedge.ai/docs')
    }

    showManagedToolStatus(status) {
      if (status?.type === 'warning' && OFFLINE_TOOL_WARNING.test(String(status.message || ''))) {
        return
      }
      return super.showManagedToolStatus(status)
    }

    showLoadedResources(options) {
      return super.showLoadedResources({ ...options, extensions: [] })
    }
  }
}

export function createHarnessMode(sdk, runtime, options) {
  const Mode = createTinyEdgeInteractiveMode(sdk.InteractiveMode)
  return new Mode(runtime, options)
}
