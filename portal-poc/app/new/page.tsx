"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { useStore } from "@/components/Store";
import { errorHelp, useFetchList } from "@/lib/useFetchList";
import { jiraIssues } from "@/lib/mock";

type Issue = { key: string; title: string };

export default function NewResearch() {
  const { jira, live, workspaces, startResearch, ready } = useStore();
  const router = useRouter();
  const [open, setOpen] = useState<"task" | "workspace" | null>("task");
  const [q, setQ] = useState("");
  const [issueKey, setIssueKey] = useState<string | null>(null);
  const [wsId, setWsId] = useState<string | null>(null);

  const remote = useFetchList<Issue>(live.jira && jira.connected ? `/api/jira/issues?q=${encodeURIComponent(q)}` : null, 300);
  const sample = useMemo(
    () => jiraIssues.filter((i) => (i.key + " " + i.title).toLowerCase().includes(q.toLowerCase())),
    [q],
  );
  const matches: Issue[] = live.jira ? remote.items : sample;
  // Remember the chosen issue itself: live search results change as the query changes.
  const [chosen, setChosen] = useState<Issue | null>(null);
  const issue = chosen && chosen.key === issueKey ? chosen : null;
  const ws = workspaces.find((w) => w.id === wsId);

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
    if (!issue || !ws) return;
    startResearch(issue.key, issue.title, ws.name);
    router.push("/");
  };

  return (
    <>
      <h1>Start research</h1>
      <p className="muted">Pick the task and the repos to look through. The agent reads them with your GitHub access.</p>

      <div className="sentence">
        Research{" "}
        <button className={`slot ${issue ? "" : "empty-slot"}`} onClick={() => { setOpen("task"); setQ(""); }} aria-expanded={open === "task"}>
          {issue ? issue.key : "a Jira task"}
        </button>{" "}
        across{" "}
        <button className={`slot ${ws ? "" : "empty-slot"}`} onClick={() => setOpen("workspace")} aria-expanded={open === "workspace"}>
          {ws ? ws.name : "a workspace"}
        </button>
      </div>
      {issue && <p className="hint">{issue.title}</p>}
      {ws && <p className="hint">{ws.repos.join(", ")}</p>}

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
                <button onClick={() => { setChosen(i); setIssueKey(i.key); setOpen(wsId ? null : "workspace"); }}>
                  <span><span className="mono">{i.key}</span> &nbsp;{i.title}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {open === "workspace" && (
        <div className="picker" role="dialog" aria-label="Choose a workspace">
          <ul>
            {workspaces.length === 0 && <li className="none">No workspaces yet. Create one in <Link href="/settings">settings</Link>.</li>}
            {workspaces.map((w) => (
              <li key={w.id}>
                <button onClick={() => { setWsId(w.id); setOpen(null); }}>
                  <strong>{w.name}</strong>
                  <span className="muted">{w.repos.join(", ")}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="go">
        <button className="btn primary" disabled={!issue || !ws} onClick={go}>Start research</button>
        {(!issue || !ws) && <span className="hint">Choose {!issue ? "a task" : "a workspace"} to continue.</span>}
      </div>
    </>
  );
}
