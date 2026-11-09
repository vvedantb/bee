// First, so the local debug log is listening before anything else runs.
import "./debug-log-boot";
import { ClerkProvider } from "@clerk/electron/react";
import { SonnerToaster, toast } from "@vvedantb/ui";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { CLERK_PUBLISHABLE_KEY } from "../../shared/clerk";
import { App } from "./App";
import { logStateChanges } from "./debug-log";
import { actions, getBeeState, onAutoMeetingNotice, subscribe } from "./store";
import "./styles.css";

// Island and panel state changes for the debug log.
logStateChanges(subscribe, getBeeState);

// Automatic meeting detection starts and stops quietly: a toast, never a dialog.
onAutoMeetingNotice((message) => toast(message));

// Focus went to another app: the user clicked outside Bee, so an answer open in full folds back to the pill.
window.addEventListener("blur", () => actions.clickedOutside());

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <ClerkProvider publishableKey={CLERK_PUBLISHABLE_KEY}>
        <App />
        {/* Top-right, below the 52px notch so toasts never cover it. Bee's windows are under Sonner's 600px mobile breakpoint, where it
            ignores offset and uses mobileOffset (full width), so that needs the same top inset. */}
        <SonnerToaster theme="dark" position="top-right" offset={64} mobileOffset={{ top: 64, right: 16, left: 16 }} />
      </ClerkProvider>
    </StrictMode>,
  );
}
