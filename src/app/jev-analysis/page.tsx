import type { Metadata } from "next";
import { Public_Sans } from "next/font/google";
import { CurveWorkbench } from "@/components/jev-curves/CurveWorkbench";
import "./curves.css";

const publicSans = Public_Sans({ subsets: ["latin"], variable: "--curves-latin", display: "swap" });

export const metadata: Metadata = {
  title: "JEV Curve Workbench · تحلیل منحنی‌ها",
  description: "تحلیل هم‌زمان منحنی مدل‌ها، قیمت بازار، ارزش منصفانه و بهینه‌سازی شرط‌های سیگنال JEV",
};

export default function JevAnalysisPage() {
  return <div className={publicSans.variable}><CurveWorkbench /></div>;
}
