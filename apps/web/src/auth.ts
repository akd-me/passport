/** Same-origin cookies authenticate both fetch and browser WebSocket upgrades. */
export const authHeaders = { "X-Requested-With": "passport" };

export function handleUnauthorized(response: Response): void {
  if (response.status === 401) window.location.replace("/");
}

export function websocketUrl(): string {
  return `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`;
}

export async function checkSession(): Promise<void> {
  try {
    const response = await fetch("/api/auth/status", {
      credentials: "same-origin",
    });
    if (
      response.ok &&
      !((await response.json()) as { authenticated: boolean }).authenticated
    )
      window.location.replace("/");
  } catch {
    /* Reconnect normally while the server is unavailable. */
  }
}

async function login(token: string): Promise<boolean> {
  const response = await fetch("/api/auth/login", {
    method: "POST",
    credentials: "same-origin",
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  // The server sets the cookie and redirects to the clean root URL.
  return response.ok;
}

function loginPage(tokenPath: string): void {
  const root = document.getElementById("root")!;
  const main = document.createElement("main");
  main.style.cssText =
    "max-width:460px;margin:12vh auto;padding:24px;font-family:system-ui";
  const title = document.createElement("h1");
  title.textContent = "Sign in to Passport";
  const hint = document.createElement("p");
  hint.textContent = `Paste the API token printed in your terminal. For a durable workspace it is stored at ${tokenPath}. Demo tokens last until the server stops.`;
  const form = document.createElement("form");
  const label = document.createElement("label");
  label.textContent = "API token";
  label.htmlFor = "passport-token";
  const input = document.createElement("input");
  input.id = "passport-token";
  input.type = "password";
  input.required = true;
  input.autocomplete = "off";
  input.style.cssText =
    "display:block;width:100%;box-sizing:border-box;margin:12px 0;padding:10px";
  const button = document.createElement("button");
  button.type = "submit";
  button.textContent = "Sign in";
  button.style.cssText = "padding:10px 18px;cursor:pointer";
  const error = document.createElement("p");
  error.setAttribute("role", "alert");
  form.append(label, input, button, error);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    button.disabled = true;
    error.textContent = "";
    try {
      if (await login(input.value.trim())) window.location.replace("/");
      else
        error.textContent =
          "That token was not accepted. Check the terminal and try again.";
    } catch {
      error.textContent = "Could not reach Passport. Please try again.";
    } finally {
      button.disabled = false;
    }
  });
  main.append(title, hint, form);
  root.replaceChildren(main);
  input.focus();
}

/** Gate the application before it fetches mail or starts its event stream. */
export async function initializeAuth(render: () => void): Promise<void> {
  const url = new URL(window.location.href);
  const token = url.searchParams.get("token");
  if (token !== null) {
    // Vite serves the root itself; exchange its startup URL through the API proxy.
    url.searchParams.delete("token");
    history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }
  try {
    if (token !== null) await login(token);
    const response = await fetch("/api/auth/status", {
      credentials: "same-origin",
    });
    if (!response.ok) throw new Error("Authentication service unavailable");
    const status = (await response.json()) as {
      authenticated: boolean;
      tokenPath?: string;
    };
    if (status.authenticated) render();
    else loginPage(status.tokenPath ?? "<data dir>/api-token");
  } catch {
    loginPage("<data dir>/api-token");
  }
}
