import { prisma } from "@workspace/db";
import { isTerminalAgentRunStatus } from "@workspace/types";
import { events } from "@/lib/agent-runtime"
import { parseLastEventId } from "@/lib/run-event-broker";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ runId: string }> }) {
    const { runId } = await params;
    const run = await prisma.agentRun.findUnique({ where: { id: runId }, select: { id: true, status: true } });
    if (!run) return new Response("Run not found", { status: 404 });

    const cursor = parseLastEventId(request.headers.get("last-event-id") ?? new URL(request.url).searchParams.get("after") ?? undefined);
    if (!cursor.ok) return new Response(cursor.error, { status: 400 });

    // Finished run and this client already has everything: answer 204.
    // 204 is the one status that tells the browser's EventSource to STOP reconnecting.
    // (Closing the stream normally makes it reconnect every few seconds, forever.)
    if (isTerminalAgentRunStatus(run.status)) {
        const remaining = await prisma.agentLog.count({ where: { run_id: runId, id: { gt: cursor.data } } });
        if (remaining === 0) return new Response(null, { status: 204 });
    }

    const encoder = new TextEncoder();
    let closed = false;
    let terminalSeen = isTerminalAgentRunStatus(run.status);
    let caughtUp = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let statusCheck: ReturnType<typeof setInterval> | undefined;
    let unsubscribe = () => {};
    let closeStream = () => {};

    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            const enqueue = (chunk: string) => {
                if (!closed) controller.enqueue(encoder.encode(chunk));
            };

            const close = () => {
                if (closed) return;
                closed = true;

                if (heartbeat) clearInterval(heartbeat);
                if (statusCheck) clearInterval(statusCheck);

                request.signal.removeEventListener("abort", close);
                unsubscribe();
                try {
                    controller.close();
                } catch {
                    // already closed by the client
                }
            };
            closeStream = close;

            // Close only when the run is finished AND every saved + live event has been
            // sent. The old code closed on "finished" alone, so a slow replay or the final
            // log line (often the failure reason) could be cut off.
            const closeWhenDone = () => {
                if (terminalSeen && caughtUp) close();
            };

            unsubscribe = events.subscribe(
                runId,
                (event) => enqueue(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`),
                cursor.data,
                (message) => {
                    enqueue(`event: stream_error\ndata: ${JSON.stringify({ error: message })}\n\n`);
                    close();
                },
                () => {
                    caughtUp = true;
                    closeWhenDone();
                }
            );

            heartbeat = setInterval(() => enqueue(": keep-alive\n\n"), 15_000);
            statusCheck = setInterval(async () => {
                try {
                    const current = await prisma.agentRun.findUnique({
                        where: { id: runId },
                        select: { status: true },
                    });
                    if (!current || isTerminalAgentRunStatus(current.status)) {
                        terminalSeen = true;
                        closeWhenDone();
                    }
                } catch (error) {
                    console.error("Unable to check run status for event stream", error);
                    close();
                }
            }, 1_000);

            if (request.signal.aborted) close();
            else request.signal.addEventListener("abort", close, { once: true });
        },

        cancel() {
            closed = true;
            if (heartbeat) clearInterval(heartbeat);
            if (statusCheck) clearInterval(statusCheck);

            request.signal.removeEventListener("abort", closeStream);
            unsubscribe();
        },
    });

    return new Response(stream, {
        headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
        },
    });
}