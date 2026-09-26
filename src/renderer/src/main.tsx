import { ClerkProvider } from "@clerk/electron/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { CLERK_PUBLISHABLE_KEY } from "../../shared/clerk";
import { App } from "./App";
import "./styles.css";

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <ClerkProvider publishableKey={CLERK_PUBLISHABLE_KEY}>
        <App />
      </ClerkProvider>
    </StrictMode>,
  );
}
