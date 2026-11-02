"use client";
import Link from "next/link";
import { useStore } from "@/components/Store";
import type { Stage, Status, Task } from "@/lib/mock";

const stations: { stage: Stage; title: string; blurb: string }[] = [
  { stage: "research", title: "Research", blurb: "Find out what is going on" },
  { stage: "plan", title: "Plan", blurb: "Decide the steps" },
  { stage: "implement", title: "Implement", blurb: "Make the change" },
];

const label: Record<Status, string> = {
  running: "Running in sandbox",
  "needs-approval": "Needs your approval",
  done: "Done",
  stopped: "Stopped",
};

function ago(ms: number) {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

function Row({ t }: { t: Task }) {
  const { approve, stop } = useStore();
  const next = t.stage === "research" ? "Approve and plan" : "Approve and implement";
  return (
    <div className="row">
      <div>
        <div className="title"><span className="mono">{t.key}</span> &nbsp;{t.title}</div>
        <div className="meta">
          <span className={`lamp ${t.status}`}>{label[t.status]}</span>
          <span>{t.workspace}</span>
          <span>{ago(t.since)}</span>
        </div>
      </div>
      <div className="actions">
        {t.status === "needs-approval" && (
          <>
            <button className="btn primary" onClick={() => approve(t.id)}>{next}</button>
            <button className="btn ghost" onClick={() => stop(t.id)}>Stop</button>
          </>
        )}
      </div>
      {t.note && <div className="note">{t.note}</div>}
    </div>
  );
}

export default function Pipeline() {
  const { tasks, ready } = useStore();
  const waiting = tasks.filter((t) => t.status === "needs-approval").length;
  return (
    <>
      <h1>{waiting > 0 ? `${waiting} waiting for you` : "Nothing waiting for you"}</h1>
      <p className="muted">Everything started from Jira, GitHub, Teams or this portal shows up here.</p>
      <p><Link className="btn primary" href="/new" style={{ textDecoration: "none", display: "inline-block" }}>Start research</Link></p>
      <div className="pipeline" aria-busy={!ready}>
        {stations.map((s) => {
          const items = tasks.filter((t) => t.stage === s.stage);
          return (
            <section className="station" key={s.stage} aria-label={s.title}>
              <div className="station-head">
                <h2>{s.title}</h2>
                <span>{items.length} {items.length === 1 ? "task" : "tasks"}</span>
              </div>
              <div className="rows">
                {items.length === 0 ? (
                  <div className="empty">{s.blurb}. Nothing here yet.</div>
                ) : (
                  items.map((t) => <Row key={t.id} t={t} />)
                )}
              </div>
            </section>
          );
        })}
      </div>
    </>
  );
}
