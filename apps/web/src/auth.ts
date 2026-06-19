import NextAuth, {
  type NextAuthConfig,
  type NextAuthResult,
} from "next-auth";
import Credentials from "next-auth/providers/credentials";
import GitHub from "next-auth/providers/github";
import Google from "next-auth/providers/google";
import { prisma } from "@brandai/db";
import { verifyPassword } from "@/lib/password";

/**
 * M-B — production auth.
 * - "password": real email/password (scrypt) against User.passwordHash.
 * - GitHub / Google: registered only when their env secrets are present, so an
 *   un-provisioned deploy simply doesn't offer them (no broken buttons). OAuth
 *   users are upserted into our User table by email in the jwt callback, so
 *   workspace ownership (keyed by User.id) works without a DB-session adapter.
 * - "credentials" (demo, passwordless): opt-in only (AUTH_ALLOW_DEMO=1) for
 *   staging/preview/e2e. Default OFF so production is safe even if the env is
 *   unset or copied from .env.example — the demo path upserts any supplied
 *   email and bypasses the closed-registration + password gates.
 */
const allowDemo = process.env.AUTH_ALLOW_DEMO === "1";
const hasGitHub = !!(
  process.env.AUTH_GITHUB_ID && process.env.AUTH_GITHUB_SECRET
);
const hasGoogle = !!(
  process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET
);

const providers: NextAuthConfig["providers"] = [
  Credentials({
    id: "password",
    name: "Email & Password",
    credentials: {
      email: { label: "Email", type: "email" },
      password: { label: "Password", type: "password" },
    },
    async authorize(creds) {
      const email = String(creds?.email ?? "").trim().toLowerCase();
      const password = String(creds?.password ?? "");
      if (!email || !password) return null;
      const user = await prisma.user.findUnique({ where: { email } });
      if (!user?.passwordHash) return null;
      if (!(await verifyPassword(password, user.passwordHash))) return null;
      // Disabled accounts (admin user-management) cannot sign in.
      if (!user.isActive) return null;
      return { id: user.id, email: user.email, name: user.name };
    },
  }),
];

if (hasGitHub) providers.push(GitHub);
if (hasGoogle) providers.push(Google);

if (allowDemo) {
  providers.push(
    Credentials({
      id: "credentials",
      name: "Demo",
      credentials: { email: { label: "Email", type: "email" } },
      // Staging-only passwordless login; auto-provisions the user.
      async authorize(creds) {
        const email = String(creds?.email ?? "").trim().toLowerCase();
        if (!email) return null;
        const user = await prisma.user.upsert({
          where: { email },
          update: {},
          create: { email, name: email.split("@")[0] },
        });
        // Disabled accounts cannot sign in, even via the demo provider.
        if (!user.isActive) return null;
        return { id: user.id, email: user.email, name: user.name };
      },
    }),
  );
}

const nextAuth: NextAuthResult = NextAuth({
  trustHost: true,
  session: { strategy: "jwt" },
  providers,
  callbacks: {
    async jwt({ token, user, account }) {
      if (user) {
        if (
          account &&
          (account.provider === "github" || account.provider === "google") &&
          user.email
        ) {
          // OAuth → map the provider identity onto our User row by email.
          const u = await prisma.user.upsert({
            where: { email: user.email },
            update: {},
            create: {
              email: user.email,
              name: user.name ?? user.email.split("@")[0],
              image: user.image ?? undefined,
              emailVerified: new Date(),
            },
          });
          token.uid = u.id;
        } else {
          token.uid = user.id;
        }
      }
      return token;
    },
    session({ session, token }) {
      if (token.uid) session.user.id = token.uid as string;
      return session;
    },
  },
  pages: { signIn: "/login" },
});

export const handlers: NextAuthResult["handlers"] = nextAuth.handlers;
export const auth: NextAuthResult["auth"] = nextAuth.auth;
export const signIn: NextAuthResult["signIn"] = nextAuth.signIn;
export const signOut: NextAuthResult["signOut"] = nextAuth.signOut;
