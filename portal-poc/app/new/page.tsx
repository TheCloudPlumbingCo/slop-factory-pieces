"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { useStore } from "@/components/Store";
import { errorHelp, useFetchList } from "@/lib/useFetchList";
import { jiraIssues } from "@/lib/mock";

type Issue = { key: string; title: string };

export default function StartRpi() {
  const { jira, live, startRpi, ready } = useStore();
  const router = useRouter();
  const [open, setOpen] = useState<"task" | null>("task");
  const [q, setQ] = useState("");
  const [issueKey, setIssueKey] = useState<string | null>(null);

  const remote = useFetchList<Issue>(live.jira && jira.connected ? `/api/jira/issues?q=${encodeURIComponent(q)}` : null, 300);
  const sample = useMemo(
    () => jiraIssues.filter((i) => (i.key + " " + i.title).toLowerCase().includes(q.toLowerCase())),
    [q],
  );
  const matches: Issue[] = live.jira ? remote.items : sample;
  // Remember the chosen issue itself: live search results change as the query changes.
  const [chosen, setChosen] = useState<Issue | null>(null);
  const issue = chosen && chosen.key === issueKey ? chosen : null;

  if (ready && !jira.connected) {
    return (
      <>
        <h1>Connect Jira first</h1>
        <p className="muted">The portal lists the Jira issues you can see, so it needs your Jira account.</p>
        <p><Link className="btn primary" href="/settings" style={{ textDecoration: "none" }}>Open settings</Link></p>
      </>
    );
  }

  const go = () => {
    if (!issue) return;
    startRpi(issue.key, issue.title);
    router.push("/");
  };

  return (
    <>
      <h1>Start RPI</h1>
      <p className="muted">RPI is research, then plan, then implement. Pick the ticket; the workspace is found from its project code. Approvals happen as pull requests in GitHub.</p>

      <div className="sentence">
        Run RPI on{" "}
        <button className={`slot ${issue ? "" : "empty-slot"}`} onClick={() => { setOpen("task"); setQ(""); }} aria-expanded={open === "task"}>
          {issue ? issue.key : "a Jira task"}
        </button>
      </div>
      {issue && <p className="hint">{issue.title}</p>}

      {open === "task" && (
        <div className="picker" role="dialog" aria-label="Choose a Jira task">
          <input autoFocus placeholder="Search your Jira issues" value={q} onChange={(e) => setQ(e.target.value)} />
          <ul>
            {live.jira && remote.loading && <li className="none">Searching Jira…</li>}
            {remote.error && <li className="none">{errorHelp(remote.error, "Jira")} <Link href="/settings">Settings</Link></li>}
            {!remote.loading && !remote.error && matches.length === 0 && (
              <li className="none">{q ? `No issues match “${q}”.` : "No issues found in the Jira sites you can access."}</li>
            )}
            {matches.map((i) => (
              <li key={i.key}>
                <button onClick={() => { setChosen(i); setIssueKey(i.key); setOpen(null); }}>
                  <span><span className="mono">{i.key}</span> &nbsp;{i.title}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="go">
        <button className="btn primary" disabled={!issue} onClick={go}>Start RPI</button>
        {!issue && <span className="hint">Choose a task to continue.</span>}
      </div>
    </>
  );
}
