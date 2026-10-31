export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation-node")
    const { registerNode } = await import("./instrumentation-node")
    await registerNode()
  }
}