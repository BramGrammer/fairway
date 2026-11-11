/** Debounced, one-at-a-time validation of text that keeps changing. No React, so it can be tested with fake timers. */

export interface LiveCheckOptions<R> {
  /** Quiet time after the last edit before a check starts. */
  delay: number
  /** Runs one check. Resolve null (or reject) when there is no usable answer. */
  run: (text: string) => Promise<R | null>
  /** Called with the answer for the current text, or null when the check failed. Never for stale text. */
  onResult: (result: R | null) => void
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export interface LiveCheck {
  /** The text changed: restart the quiet period. */
  input: (text: string) => void
  /** Stop for good: drop the timer and ignore any answer still on its way. */
  dispose: () => void
}

export function createLiveCheck<R>(options: LiveCheckOptions<R>): LiveCheck {
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  let latest: string | null = null
  let timer: unknown = null
  let inFlight = false
  /** A quiet period ended while a request was in flight: exactly one more check follows it. */
  let again = false
  let disposed = false

  function start() {
    if (latest === null) return
    const sent = latest
    inFlight = true
    options.run(sent).then(
      (result) => finish(sent, result),
      () => finish(sent, null)
    )
  }

  function finish(sent: string, result: R | null) {
    inFlight = false
    if (disposed) return
    if (sent === latest) {
      again = false
      options.onResult(result)
    } else {
      // A newer edit whose own quiet period is still running starts its check when that period ends.
      const wasWaiting = again && timer === null
      again = false
      if (wasWaiting) start()
    }
  }

  function fire() {
    timer = null
    if (inFlight) again = true
    else start()
  }

  return {
    input(text) {
      if (disposed) return
      latest = text
      if (timer !== null) clearTimer(timer)
      timer = setTimer(fire, options.delay)
    },
    dispose() {
      disposed = true
      if (timer !== null) clearTimer(timer)
      timer = null
    },
  }
}
