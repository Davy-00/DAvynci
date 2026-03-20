import { getSnapshot } from "@/lib/runtime-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = () => {
        const payload = JSON.stringify(getSnapshot());
        controller.enqueue(encoder.encode(`event: snapshot\ndata: ${payload}\n\n`));
      };

      send();
      const intervalId = setInterval(send, 1000);

      return () => {
        clearInterval(intervalId);
      };
    },
    cancel() {
      return;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
