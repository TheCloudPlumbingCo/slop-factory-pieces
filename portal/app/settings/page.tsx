"use client";
import { useEffect, useState } from "react";
import { useStore } from "@/components/Store";

const connectErrorText = (code: string): string =>
  ({
    not_configured: "This provider is not set up on the server yet. Ask an admin to add its client credentials.",
    access_denied: "The connection was cancelled. Connect again when you are ready.",
    expired_state: "The sign-in took too long. Click Connect and try again.",
    exchange_failed: "The provider did not accept the connection. Try again; if it keeps failing, ask an admin to check the app registration.",
  })[code] ?? `Could not connect (${code}). Click Connect to try again.`;

export default function Settings() {
  const { jira, github, githubInfo, live, connect, disconnect } = useStore();
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

  const providers = [
    { id: "github" as const, name: githubInfo.label, state: github, why: githubInfo.sees },
    { id: "jira" as const, name: "Jira", state: jira, why: "Lets you pick the ticket to start RPI on, from the issues you can see." },
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
                <div className="muted">{p.state.connected ? `Connected as ${p.state.account}` : live[p.id] ? p.why : connectErrorText("not_configured")}</div>
                {p.state.connected && p.id === "github" && <div className="muted">{p.why}</div>}
              </div>
              {p.state.connected ? (
                <button className="btn ghost" onClick={() => disconnect(p.id)}>Disconnect {p.name}</button>
              ) : (
                <button className="btn primary" disabled={!live[p.id]} onClick={() => connect(p.id)}>Connect {p.name}</button>
              )}
            </div>
          ))}
        </div>
      </section>

      <section className="section">
        <div>
          <h2>Workspaces</h2>
          <p>Workspaces are managed in the workspace repo, not here.</p>
        </div>
        <div>
          <p className="muted" style={{ margin: 0 }}>Each project has a workspace repo where people create and edit its logical workspaces. A Jira ticket finds its workspace from the project code, so there is nothing to choose or configure in the portal.</p>
        </div>
      </section>
    </>
  );
}
