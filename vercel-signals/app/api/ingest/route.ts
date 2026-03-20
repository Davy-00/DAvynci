import { kv } from "@vercel/kv";
import { Resend } from "resend";
import { NextRequest, NextResponse } from "next/server";
import { actionableSignals, signalDigest, SignalSnapshot, signalLabel } from "@/lib/signals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function unauthorized() {
  return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
}

export async function POST(req: NextRequest) {
  const expected = (process.env.SIGNALS_WEBHOOK_TOKEN || "").trim();
  const auth = (req.headers.get("authorization") || "").trim();
  if (!expected || auth !== `Bearer ${expected}`) {
    return unauthorized();
  }

  const body = (await req.json()) as SignalSnapshot;
  if (!body || !Array.isArray(body.signals)) {
    return NextResponse.json({ ok: false, error: "invalid_payload" }, { status: 400 });
  }

  try {
    await kv.set("bot:latest_snapshot", body);
  } catch {
    // KV may not be configured yet; continue to email flow.
  }

  const active = actionableSignals(body);
  const digest = signalDigest(active);
  let lastDigest = "";
  try {
    lastDigest = (await kv.get<string>("bot:last_email_digest")) || "";
  } catch {
    lastDigest = "";
  }

  if (active.length > 0 && digest !== lastDigest) {
    const resendApiKey = process.env.RESEND_API_KEY || "";
    let to = process.env.SIGNAL_EMAIL_TO || "";
    try {
      to = (await kv.get<string>("bot:alert_email")) || to;
    } catch {
      // Keep env fallback if KV unavailable.
    }
    const from = process.env.SIGNAL_EMAIL_FROM || "bebisday@gmail.com";

    if (resendApiKey && to) {
      const resend = new Resend(resendApiKey);
      const rows = active
        .map(
          (s) =>
            `<tr><td>${s.symbol}</td><td>${signalLabel(s)}</td><td>${s.lot ?? ""}</td><td>${s.sl ?? ""}</td><td>${s.tp ?? ""}</td><td>${(s.score ?? 0).toFixed(2)}</td></tr>`
        )
        .join("");

      await resend.emails.send({
        from,
        to,
        subject: `DAvynci Signals: ${active.length} Active Call(s)`,
        html: `<h2>Active Trade Calls</h2><p>Time: ${body.timestamp_utc}</p><table border='1' cellpadding='6' cellspacing='0'><thead><tr><th>Pair</th><th>Signal</th><th>Lot Size</th><th>SL</th><th>TP</th><th>Score</th></tr></thead><tbody>${rows}</tbody></table>`,
      });
      try {
        await kv.set("bot:last_email_digest", digest);
      } catch {
        // Ignore KV write failures to avoid dropping successful email sends.
      }
    }
  }

  return NextResponse.json({ ok: true, active_signals: active.length });
}
