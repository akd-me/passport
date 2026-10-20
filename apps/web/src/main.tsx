import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { WorkspaceProvider } from "./state";
import { App } from "./App";
import "./styles.css";
import { initializeAuth } from "./auth";
void initializeAuth(() =>
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <BrowserRouter>
        <WorkspaceProvider>
          <App />
        </WorkspaceProvider>
      </BrowserRouter>
    </StrictMode>,
  ),
);
