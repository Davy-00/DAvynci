import { getSnapshot } from "@/lib/runtime-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const encoder = new TextEncoder();
  let fastTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let lastPayload = "";

      const send = () => {
        const payload = JSON.stringify(getSnapshot());
        if (payload === lastPayload) return;
        lastPayload = payload;
        controller.enqueue(encoder.encode(`event: snapshot\ndata: ${payload}\n\n`));
      };

      send();
      fastTimer = setInterval(send, 300);
      heartbeatTimer = setInterval(() => {
        controller.enqueue(encoder.encode(`: heartbeat ${Date.now()}\n\n`));
      }, 15000);
    },
    cancel() {
      if (fastTimer) clearInterval(fastTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      return;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store, no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
