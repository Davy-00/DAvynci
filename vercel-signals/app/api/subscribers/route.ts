import { NextRequest, NextResponse } from "next/server";
import { getSubscriberEmail, setSubscriberEmail } from "@/lib/runtime-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export async function GET() {
  return NextResponse.json({ email: getSubscriberEmail() || process.env.SIGNAL_EMAIL_TO || "" });
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as { email?: string };
  const email = String(body?.email || "").trim().toLowerCase();

  if (!isValidEmail(email)) {
    return NextResponse.json({ ok: false, error: "invalid_email" }, { status: 400 });
  }

  setSubscriberEmail(email);
  return NextResponse.json({ ok: true, email });
}
