"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function Navigation() {
  const pathname = usePathname();

  const links = [
    { href: "/updown", label: "Up/Down" },
    { href: "/jev-analysis", label: "Jev Analysis" },
    { href: "/cloud-analysis", label: "Cloud Analysis" },
    { href: "/alerts", label: "Alerts" },
    { href: "/control", label: "Control" },
  ];

  return (
    <nav className="flex items-center gap-0.5 overflow-x-auto">
      {links.map((link) => {
        const isActive = pathname === link.href || (link.href !== "/" && pathname.startsWith(link.href));
        return (
          <Link
            key={link.href}
            href={link.href}
            className={`px-2.5 py-1 rounded-md text-[13px] whitespace-nowrap transition-colors ${
              isActive
                ? "text-[#e8e8e4] bg-white/[0.08] font-medium"
                : "text-[#9a9ca3] hover:text-[#e8e8e4] hover:bg-white/[0.05]"
            }`}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
