"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const links = [
  { href: "/", label: "Pipeline" },
  { href: "/new", label: "Start research" },
  { href: "/settings", label: "Settings" },
];

export function Shell({ name, email, signOut, children }: { name: string; email: string; signOut: () => Promise<void>; children: React.ReactNode }) {
  const path = usePathname();
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
        <div className="proto">Prototype: sample data only. Nothing is sent to Jira or GitHub.</div>
        {children}
      </main>
    </div>
  );
}
