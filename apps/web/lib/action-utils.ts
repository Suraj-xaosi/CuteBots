import "server-only"

export const actionFailure = (action: string) => {
  console.error(`${action} failed`)
  return { ok: false, error: `${action} failed` }
}

export const isRecord = (value: unknown) =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const isText = (value: unknown) =>
  typeof value === "string"
