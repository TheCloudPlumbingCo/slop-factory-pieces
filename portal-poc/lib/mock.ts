export type Stage = "research" | "plan" | "implement";
export type Status = "running" | "needs-approval" | "done" | "stopped";

/** One run of the RPI workflow (research, plan, implement) for a Jira ticket. */
export type Task = {
  id: string;
  key: string;
  title: string;
  stage: Stage;
  status: Status;
  since: number; // ms timestamp of the last status change
  note?: string;
  /** Where the approval happens. Every approval is a pull request in the workspace repo. */
  prUrl?: string;
};

export type Connection = { connected: boolean; account?: string };

/** The GitHub project board that holds the real state. The portal only links to it. */
export const projectBoardUrl = process.env.NEXT_PUBLIC_PROJECT_URL ?? "https://github.com/orgs/TheCloudPlumbingCo/projects/4";

export const SAMPLE_PRS = "https://github.com/TheCloudPlumbingCo/teahouse-workspace/pulls";

export const jiraIssues = [
  { key: "KAN-2", title: "As a tea drinker, I want to order an iced tea so I can have a cold drink on a hot day" },
  { key: "KAN-3", title: "As a customer, I want to choose my tea leaf variety and strength so the cup matches my taste" },
  { key: "KAN-4", title: "As a tea maker, I want the right water temperature for each tea so it is not bitter or weak" },
  { key: "KAN-5", title: "As a customer, I want a friendly message when the kitchen is slow or down, so I am not left hanging" },
  { key: "KAN-6", title: "As a teahouse operator, I want a dashboard of orders, latency and errors so I can see how the shop is doing" },
  { key: "KAN-9", title: "Tea order hangs for a long time when the water service is slow" },
  { key: "KAN-10", title: "Unknown tea variety returns a server error instead of a clear message" },
  { key: "KAN-12", title: "Services fail to build because teahouse-core cannot be resolved from GitHub Packages" },
];

export const seedTasks = (now: number): Task[] => [
  { id: "t1", key: "KAN-9", title: "Tea order hangs for a long time when the water service is slow", stage: "research", status: "needs-approval", since: now - 3_600_000, note: "Open decision: add timeouts in tea-service only, or also in the shared client in teahouse-core.", prUrl: SAMPLE_PRS },
  { id: "t2", key: "KAN-4", title: "As a tea maker, I want the right water temperature for each tea so it is not bitter or weak", stage: "plan", status: "needs-approval", since: now - 7_200_000, note: "Plan touches water-service, its water-api client and tea-service.", prUrl: SAMPLE_PRS },
  { id: "t3", key: "KAN-10", title: "Unknown tea variety returns a server error instead of a clear message", stage: "implement", status: "done", since: now - 86_400_000, note: "Pull requests open in tealeaf-service and tea-service.", prUrl: SAMPLE_PRS },
  { id: "t4", key: "KAN-5", title: "As a customer, I want a friendly message when the kitchen is slow or down, so I am not left hanging", stage: "research", status: "running", since: now - 600_000 },
];
