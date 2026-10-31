import { loadEnvConfig } from "@next/env"

let signalsRegistered = false

export async function registerNode() {
  const repositoryRoot = process.cwd().replace(/[\\/]+apps[\\/]+web$/, "")
  loadEnvConfig(repositoryRoot)
  if (signalsRegistered) return
  signalsRegistered = true

  let shuttingDown = false
  const shutdown = async () => {
    if (shuttingDown) return
    shuttingDown = true
    try {
      const { gracefullyStopRuns } = await import("./lib/startup")
      await gracefullyStopRuns()
      process.exit(0)
    } catch (error) {
      console.error("Graceful shutdown failed", error)
      process.exit(1)
    }
  }
  process.once("SIGINT", shutdown)
  process.once("SIGTERM", shutdown)

  try {
    const { recoverProjectSandboxes } = await import("./lib/startup")
    await recoverProjectSandboxes()
  } catch (error) {
    console.error("Unable to recover project sandboxes", error)
  }
}