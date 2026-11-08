"use client";
import Link from "next/link";
import { useStore } from "@/components/Store";
import { errorHelp, useFetchList } from "@/lib/useFetchList";
import { projectBoardUrl } from "@/lib/projectBoard";

function ago(ms: number) {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
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
        {projectBoardUrl && <a className="btn ghost linkbtn" href={projectBoardUrl} target="_blank" rel="noreferrer">Open the project board in GitHub</a>}
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
  if (!ready) return <h1>Loading…</h1>;
  if (live.github && github.connected) return <LiveAttention />;
  return (
    <>
      <h1>Connect GitHub</h1>
      <p className="muted">{live.github ? "The portal shows the pull requests waiting on your review, so it needs your GitHub account." : "GitHub is not configured on this deployment. Ask an admin to add the client credentials."}</p>
      {live.github && <p><Link className="btn primary linkbtn" href="/settings">Open settings</Link></p>}
    </>
  );
}
