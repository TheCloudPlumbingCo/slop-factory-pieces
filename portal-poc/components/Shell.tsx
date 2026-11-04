"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useStore } from "@/components/Store";

const links = [
  { href: "/", label: "Attention" },
  { href: "/new", label: "Start RPI" },
  { href: "/settings", label: "Settings" },
];

export function Shell({ name, email, signOut, children }: { name: string; email: string; signOut: () => Promise<void>; children: React.ReactNode }) {
  const path = usePathname();
  const { live, github, ready } = useStore();
  const githubLive = ready && live.github && github.connected;
  return (
    <div className="shell">
      <aside className="rail">
        <div className="brand">Slop portal<small>research, plan, implement</small></div>
        <nav className="nav" aria-label="Main">
          {links.map((l) => (
            <Link key={l.href} href={l.href} aria-current={path === l.href ? "page" : undefined}>{l.label}</Link>
          ))}
        </nav>
        <div className="who">
          <strong>{name}</strong>
          {email}
          <form action={signOut}><button type="submit">Sign out</button></form>
        </div>
      </aside>
      <main className="main">
        <div className="proto">
          {githubLive
            ? "Attention is live from GitHub. Start RPI is not wired yet: it only simulates a run and sends nothing to Jira."
            : "Sample data. Connect GitHub in settings to see your real review requests."}
        </div>
        {children}
      </main>
    </div>
  );
}
