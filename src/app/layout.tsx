import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import Link from "next/link";
import { Activity } from "lucide-react";
import { Navigation } from "@/components/Navigation";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Polymarket Up/Down",
  description: "Up/Down signals, Jev analysis and trading-bot control for Polymarket",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link href="https://fonts.googleapis.com/css2?family=Vazirmatn:wght@400;500;600;700&display=swap" rel="stylesheet" />
      </head>
      <body className={`${inter.className} min-h-screen flex flex-col`}>
        <header className="sticky top-0 z-50 border-b border-white/[0.07] bg-[#121316]">
          <div className="max-w-[1200px] mx-auto px-5 h-14 flex items-center justify-between gap-6">
            <Link href="/" className="flex items-center gap-2 shrink-0">
              <Activity className="w-4 h-4 text-[#9fb4ee]" />
              <span className="text-[15px] font-medium tracking-tight text-[#e8e8e4]">Polymarket Up/Down</span>
            </Link>
            <Navigation />
          </div>
        </header>
        <main className="flex-1 w-full max-w-[1200px] mx-auto px-5 py-8">
          {children}
        </main>
        <footer className="border-t border-white/[0.06] py-4">
          <p className="max-w-[1200px] mx-auto px-5 text-[11px] text-[#73757c]">
            Data: Polymarket CLOB · gamma · Binance/OKX spot · OpenRouter models — for research use
          </p>
        </footer>
      </body>
    </html>
  );
}
