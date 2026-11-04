import "./globals.css";
import { Bricolage_Grotesque, Instrument_Sans, JetBrains_Mono } from "next/font/google";
import { auth, signIn, signOut } from "@/auth";
import { Store } from "@/components/Store";
import { Shell } from "@/components/Shell";
import { localUser } from "@/lib/localUser";
import { githubInfo, liveProviders } from "@/lib/providers/config";

const display = Bricolage_Grotesque({ subsets: ["latin"], variable: "--font-display" });
const body = Instrument_Sans({ subsets: ["latin"], variable: "--font-body" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono" });

export const metadata = { title: "Slop portal" };
export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Local only: PROTOTYPE_NO_AUTH=1 (sample data) or PORTAL_LOCAL_USER=<name> (real GitHub and Jira) skip Microsoft sign-in.
  const local = localUser();
  const session = process.env.PROTOTYPE_NO_AUTH
    ? { user: { name: "Alice (preview)", email: "poc-alice@devhyashodhagmail.onmicrosoft.com" } }
    : local
      ? { user: { name: local, email: "local development, no Microsoft sign-in" } }
      : await auth();
  const fonts = `${display.variable} ${body.variable} ${mono.variable}`;

  if (!session) {
    return (
      <html lang="en" className={fonts}>
        <body>
          <main className="signin">
            <form action={async () => { "use server"; await signIn("microsoft-entra-id"); }}>
              <h1>Slop portal</h1>
              <p>Sign in with your work account to see your research, plans and implementations.</p>
              <button className="btn primary" type="submit">Sign in with Microsoft</button>
            </form>
          </main>
        </body>
      </html>
    );
  }

  const doSignOut = async () => { "use server"; await signOut(); };
  return (
    <html lang="en" className={fonts}>
      <body>
        <Store live={liveProviders()} githubInfo={githubInfo()}>
          <Shell name={session.user?.name ?? "You"} email={session.user?.email ?? ""} signOut={doSignOut}>
            {children}
          </Shell>
        </Store>
      </body>
    </html>
  );
}
