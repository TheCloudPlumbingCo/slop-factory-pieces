"use client";
import Link from "next/link";
import { useStore } from "@/components/Store";
import { errorHelp, useFetchList } from "@/lib/useFetchList";
import { projectBoardUrl } from "@/lib/mock";
import type { Stage, Status, Task } from "@/lib/mock";

const stations: { stage: Stage; title: string; blurb: string }[] = [
  { stage: "research", title: "Research", blurb: "Find out what is going on" },
  { stage: "plan", title: "Plan", blurb: "Decide the steps" },
  { stage: "implement", title: "Implement", blurb: "Make the change" },
];

const label: Record<Status, string> = {
  running: "Running",
  "needs-approval": "Waiting for a pull request review",
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

/** Read-only: approvals are pull requests in GitHub, so the portal links there instead of offering a button. */
function Row({ t }: { t: Task }) {
  return (
    <div className="row">
      <div>
        <div className="title"><span className="mono">{t.key}</span> &nbsp;{t.title}</div>
        <div className="meta">
          <span className={`lamp ${t.status}`}>{label[t.status]}</span>
          <span>{ago(t.since)}</span>
        </div>
      </div>
      <div className="actions">
        {t.prUrl && (
          <a className={`btn linkbtn ${t.status === "needs-approval" ? "primary" : "ghost"}`} href={t.prUrl} target="_blank" rel="noreferrer">
            {t.status === "needs-approval" ? "Review in GitHub" : "Open in GitHub"}
          </a>
        )}
      </div>
      {t.note && <div className="note">{t.note}</div>}
    </div>
  );
}

type ReviewRequest = { number: number; title: string; url: string; repo: string; updatedAt: string; key: string | null };

/** Real data: a pull request waiting on the signed-in person's review. */
function ReviewRow({ r }: { r: ReviewRequest }) {
  return (
    <div className="row">
      <div>
        <div className="title">{r.key && <><span className="mono">{r.key}</span> &nbsp;</>}{r.title}</div>
        <div className="meta"><span className="lamp needs-approval">Waiting for your review</span><span>{r.repo} #{r.number}</span><span>{ago(Date.parse(r.updatedAt))}</span></div>
      </div>
      <div className="actions"><a className="btn primary linkbtn" href={r.url} target="_blank" rel="noreferrer">Review in GitHub</a></div>
    </div>
  );
}

function LiveAttention() {
  const { items, loading, error } = useFetchList<ReviewRequest>("/api/github/attention");
  const oldest = items.length ? Math.min(...items.map((r) => Date.parse(r.updatedAt))) : null;
  return (
    <>
      <h1>{loading ? "Checking GitHub…" : items.length > 0 ? `${items.length} waiting for you` : "Nothing waiting for you"}</h1>
      <p className="muted">Pull requests where your review is requested. Every approval is a pull request in GitHub.</p>
      <div className="metrics" aria-busy={loading}>
        <div className={`metric ${items.length > 0 ? "alert" : ""}`}><strong>{loading ? "…" : items.length}</strong><span>waiting on your review</span></div>
        <div className="metric"><strong>{oldest ? ago(oldest) : "none"}</strong><span>least recently updated</span></div>
      </div>
      <div className="links">
        <Link className="btn primary linkbtn" href="/new">Start RPI</Link>
        <a className="btn ghost linkbtn" href={projectBoardUrl} target="_blank" rel="noreferrer">Open the project board in GitHub</a>
      </div>
      <section className="attention" aria-label="Needs your attention">
        <h2>Needs your attention</h2>
        <div className="rows">
          {error && <div className="empty">{errorHelp(error, "GitHub")} <Link href="/settings">Settings</Link></div>}
          {!error && !loading && items.length === 0 && <div className="empty">Nothing is waiting on your review.</div>}
          {items.map((r) => <ReviewRow key={r.url} r={r} />)}
        </div>
      </section>
      <p className="hint" style={{ marginTop: 28 }}>Counts per stage come from the project board in GitHub; this page does not copy them.</p>
    </>
  );
}

export default function Attention() {
  const { live, github, ready } = useStore();
  if (ready && live.github && github.connected) return <LiveAttention />;
  return <SampleAttention />;
}

function SampleAttention() {
  const { tasks, ready } = useStore();
  const waiting = tasks.filter((t) => t.status === "needs-approval");
  const running = tasks.filter((t) => t.status === "running").length;
  const done = tasks.filter((t) => t.status === "done").length;
  const oldest = waiting.length ? Math.min(...waiting.map((t) => t.since)) : null;
  return (
    <>
      <h1>{waiting.length > 0 ? `${waiting.length} waiting for you` : "Nothing waiting for you"}</h1>
      <p className="muted">Every approval is a pull request in GitHub. This page shows what needs you and links there.</p>

      <div className="metrics" aria-busy={!ready}>
        <div className={`metric ${waiting.length > 0 ? "alert" : ""}`}><strong>{waiting.length}</strong><span>waiting on a review</span></div>
        <div className="metric"><strong>{oldest ? ago(oldest) : "none"}</strong><span>oldest waiting</span></div>
        <div className="metric"><strong>{running}</strong><span>running now</span></div>
        <div className="metric"><strong>{done}</strong><span>done</span></div>
      </div>

      <div className="links">
        <Link className="btn primary linkbtn" href="/new">Start RPI</Link>
        <a className="btn ghost linkbtn" href={projectBoardUrl} target="_blank" rel="noreferrer">Open the project board in GitHub</a>
      </div>

      <section className="attention" aria-label="Needs your attention">
        <h2>Needs your attention</h2>
        <div className="rows">
          {waiting.length === 0 ? <div className="empty">Nothing is waiting on a review.</div> : waiting.map((t) => <Row key={t.id} t={t} />)}
        </div>
      </section>

      <h2 style={{ marginTop: 36 }}>All runs by stage</h2>
      <div className="pipeline" aria-busy={!ready}>
        {stations.map((s) => {
          const items = tasks.filter((t) => t.stage === s.stage);
          return (
            <section className="station" key={s.stage} aria-label={s.title}>
              <div className="station-head">
                <h2>{s.title}</h2>
                <span>{items.length} {items.length === 1 ? "run" : "runs"}</span>
              </div>
              <div className="rows">
                {items.length === 0 ? <div className="empty">{s.blurb}. Nothing here yet.</div> : items.map((t) => <Row key={t.id} t={t} />)}
              </div>
            </section>
          );
        })}
      </div>
    </>
  );
}
