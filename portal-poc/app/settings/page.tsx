"use client";
import { useEffect, useState } from "react";
import { useStore } from "@/components/Store";
import { RepoPicker } from "@/components/RepoPicker";

const connectErrorText = (code: string): string =>
  ({
    not_configured: "This provider is not set up on the server yet. Ask an admin to add its client credentials.",
    access_denied: "The connection was cancelled. Connect again when you are ready.",
    expired_state: "The sign-in took too long. Click Connect and try again.",
    exchange_failed: "The provider did not accept the connection. Try again; if it keeps failing, ask an admin to check the app registration.",
  })[code] ?? `Could not connect (${code}). Click Connect to try again.`;

export default function Settings() {
  const { jira, github, connect, disconnect, workspaces, addWorkspace, removeWorkspace, reset } = useStore();
  const [name, setName] = useState("");
  const [repos, setRepos] = useState<string[]>([]);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  // The OAuth callback redirects here with ?connected=<provider> or ?error=<code>.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("connected");
    const error = params.get("error");
    if (connected) setNotice({ ok: true, text: `${connected === "jira" ? "Jira" : "GitHub"} connected.` });
    else if (error) setNotice({ ok: false, text: connectErrorText(error) });
    if (connected || error) window.history.replaceState(null, "", "/settings");
  }, []);

  const add = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || repos.length === 0) return;
    addWorkspace(name.trim(), repos);
    setName("");
    setRepos([]);
  };

  const providers = [
    { id: "github" as const, name: "GitHub", state: github, why: "Lets the agent read your repos with your own access." },
    { id: "jira" as const, name: "Jira", state: jira, why: "Lets you pick tasks from the issues you can see." },
  ];

  return (
    <>
      <h1>Settings</h1>

      <section className="section">
        <div>
          <h2>Connections</h2>
          <p>Your work account proves who you are. Connect GitHub and Jira so the portal can act as you, never with more access than you have.</p>
        </div>
        <div>
          {notice && <p role="status" className={notice.ok ? "" : "muted"}>{notice.text}</p>}
          {providers.map((p) => (
            <div className="conn" key={p.id}>
              <div>
                <strong>{p.name}</strong>
                <div className="muted">{p.state.connected ? `Connected as ${p.state.account}` : p.why}</div>
              </div>
              {p.state.connected ? (
                <button className="btn ghost" onClick={() => disconnect(p.id)}>Disconnect {p.name}</button>
              ) : (
                <button className="btn primary" onClick={() => connect(p.id)}>Connect {p.name}</button>
              )}
            </div>
          ))}
        </div>
      </section>

      <section className="section">
        <div>
          <h2>Workspaces</h2>
          <p>A workspace is a named set of repos. Pick one when you start research and the agent looks across all of them.</p>
        </div>
        <div>
          {workspaces.length === 0 && <p className="muted">No workspaces yet. Add one below.</p>}
          {workspaces.map((w) => (
            <div className="ws" key={w.id}>
              <div>
                <strong>{w.name}</strong>
                <div className="chips">{w.repos.map((r) => <span className="chip" key={r}>{r}</span>)}</div>
              </div>
              <button className="btn ghost" onClick={() => removeWorkspace(w.id)}>Remove</button>
            </div>
          ))}
          <form className="fields" onSubmit={add}>
            <label>Name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="payments-team" /></label>
            <div>
              <div style={{ marginBottom: 6 }}>Repos</div>
              {github.connected ? (
                <RepoPicker value={repos} onChange={setRepos} />
              ) : (
                <p className="muted" style={{ margin: 0 }}>Connect GitHub above to choose from the repos you can access.</p>
              )}
            </div>
            <div><button className="btn" type="submit" disabled={!name.trim() || repos.length === 0}>Add workspace</button></div>
          </form>
        </div>
      </section>

      <section className="section">
        <div><h2>Prototype</h2></div>
        <div><button className="btn ghost" onClick={reset}>Reset sample data</button></div>
      </section>
    </>
  );
}
