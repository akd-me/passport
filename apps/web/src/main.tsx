import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import "@fontsource-variable/public-sans/wght.css";
import "@fontsource-variable/public-sans/wght-italic.css";
import "@fontsource-variable/source-serif-4/opsz.css";
import { App } from "./App";
import { WorkspaceProvider } from "./state";
import { UiProvider } from "./ui-state";
import "./styles.css";
import "./styles-tasks.css";
import { initializeAuth } from "./auth";

void initializeAuth(() =>
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <BrowserRouter>
        <WorkspaceProvider>
          <UiProvider>
            <App />
          </UiProvider>
        </WorkspaceProvider>
      </BrowserRouter>
    </StrictMode>,
  ),
);
