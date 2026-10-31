// Server actions return { ok: true, data } | { ok: false, error }.
// TanStack only knows about failures when something throws, so this is the
// one place where a failed result becomes an Error. After this, isError,
// error, retry and onError all work as expected.
//
// If your action result type differs from this shape, adjust Failure here
// and nowhere else.

export class ActionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ActionError"
  }
}

type Failure = { ok: false; error: string }

export async function unwrap<T>(pending: Promise<{ ok: true; data: T } | Failure>): Promise<T> {
  const result = await pending
  if (!result.ok) throw new ActionError(result.error)
  return result.data
}

// For actions that return nothing useful on success (cancel, reply, save...).
export async function unwrapVoid(pending: Promise<{ ok: true } | Failure>): Promise<void> {
  const result = await pending
  if (!result.ok) throw new ActionError(result.error)
}