// Signed-in stand-in for @clerk/electron/react in harness pages (run.ts aliases the import), so the real store and App run
// without Clerk's hosted sign-in. getToken returns the unsigned ?token= the harness passes, which is all main/auth.ts checks.
import type { ReactNode } from "react";

const token = new URLSearchParams(location.search).get("token");

export const getToken = async (): Promise<string | null> => token;
export const useAuth = () => ({ isSignedIn: true });
export const useUser = () => ({ user: null });

export function Show({ when, children }: { when: "signed-in" | "signed-out"; children: ReactNode }): ReactNode {
  return when === "signed-in" ? children : null;
}

export function ClerkProvider({ children }: { children: ReactNode }): ReactNode {
  return children;
}

export const SignIn = (): ReactNode => null;
export const UserButton = (): ReactNode => null;
export const ClerkFailed = (): ReactNode => null;
