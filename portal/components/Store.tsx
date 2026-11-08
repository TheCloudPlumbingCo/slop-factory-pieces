"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { Provider } from "@/lib/tokens";
import type { GithubInfo } from "@/lib/githubMode";

export type Connection = { connected: boolean; account?: string };

type State = { jira: Connection; github: Connection };

type Api = State & {
  ready: boolean;
  githubInfo: GithubInfo;
  live: Record<Provider, boolean>; // true = the server has credentials for this provider
  connect: (p: Provider) => void;
  disconnect: (p: Provider) => Promise<void>;
};

const Ctx = createContext<Api | null>(null);

type ConnectionsResponse = Record<Provider, { connected: boolean; account?: string }>;

export function Store({ children, live, githubInfo }: { children: React.ReactNode; live: Record<Provider, boolean>; githubInfo: GithubInfo }) {
  const [state, setState] = useState<State>({ jira: { connected: false }, github: { connected: false } });
  const [ready, setReady] = useState(false);

  useEffect(() => {
    (async () => {
      let connections: Partial<ConnectionsResponse> = {};
      if (live.github || live.jira) {
        try {
          const res = await fetch("/api/connections");
          if (res.ok) connections = await res.json();
        } catch {}
      }
      const pick = (p: Provider): Connection => ({ connected: !!connections[p]?.connected, account: connections[p]?.account });
      setState({ github: pick("github"), jira: pick("jira") });
      setReady(true);
    })();
  }, [live.github, live.jira]);

  const connect = useCallback((p: Provider) => {
    if (live[p]) window.location.assign(`/api/connect/${p}/start`); // full-page redirect to the provider
  }, [live]);

  const disconnect = useCallback(async (p: Provider) => {
    if (live[p]) await fetch(`/api/connect/${p}/disconnect`, { method: "POST" });
    setState((s) => ({ ...s, [p]: { connected: false } }));
  }, [live]);

  const api = useMemo<Api>(
    () => ({ ...state, ready, live, githubInfo, connect, disconnect }),
    [state, ready, live, githubInfo, connect, disconnect],
  );
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export const useStore = () => {
  const v = useContext(Ctx);
  if (!v) throw new Error("useStore outside Store");
  return v;
};
