import { kv } from "@vercel/kv";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const snapshot = await kv.get("bot:latest_snapshot");
  return NextResponse.json(snapshot ?? {
    timestamp_utc: new Date().toISOString(),
    halted: false,
    halt_reason: "",
    signals: [],
  });
}
