import { useCallback, useEffect, useRef, useState } from "react"

import { api } from "@/lib/api"
import {
  ASK_AGAIN,
  fromStored,
  isOutdated,
  livePending,
  readTurnEvents,
  type AssistantMessage,
  type ConversationSummary,
  type ProposalStatus,
  type StoredMessage,
} from "@/lib/assistant"

const UNREACHABLE = "Cannot reach the editor server."
/** The Conversation the panel had open last, so it comes back after a reload. */
const LAST_KEY = "fairway.assistant.conversation"

function remembered(): string | null {
  try {
    return localStorage.getItem(LAST_KEY)
  } catch {
    return null
  }
}

function remember(id: string | null) {
  try {
    if (id === null) localStorage.removeItem(LAST_KEY)
    else localStorage.setItem(LAST_KEY, id)
  } catch {
    // Without storage the Conversation is simply not reopened.
  }
}

export type Past =
  | { state: "loading" }
  | { state: "error"; error: string }
  | { state: "ready"; items: ConversationSummary[] }

/**
 * The Conversation with the Assistant. The server keeps it: each turn sends the editor buffer as it is at that moment
 * and the Owner's message, and the answer streams into the last message. `stop` ends a turn, upstream too. The page
 * remembers which Conversation was open and reopens it, and can list, open and delete past ones.
 */
export function useAssistant(getText: () => string, editorText: string) {
  const [messages, setMessages] = useState<AssistantMessage[]>([])
  const [busy, setBusy] = useState(false)
  const [opening, setOpening] = useState(false)
  const [past, setPast] = useState<Past | null>(null)
  const controller = useRef<AbortController | null>(null)
  const nextId = useRef(1)
  const conversationId = useRef<string | null>(null)
  const restored = useRef(false)
  /** The same list as `messages`, readable inside an async turn. */
  const list = useRef<AssistantMessage[]>([])

  const commit = useCallback((next: AssistantMessage[]) => {
    list.current = next
    setMessages(next)
  }, [])
  const patchLast = useCallback(
    (change: (m: AssistantMessage) => AssistantMessage) =>
      commit(
        list.current.map((m, i) =>
          i === list.current.length - 1 ? change(m) : m
        )
      ),
    [commit]
  )
  const setConversation = useCallback((id: string | null) => {
    conversationId.current = id
    remember(id)
  }, [])

  /** Sends `message` after `history`, which is what is already in the Conversation. */
  const turn = useCallback(
    async (history: AssistantMessage[], message: string) => {
      // A Proposal that is pending is sent along, so the model builds on it; the difference stays against the editor.
      const pendingMessage = livePending(list.current)
      const pending =
        pendingMessage?.serverId !== undefined && pendingMessage.proposal
          ? {
              messageId: pendingMessage.serverId,
              text: pendingMessage.proposal.text,
            }
          : null
      const asked: AssistantMessage = {
        id: nextId.current++,
        role: "user",
        content: message,
      }
      const answer: AssistantMessage = {
        id: nextId.current++,
        role: "assistant",
        content: "",
      }
      commit([...history, asked, answer])
      const startedAt = performance.now()
      // The buffer this turn is made against, which a Proposal of it is compared with.
      const sentText = getText()
      const abort = new AbortController()
      controller.current = abort
      setBusy(true)
      try {
        const response = await fetch("/api/assistant/turn", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversationId: conversationId.current,
            text: sentText,
            message,
            pending,
          }),
          signal: abort.signal,
        })
        if (!response.ok || !response.body) {
          const body = (await response.json().catch(() => ({}))) as {
            error?: string
          }
          const text =
            response.status === 401
              ? "Your session has ended. Sign in again."
              : (body.error ?? `The server answered ${response.status}.`)
          if (response.status === 404) setConversation(null)
          patchLast((m) => ({ ...m, problem: { kind: "error", text } }))
          return
        }
        let finished = false
        for await (const event of readTurnEvents(response.body)) {
          if (event.type === "conversation") {
            setConversation(event.id)
            commit(
              list.current.map((m) =>
                m.id === asked.id
                  ? { ...m, serverId: event.userMessageId }
                  : m.id === answer.id
                    ? { ...m, serverId: event.answerMessageId }
                    : m
              )
            )
          } else if (event.type === "text")
            patchLast((m) => ({ ...m, content: m.content + event.delta }))
          else if (event.type === "usage")
            patchLast((m) => ({ ...m, usage: event.usage }))
          else if (event.type === "context")
            patchLast((m) => ({ ...m, context: event.parts }))
          else if (event.type === "step")
            patchLast((m) => ({
              ...m,
              steps: [...(m.steps ?? []), event.step],
            }))
          else if (event.type === "validating")
            patchLast((m) => ({ ...m, validating: event.attempt }))
          else if (event.type === "proposal") {
            const { text, valid, findings, attempts } = event
            commit(
              list.current.map((m) => {
                if (m.id === answer.id)
                  return {
                    ...m,
                    validating: undefined,
                    proposal: {
                      text,
                      baseText: sentText,
                      valid,
                      findings,
                      attempts,
                      status: "pending" as const,
                      live: true,
                    },
                  }
                return m.proposal?.status === "pending"
                  ? {
                      ...m,
                      proposal: { ...m.proposal, status: "replaced" as const },
                    }
                  : m
              })
            )
          } else if (event.type === "limit")
            patchLast((m) => ({
              ...m,
              problem: { kind: "limit", text: event.message },
            }))
          else if (event.type === "error")
            patchLast((m) => ({
              ...m,
              problem: { kind: "error", text: event.error },
            }))
          else finished = true
        }
        if (!finished)
          patchLast((m) =>
            m.problem
              ? m
              : {
                  ...m,
                  problem: {
                    kind: "error",
                    text: "The answer was interrupted before it finished.",
                  },
                }
          )
      } catch {
        if (abort.signal.aborted)
          patchLast((m) => ({
            ...m,
            problem: { kind: "stopped", text: "Stopped." },
          }))
        else
          patchLast((m) => ({
            ...m,
            problem: { kind: "error", text: UNREACHABLE },
          }))
      } finally {
        if (controller.current === abort) controller.current = null
        // The server keeps neither a failed answer nor its question, so a Conversation that began with it does not exist.
        if (
          history.length === 0 &&
          list.current[list.current.length - 1]?.problem?.kind === "error"
        )
          setConversation(null)
        const elapsedMs = Math.round(performance.now() - startedAt)
        commit(
          list.current.map((m) =>
            m.id === answer.id
              ? { ...m, validating: undefined, elapsedMs }
              : m.validating !== undefined
                ? { ...m, validating: undefined }
                : m
          )
        )
        setBusy(false)
      }
    },
    [getText, commit, patchLast, setConversation]
  )

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim()
      if (trimmed === "" || controller.current) return
      void turn(list.current, trimmed)
    },
    [turn]
  )

  /** Asks again after a failed answer: the failed one is dropped and the same question is sent. */
  const retry = useCallback(() => {
    if (controller.current) return
    const [asked, failed] = list.current.slice(-2)
    if (
      asked?.role !== "user" ||
      failed?.role !== "assistant" ||
      failed.problem?.kind !== "error"
    )
      return
    void turn(list.current.slice(0, -2), asked.content)
  }, [turn])

  /** Records what the Owner did with the Proposal of an answer, here and in the stored Conversation. The editor is changed by the caller. */
  const decide = useCallback(
    (id: number, status: Exclude<ProposalStatus, "pending">) => {
      const message = list.current.find((m) => m.id === id)
      if (!message?.proposal) return
      commit(
        list.current.map((m) =>
          m.id === id && m.proposal
            ? { ...m, proposal: { ...m.proposal, status } }
            : m
        )
      )
      if (
        message.serverId !== undefined &&
        conversationId.current !== null &&
        (status === "accepted" ||
          status === "rejected" ||
          status === "outdated")
      ) {
        void api(
          `/api/assistant/conversations/${conversationId.current}/messages/${message.serverId}/proposal`,
          { status },
          { method: "PUT" }
        ).catch(() => undefined)
      }
    },
    [commit]
  )

  /** Asks the Assistant to make an outdated Proposal again against the editor as it is now. */
  const askAgain = useCallback(() => send(ASK_AGAIN), [send])

  // Only one Proposal is pending, and it goes stale the moment the editor differs from what it was made against.
  useEffect(() => {
    const stale = list.current.find(
      (m) => m.proposal && isOutdated(m.proposal, editorText)
    )
    if (stale) decide(stale.id, "outdated")
  }, [editorText, messages, decide])

  const stop = useCallback(() => controller.current?.abort(), [])

  /** Starts a new Conversation. The old one stays in the list. */
  const reset = useCallback(() => {
    controller.current?.abort()
    setConversation(null)
    commit([])
  }, [commit, setConversation])

  /** Starts a new Conversation with this message, ending the one that is running if there is one. */
  const startWith = useCallback(
    async (text: string) => {
      if (controller.current) {
        controller.current.abort()
        // The stopped turn clears the controller when it ends; its leftovers must not land in the new Conversation.
        while (controller.current)
          await new Promise((resolve) => setTimeout(resolve, 20))
      }
      setConversation(null)
      commit([])
      void turn([], text.trim())
    },
    [commit, setConversation, turn]
  )

  const refresh = useCallback(async () => {
    setPast((current) =>
      current?.state === "ready" ? current : { state: "loading" }
    )
    try {
      const { status, body } = await api<{
        conversations?: ConversationSummary[]
        error?: string
      }>("/api/assistant/conversations")
      setPast(
        status === 200 && body.conversations
          ? { state: "ready", items: body.conversations }
          : {
              state: "error",
              error: body.error ?? `The server answered ${status}.`,
            }
      )
    } catch {
      setPast({ state: "error", error: UNREACHABLE })
    }
  }, [])

  /** Opens a stored Conversation. Resolves false when it could not be read. */
  const open = useCallback(
    async (id: string): Promise<boolean> => {
      controller.current?.abort()
      setOpening(true)
      try {
        const { status, body } = await api<{
          conversation?: { id: string; messages: StoredMessage[] }
        }>(`/api/assistant/conversations/${id}`)
        if (status !== 200 || !body.conversation) {
          if (status === 404 && conversationId.current === id)
            setConversation(null)
          if (status === 404) void refresh()
          return false
        }
        const loaded = fromStored(body.conversation.messages)
        nextId.current = loaded.reduce((max, m) => Math.max(max, m.id), 0) + 1
        setConversation(id)
        commit(loaded)
        return true
      } catch {
        return false
      } finally {
        setOpening(false)
      }
    },
    [commit, refresh, setConversation]
  )

  /** Reopens the Conversation that was open last. Once per page; later calls do nothing. */
  const restore = useCallback(() => {
    if (restored.current) return
    restored.current = true
    const id = remembered()
    if (id !== null && list.current.length === 0) void open(id)
  }, [open])

  /** Deletes a stored Conversation; the open one is closed with it. */
  const remove = useCallback(
    async (id: string): Promise<boolean> => {
      try {
        const { status } = await api(
          `/api/assistant/conversations/${id}`,
          undefined,
          { method: "DELETE" }
        )
        if (status !== 200 && status !== 404) return false
      } catch {
        return false
      }
      if (conversationId.current === id) reset()
      setPast((current) =>
        current?.state === "ready"
          ? { state: "ready", items: current.items.filter((c) => c.id !== id) }
          : current
      )
      return true
    },
    [reset]
  )

  return {
    messages,
    busy,
    opening,
    past,
    send,
    startWith,
    askAgain,
    retry,
    stop,
    reset,
    decide,
    open,
    restore,
    refresh,
    remove,
    hasConversation: messages.length > 0,
  }
}

export type Assistant = ReturnType<typeof useAssistant>
