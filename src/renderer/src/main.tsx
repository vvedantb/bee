import { ClerkProvider } from "@clerk/electron/react";
import { SonnerToaster } from "@vvedantb/ui";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { CLERK_PUBLISHABLE_KEY } from "../../shared/clerk";
import { App } from "./App";
import { actions } from "./store";
import "./styles.css";

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
