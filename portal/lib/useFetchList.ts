"use client";
import { useEffect, useState } from "react";

export type ListState<T> = { items: T[]; loading: boolean; error: string | null };

// Fetch a JSON list from our own API (debounced, cancels stale requests). Disabled = no request.
export function useFetchList<T>(url: string | null, debounceMs = 0): ListState<T> {
  const [state, setState] = useState<ListState<T>>({ items: [], loading: !!url, error: null });

  useEffect(() => {
    if (!url) return;
    const ctl = new AbortController();
    setState((s) => ({ ...s, loading: true, error: null }));
    const t = setTimeout(async () => {
      try {
        const res = await fetch(url, { signal: ctl.signal });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `http_${res.status}`);
        }
        setState({ items: await res.json(), loading: false, error: null });
      } catch (e) {
        if (!ctl.signal.aborted) setState({ items: [], loading: false, error: e instanceof Error ? e.message : "failed" });
      }
    }, debounceMs);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [url, debounceMs]);

  return state;
}

export const errorHelp = (code: string, provider: "GitHub" | "Jira"): string =>
  code === "not_connected"
    ? `Your ${provider} connection expired. Reconnect it in settings.`
    : `Could not load from ${provider} (${code}). Try again, or reconnect in settings.`;
