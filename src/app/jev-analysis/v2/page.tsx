import type { Metadata } from "next";
import { Public_Sans } from "next/font/google";
import { StrategyLab } from "@/components/jev-lab/StrategyLab";
import "./lab.css";

const publicSans = Public_Sans({ subsets: ["latin"], variable: "--lab-latin", display: "swap" });

export const metadata: Metadata = {
  title: "JEV Strategy Lab · v2",
  description: "آزمایشگاه استراتژی JEV؛ بک‌تست، مقایسه و بهینه‌سازی روی تاریخچهٔ واقعی بازار",
};

export default function JevAnalysisV2() {
  return <div className={publicSans.variable}><StrategyLab /></div>;
}
