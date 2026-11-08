export class UpstreamError extends Error {
  constructor(public status: number, what: string) {
    super(`${what} failed with HTTP ${status}`);
  }
}

export async function getJson<T>(url: string, token: string, what: string, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...headers } });
  if (!res.ok) throw new UpstreamError(res.status, what);
  return (await res.json()) as T;
}
