"use client"

import { useRef, type RefObject } from "react"
import { Send } from "lucide-react"
import { Button } from "@workspace/ui/components/button"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupTextarea,
} from "@workspace/ui/components/input-group"
import { useSendMessage } from "@/hooks/use-conversation"

// Same behaviour as before: Enter sends, Shift+Enter is a new line, the input
// clears and refocuses on success, and the error shows inside the box.
// key={conversationId}: switching conversation gives a fresh composer (empty
// input, no stale error).
export function Composer({ conversationId }: { conversationId: string | null }) {
  if (!conversationId) return <ComposerView disabled />
  return <LiveComposer key={conversationId} conversationId={conversationId} />
}

function LiveComposer({ conversationId }: { conversationId: string }) {
  const send = useSendMessage(conversationId)
  const input = useRef<HTMLTextAreaElement>(null)

  const submit = () => {
    const content = input.current?.value.trim()
    if (!content || send.isPending) return

    send.mutate(content, {
      onSuccess: () => {
        if (input.current) input.current.value = ""
        input.current?.focus()
      },
    })
  }

  return (
    <ComposerView
      inputRef={input}
      pending={send.isPending}
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
  error = null,
  onSubmit,
}: {
  inputRef?: RefObject<HTMLTextAreaElement | null>
  disabled?: boolean
  pending?: boolean
  error?: string | null
  onSubmit?: () => void
}) {
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
          rows={3}
          maxLength={50_000}
          disabled={disabled}
          placeholder="Ask for a change, an explanation, or a review…"
          className="max-h-[40dvh] resize-y"
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault()
              onSubmit?.()
            }
          }}
        />
        <InputGroupAddon align="block-end">
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            Enter to send · Shift+Enter for a new line
          </span>
          <Button size="sm" className="ml-auto shrink-0" disabled={disabled || pending} onClick={onSubmit}>
            <Send />
            {pending ? "Working…" : "Send"}
          </Button>
        </InputGroupAddon>
      </InputGroup>
    </div>
  )
}