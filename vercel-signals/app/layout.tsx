import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "DAvynci Signals",
  description: "Live buy/sell signals with TP and SL",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
