"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { useStore } from "@/components/Store";
import { errorHelp, useFetchList } from "@/lib/useFetchList";
import { githubRepos } from "@/lib/mock";

type Repo = { fullName: string; private: boolean };
const sampleRepos: Repo[] = githubRepos.map((fullName) => ({ fullName, private: false }));

export function RepoPicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const { live, githubInfo } = useStore();
  const remote = useFetchList<Repo>(live.github ? "/api/github/repos" : null);
  const all = live.github ? remote.items : sampleRepos;
  const shown = useMemo(() => all.filter((r) => r.fullName.toLowerCase().includes(q.toLowerCase())), [all, q]);
  const toggle = (r: string) => onChange(value.includes(r) ? value.filter((x) => x !== r) : [...value, r]);

  return (
    <div className="repopicker">
      <button type="button" className="btn ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
        {value.length === 0 ? "Choose repos" : `${value.length} selected · change`}
      </button>
      {value.length > 0 && (
        <div className="chips">
          {value.map((r) => (
            <span className="chip" key={r}>
              {r}
              <button type="button" aria-label={`Remove ${r}`} onClick={() => toggle(r)}>×</button>
            </span>
          ))}
        </div>
      )}
      {open && (
        <div className="picker" role="dialog" aria-label="Choose repos">
          <input autoFocus placeholder={`Search repos (${githubInfo.label})`} value={q} onChange={(e) => setQ(e.target.value)} />
          <ul>
            {live.github && remote.loading && <li className="none">Loading your repos…</li>}
            {remote.error && <li className="none">{errorHelp(remote.error, "GitHub")} <Link href="/settings">Settings</Link></li>}
            {!remote.loading && !remote.error && all.length === 0 && (
              <li className="none">{githubInfo.mode === "oauth" ? "No repos found for this GitHub account." : "No repos found. Install the GitHub App on the organisations or repos you want to use, then reload."}</li>
            )}
            {!remote.loading && !remote.error && all.length > 0 && shown.length === 0 && <li className="none">No repos match “{q}”.</li>}
            {shown.map((r) => (
              <li key={r.fullName}>
                <label className="check">
                  <input type="checkbox" checked={value.includes(r.fullName)} onChange={() => toggle(r.fullName)} />
                  <span className="mono">{r.fullName}</span>
                  {r.private && <span className="muted"> private</span>}
                </label>
              </li>
            ))}
          </ul>
          <div className="picker-foot">
            <span className="muted">{value.length} selected</span>
            <button type="button" className="btn primary" onClick={() => setOpen(false)}>Done</button>
          </div>
        </div>
      )}
    </div>
  );
}
