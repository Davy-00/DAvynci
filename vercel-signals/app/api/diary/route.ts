import { NextRequest, NextResponse } from "next/server";
import { getDiary, setDiaryEntry } from "@/lib/runtime-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ entries: getDiary() });
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    trade_id?: string;
    setup?: string;
    emotion?: string;
    mistakes?: string;
    lesson?: string;
    rating?: number;
  };

  const tradeId = String(body.trade_id || "").trim();
  if (!tradeId) {
    return NextResponse.json({ ok: false, error: "missing_trade_id" }, { status: 400 });
  }

  const rating = Number(body.rating ?? 0);
  const saved = setDiaryEntry(tradeId, {
    setup: String(body.setup || "").trim(),
    emotion: String(body.emotion || "").trim(),
    mistakes: String(body.mistakes || "").trim(),
    lesson: String(body.lesson || "").trim(),
    rating: Number.isFinite(rating) ? Math.min(5, Math.max(0, rating)) : 0,
  });

  return NextResponse.json({ ok: true, entry: saved });
}
