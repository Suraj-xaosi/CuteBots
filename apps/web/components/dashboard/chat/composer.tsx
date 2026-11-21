"use client"

import { useRef, type RefObject } from "react"
import { Send } from "lucide-react"
import { Button } from "@workspace/ui/components/button"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupTextarea,
} from "@workspace/ui/components/input-group"
import { blocksComposer } from "@/hooks/run-phase"
import { useRunPhase, useSendMessage } from "@/hooks/use-conversation"

// Same behaviour as before: Enter sends, Shift+Enter is a new line, the input
// clears and refocuses on success, and the error shows inside the box.
// key={conversationId}: switching conversation gives a fresh composer (empty
// input, no stale error).
//
// CHANGED: the composer now follows the run phase (see hooks/run-phase.ts):
//   - the agent is starting or working -> the box is CLOSED. A new message would
//     be refused by the server anyway. The Stop button is in the strip above.
//   - the agent waits for a reply      -> the box is open and says "Reply".
//   - everything else                  -> normal.
export function Composer({ conversationId }: { conversationId: string | null }) {
  if (!conversationId) return <ComposerView disabled />
  return <LiveComposer key={conversationId} conversationId={conversationId} />
}

function LiveComposer({ conversationId }: { conversationId: string }) {
  const send = useSendMessage(conversationId)
  const { phase } = useRunPhase(conversationId)
  const blocked = blocksComposer(phase)
  const input = useRef<HTMLTextAreaElement>(null)

  const submit = () => {
    const content = input.current?.value.trim()
    if (!content || send.isPending || blocked) return

    send.mutate(content, {
      onSuccess: () => {
        if (input.current) {
          input.current.value = ""
          input.current.style.height = "auto"
        }
        input.current?.focus()
      },
    })
  }

  return (
    <ComposerView
      inputRef={input}
      pending={send.isPending}
      blocked={blocked}
      replying={phase === "waiting"}
      error={send.error?.message ?? null}
      onSubmit={submit}
    />
  )
}

// shrink-0: the composer never gets squeezed. max-h on the textarea: however
// far the user drags the resize grip, it can never push the messages out.
function ComposerView({
  inputRef,
  disabled = false,
  pending = false,
  blocked = false,
  replying = false,
  error = null,
  onSubmit,
}: {
  inputRef?: RefObject<HTMLTextAreaElement | null>
  disabled?: boolean
  pending?: boolean
  // The agent owns the project: typing is closed.
  blocked?: boolean
  // The agent asked a question: what is typed is a reply.
  replying?: boolean
  error?: string | null
  onSubmit?: () => void
}) {
  const placeholder = replying
    ? "Reply to the agent\u2026"
    : blocked
      ? "The agent is working\u2026"
      : "Ask for a change, an explanation, or a review\u2026"

  return (
    <div className="shrink-0 px-3 pb-3 pt-1">
      <InputGroup className="mx-auto max-w-3xl">
        {error ? (
          <InputGroupAddon align="block-start">
            <span role="alert" className="text-sm text-destructive">
              {error}
            </span>
          </InputGroupAddon>
        ) : null}
        <InputGroupTextarea
          ref={inputRef}
          rows={1}
          maxLength={50_000}
          disabled={disabled || blocked}
          placeholder={placeholder}
          className="min-h-0 max-h-[40dvh] resize-none overflow-hidden"
          onInput={(event) => {
            const element = event.currentTarget
            element.style.height = "auto"
            element.style.height = `${Math.min(element.scrollHeight, 160)}px`
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault()
              onSubmit?.()
            }
          }}
        />
        <InputGroupAddon align="block-end">
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            {blocked ? "Stop the agent to type a new message" : "Enter to send · Shift+Enter for a new line"}
          </span>
          <Button
            size="sm"
            className="ml-auto shrink-0"
            disabled={disabled || blocked || pending}
            onClick={onSubmit}
          >
            <Send />
            {pending ? "Working\u2026" : replying ? "Reply" : "Send"}
          </Button>
        </InputGroupAddon>
      </InputGroup>
    </div>
  )
}