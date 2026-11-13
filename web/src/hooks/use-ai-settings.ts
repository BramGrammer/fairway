import { useCallback, useEffect, useState } from "react"

import { api } from "@/lib/api"
import type { AiPutBody, AiSettingsReply, AiSettingsView, AiTask, AiTestReply, ModelsReply, ModelTestReply } from "@/lib/ai-settings"
import type { Outcome } from "@/hooks/use-alert-settings"

/** Loads the model endpoint settings when mounted and replaces them with every view the server returns. */
export function useAiSettings() {
  const [view, setView] = useState<AiSettingsView | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const apply = useCallback((reply: AiSettingsReply, status: number): Outcome => {
    if (reply.ok) {
      const { ok: _ok, ...next } = reply
      void _ok
      setView(next)
      return { ok: true }
    }
    return { ok: false, error: reply.error ?? `The server answered ${status}.` }
  }, [])

  const load = useCallback(async () => {
    try {
      const { status, body } = await api<AiSettingsReply>("/api/settings/ai")
      const outcome = apply(body, status)
      setLoadError(outcome.ok ? null : outcome.error)
    } catch {
      setLoadError("Cannot reach the editor server.")
    }
  }, [apply])

  useEffect(() => {
    let stopped = false
    api<AiSettingsReply>("/api/settings/ai")
      .then(({ status, body }) => {
        if (stopped) return
        const outcome = apply(body, status)
        setLoadError(outcome.ok ? null : outcome.error)
      })
      .catch(() => {
        if (!stopped) setLoadError("Cannot reach the editor server.")
      })
    return () => {
      stopped = true
    }
  }, [apply])

  const save = async (body: AiPutBody): Promise<Outcome> => {
    try {
      const { status, body: reply } = await api<AiSettingsReply>("/api/settings/ai", body, { method: "PUT" })
      return apply(reply, status)
    } catch {
      return { ok: false, error: "Cannot reach the editor server." }
    }
  }

  return { view, loadError, reload: load, save }
}

/** Runs the connection test and keeps its outcome. */
export function useAiTest() {
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<AiTestReply | null>(null)

  const run = useCallback(async () => {
    setTesting(true)
    setResult(null)
    try {
      setResult((await api<AiTestReply>("/api/settings/ai/test", {})).body)
    } catch {
      setResult({ ok: false, error: "Cannot reach the editor server." })
    }
    setTesting(false)
  }, [])

  return { testing, result, run }
}

/** The endpoint's model list, loaded when mounted and again after `refresh`. `models` is null when there is no list to offer. */
export function useAiModels(refreshKey: unknown) {
  const [models, setModels] = useState<string[] | null>(null)

  useEffect(() => {
    let stopped = false
    api<ModelsReply>("/api/settings/ai/models")
      .then(({ body }) => !stopped && setModels(body.ok ? body.models : null))
      .catch(() => !stopped && setModels(null))
    return () => {
      stopped = true
    }
  }, [refreshKey])

  return { models }
}

/** Tests the model chosen for one task for tool calling and keeps the outcome. */
export function useModelTest(task: AiTask) {
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<ModelTestReply | null>(null)

  const run = useCallback(async () => {
    setTesting(true)
    setResult(null)
    try {
      setResult((await api<ModelTestReply>("/api/settings/ai/test-model", { task })).body)
    } catch {
      setResult({ ok: false, error: "Cannot reach the editor server." })
    }
    setTesting(false)
  }, [task])

  return { testing, result, run }
}
