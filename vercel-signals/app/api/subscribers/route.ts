import { kv } from "@vercel/kv";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EMAIL_KEY = "bot:alert_email";

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export async function GET() {
  try {
    const email = (await kv.get<string>(EMAIL_KEY)) || "";
    return NextResponse.json({ email });
  } catch {
    return NextResponse.json({ email: "" });
  }
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as { email?: string };
  const email = String(body?.email || "").trim().toLowerCase();

  if (!isValidEmail(email)) {
    return NextResponse.json({ ok: false, error: "invalid_email" }, { status: 400 });
  }

  try {
    await kv.set(EMAIL_KEY, email);
    return NextResponse.json({ ok: true, email });
  } catch {
    return NextResponse.json({ ok: false, error: "kv_unavailable" }, { status: 503 });
  }
}
