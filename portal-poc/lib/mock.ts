export type Stage = "research" | "plan" | "implement";
export type Status = "running" | "needs-approval" | "done" | "stopped";

export type Task = {
  id: string;
  key: string;
  title: string;
  workspace: string;
  stage: Stage;
  status: Status;
  since: number; // ms timestamp of the last status change
  note?: string;
};

export type Workspace = { id: string; name: string; repos: string[] };
export type Connection = { connected: boolean; account?: string };

export const jiraIssues = [
  { key: "PAY-142", title: "Checkout fails when the saved card has expired" },
  { key: "PAY-139", title: "Refunds over 30 days are rejected without a message" },
  { key: "PAY-131", title: "Retry webhooks from the card processor with backoff" },
  { key: "PLAT-88", title: "Rate limit the public search endpoint" },
  { key: "PLAT-86", title: "Move session storage from Redis to Cosmos" },
  { key: "PLAT-79", title: "Audit log entries are missing the actor's tenant" },
  { key: "PAY-120", title: "Invoice PDF shows the wrong VAT line for AU customers" },
  { key: "PLAT-64", title: "Sandbox runs should clean up cloned repos on failure" },
];

export const seedWorkspaces: Workspace[] = [
  { id: "w1", name: "payments-team", repos: ["api-gateway", "checkout-service", "billing-lib"] },
  { id: "w2", name: "platform-core", repos: ["identity-service", "audit-log"] },
];

export const seedTasks = (now: number): Task[] => [
  { id: "t1", key: "PAY-131", title: "Retry webhooks from the card processor with backoff", workspace: "payments-team", stage: "research", status: "needs-approval", since: now - 3_600_000, note: "Found 2 places that drop failed deliveries. Proposes a retry queue." },
  { id: "t2", key: "PLAT-79", title: "Audit log entries are missing the actor's tenant", workspace: "platform-core", stage: "plan", status: "needs-approval", since: now - 7_200_000, note: "Plan touches 3 files in audit-log and 1 in identity-service." },
  { id: "t3", key: "PAY-120", title: "Invoice PDF shows the wrong VAT line for AU customers", workspace: "payments-team", stage: "implement", status: "done", since: now - 86_400_000, note: "PR #214 open in billing-lib." },
];

// Repos the signed-in person can see on GitHub (sample).
export const githubRepos = [
  "acme/api-gateway", "acme/checkout-service", "acme/billing-lib", "acme/identity-service",
  "acme/audit-log", "acme/web-storefront", "acme/mobile-app", "acme/infra-terraform",
  "acme/search-service", "acme/notification-hub", "acme/data-pipeline", "alice-dev/dotfiles",
];
