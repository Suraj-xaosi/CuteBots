import 'server-only'

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { prisma } from '@workspace/db'
import { parseJsonRecord } from './safe'

// Lets callers pass either the global client or a transaction client (tx).
type Db = Pick<typeof prisma, 'setting'>

const credentialsKey = (projectId: string) => `project:${projectId}:credentials`

function encryptionKey() {
  const key = process.env.CREDENTIALS_ENCRYPTION_KEY
  const decoded = key ? Buffer.from(key, 'base64') : Buffer.alloc(0)

  if (!key || decoded.length !== 32) {
    throw new Error('Configure CREDENTIALS_ENCRYPTION_KEY as a 32-byte base key')
  }

  return decoded
}

export function encrypt(text: string) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv)
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])

  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64')
}

export function decrypt(text: string) {
  const data = Buffer.from(text, 'base64')
  if (data.length < 28) throw new Error('Stored credentials are invalid')

  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), data.subarray(0, 12))
  decipher.setAuthTag(data.subarray(12, 28))

  return Buffer.concat([
    decipher.update(data.subarray(28)),
    decipher.final(),
  ]).toString('utf-8')
}

export async function readProjectCredentials(projectId: string, db: Db = prisma) {
  const setting = await db.setting.findUnique({ where: { key: credentialsKey(projectId) } })
  if (!setting) return null

  try {
    const clean = parseJsonRecord(decrypt(setting.value))
    if (!clean) throw new Error('Stored project credentials are invalid')

    return Object.fromEntries(
      Object.entries(clean).flatMap(([entryKey, value]) => {
        if (typeof value !== 'string') return []
        const cleaned = value.trim()
        return cleaned ? [[entryKey, cleaned]] : []
      })
    ) as Record<string, string>
  } catch (error) {
    console.error('Failed to load project credentials', { projectId, error })
    return null
  }
}

// CHANGED (Lesson 3): this now REPLACES the stored credentials with exactly
// what you pass in. The old version could only add/overwrite, so a value could
// never be removed. Callers do the merging (see saveProjectCredentials).
// An empty object deletes the row.
export async function writeProjectCredentials(
  projectId: string,
  credentials: Record<string, string>,
  db: Db = prisma
) {
  const cleaned: Record<string, string> = {}
  for (const [name, value] of Object.entries(credentials)) {
    const trimmed = value?.trim()
    if (trimmed) cleaned[name] = trimmed
  }

  const key = credentialsKey(projectId)
  if (Object.keys(cleaned).length === 0) {
    await db.setting.deleteMany({ where: { key } })
    return cleaned
  }

  const value = encrypt(JSON.stringify(cleaned))
  await db.setting.upsert({
    where: { key },
    create: { key, value, is_secret: true },
    update: { value, is_secret: true },
  })

  return cleaned
}

// NEW: used by the project-delete lesson so no encrypted secrets are left behind.
export async function deleteProjectCredentials(projectId: string, db: Db = prisma) {
  await db.setting.deleteMany({ where: { key: credentialsKey(projectId) } })
}

// NEW: one definition of "the agent can actually call an LLM".
export function hasUsableCredentials(credentials: Record<string, string> | null) {
  return Boolean(credentials?.provider && (credentials.apiKey || credentials.provider === 'ollama'))
}

// NEW: anthropic ignores baseUrl, so never keep a stale one around.
export function normalizeCredentials(credentials: Record<string, string>) {
  const next = { ...credentials }
  if (next.provider === 'anthropic') delete next.baseUrl
  return next
}

const SECRET_FIELDS = ['apiKey', 'tavilyApiKey', 'repositoryToken'] as const
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', 'host.docker.internal'])

// NEW: returns a human-readable problem, or null if the values are acceptable.
// Why it matters: the API key is sent to baseUrl, so baseUrl must be trustworthy.
export function credentialsProblem(credentials: Record<string, string>): string | null {
  for (const field of SECRET_FIELDS) {
    const value = credentials[field]
    if (value && /\s/.test(value)) return 'Keys and tokens cannot contain spaces or line breaks'
  }

  const baseUrl = credentials.baseUrl
  if (baseUrl) {
    let url: URL
    try {
      url = new URL(baseUrl)
    } catch {
      return 'Base URL is not a valid URL'
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return 'Base URL must start with http:// or https://'
    }
    if (url.username || url.password) return 'Base URL cannot contain a username or password'
    if (url.protocol === 'http:' && !LOCAL_HOSTS.has(url.hostname)) {
      return 'Use https:// for remote base URLs (http:// is only allowed for localhost)'
    }
  }

  return null
}