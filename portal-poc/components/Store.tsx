"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { Provider } from "@/lib/tokens";
import type { GithubInfo } from "@/lib/githubMode";
import { Connection, Task, Workspace, seedTasks, seedWorkspaces } from "@/lib/mock";

type State = {
  tasks: Task[];
  workspaces: Workspace[];
  jira: Connection;
  github: Connection;
};

type Api = State & {
  ready: boolean;
  githubInfo: GithubInfo;
  live: Record<Provider, boolean>; // true = real connection, false = simulated sample data
  startResearch: (key: string, title: string, workspace: string) => void;
  approve: (id: string) => void;
  stop: (id: string) => void;
  connect: (p: Provider) => void;
  disconnect: (p: Provider) => Promise<void>;
  addWorkspace: (name: string, repos: string[]) => void;
  removeWorkspace: (id: string) => void;
  reset: () => void;
};

const Ctx = createContext<Api | null>(null);
const KEY = "slop-portal-prototype-v1";
const RUN_MS = 6000; // how long a simulated run takes

const initial = (): State => ({
  tasks: seedTasks(Date.now()),
  workspaces: seedWorkspaces,
  jira: { connected: false },
  github: { connected: false },
});

type ConnectionsResponse = Record<Provider, { connected: boolean; account?: string }>;

export function Store({ children, live, githubInfo }: { children: React.ReactNode; live: Record<Provider, boolean>; githubInfo: GithubInfo }) {
  const [state, setState] = useState<State>(initial);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let stored: State | null = null;
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) stored = JSON.parse(raw);
    } catch {}
    (async () => {
      let connections: Partial<ConnectionsResponse> = {};
      if (live.github || live.jira) {
        try {
          const res = await fetch("/api/connections");
          if (res.ok) connections = await res.json();
        } catch {}
      }
      setState((s) => {
        const next = stored ?? s;
        const pick = (p: Provider): Connection =>
          !live[p] ? next[p] : { connected: !!connections[p]?.connected, account: connections[p]?.account };
        return { ...next, github: pick("github"), jira: pick("jira") };
      });
      setReady(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live.github, live.jira]);

  useEffect(() => {
    if (ready) localStorage.setItem(KEY, JSON.stringify(state));
  }, [state, ready]);

  // Simulated agent: a running task finishes after RUN_MS.
  useEffect(() => {
    const t = setInterval(() => {
      setState((s) => {
        const now = Date.now();
        let changed = false;
        const tasks = s.tasks.map((task) => {
          if (task.status !== "running" || now - task.since < RUN_MS) return task;
          changed = true;
          if (task.stage === "implement") return { ...task, status: "done" as const, since: now, note: "Pull request opened (sample)." };
          const note = task.stage === "research" ? "Research ready: found the likely cause and 2 related files." : "Plan ready: 4 steps across the workspace repos.";
          return { ...task, status: "needs-approval" as const, since: now, note };
        });
        return changed ? { ...s, tasks } : s;
      });
    }, 1000);
    return () => clearInterval(t);
  }, []);

  const startResearch = useCallback((key: string, title: string, workspace: string) => {
    setState((s) => ({
      ...s,
      tasks: [{ id: crypto.randomUUID(), key, title, workspace, stage: "research", status: "running", since: Date.now() }, ...s.tasks],
    }));
  }, []);

  const approve = useCallback((id: string) => {
    setState((s) => ({
      ...s,
      tasks: s.tasks.map((t) =>
        t.id !== id ? t : { ...t, stage: t.stage === "research" ? "plan" : "implement", status: "running", since: Date.now(), note: undefined },
      ),
    }));
  }, []);

  const stop = useCallback((id: string) => {
    setState((s) => ({ ...s, tasks: s.tasks.map((t) => (t.id === id ? { ...t, status: "stopped", since: Date.now() } : t)) }));
  }, []);

  const connect = useCallback((p: Provider) => {
    if (live[p]) {
      window.location.assign(`/api/connect/${p}/start`); // full-page redirect to the provider
      return;
    }
    setState((s) => ({ ...s, [p]: { connected: true, account: p === "jira" ? "alice@acme.atlassian.net" : "@alice-dev" } }));
  }, [live]);
  const disconnect = useCallback(async (p: Provider) => {
    if (live[p]) await fetch(`/api/connect/${p}/disconnect`, { method: "POST" });
    setState((s) => ({ ...s, [p]: { connected: false } }));
  }, [live]);

  const addWorkspace = useCallback((name: string, repos: string[]) => {
    setState((s) => ({ ...s, workspaces: [...s.workspaces, { id: crypto.randomUUID(), name, repos }] }));
  }, []);
  const removeWorkspace = useCallback((id: string) => setState((s) => ({ ...s, workspaces: s.workspaces.filter((w) => w.id !== id) })), []);
  const reset = useCallback(() => setState(initial()), []);

  const api = useMemo<Api>(
    () => ({ ...state, ready, live, githubInfo, startResearch, approve, stop, connect, disconnect, addWorkspace, removeWorkspace, reset }),
    [state, ready, live, githubInfo, startResearch, approve, stop, connect, disconnect, addWorkspace, removeWorkspace, reset],
  );
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export const useStore = () => {
  const v = useContext(Ctx);
  if (!v) throw new Error("useStore outside Store");
  return v;
};
