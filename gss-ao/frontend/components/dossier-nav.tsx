"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { FileText, ListChecks, PenLine, Download } from "lucide-react";
import { cn } from "@/lib/utils";

/** Onglets d'étapes au sein d'un dossier (écrans 3 → 6). */
export function DossierNav({ id }: { id: string }) {
  const pathname = usePathname();
  const base = `/dossiers/${id}`;
  const steps = [
    { href: base, label: "Synthèse", icon: FileText },
    { href: `${base}/conformite`, label: "Conformité", icon: ListChecks },
    { href: `${base}/memoire`, label: "Mémoire technique", icon: PenLine },
    { href: `${base}/export`, label: "Export", icon: Download },
  ];
  return (
    <nav className="flex items-center gap-1 border-b border-border bg-card px-4">
      {steps.map((s, i) => {
        const active = pathname === s.href;
        const Icon = s.icon;
        return (
          <Link
            key={s.href}
            href={s.href}
            className={cn(
              "flex items-center gap-2 border-b-2 px-3 py-2.5 text-sm font-medium transition-colors",
              active
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            <span
              className={cn(
                "flex h-5 w-5 items-center justify-center rounded-full text-[11px]",
                active ? "bg-primary text-primary-foreground" : "bg-secondary",
              )}
            >
              {i + 1}
            </span>
            <Icon className="h-4 w-4" />
            {s.label}
          </Link>
        );
      })}
    </nav>
  );
}
