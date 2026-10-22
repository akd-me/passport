import { useEffect, useState } from "react";
import { ApiError, api, type HostAgent, type HostAgentSettings } from "../api";
import { Feedback, Loading } from "../components/ui";
import { logger } from "../logger";
import { useTask } from "../state";
import { agentStatus } from "./ModelSettings";

const programs: { kind: HostAgent["kind"]; name: string; field: "claudePath" | "codexPath" }[] = [
  { kind: "claude-code", name: "Claude Code", field: "claudePath" },
  { kind: "codex", name: "Codex", field: "codexPath" },
];
const envNames: Record<HostAgent["kind"], string> = {
  "claude-code": "PASSPORT_CLAUDE_PATH",
  codex: "PASSPORT_CODEX_PATH",
};

type Load =
  | { state: "loading" }
  | { state: "ready"; settings: HostAgentSettings }
  | { state: "unsupported" }
  | { state: "error"; message: string };

function drafts(settings: HostAgentSettings): Record<HostAgent["kind"], string> {
  return {
    "claude-code": settings.paths["claude-code"].configured ?? "",
    codex: settings.paths.codex.configured ?? "",
  };
}

/**
 * Settings → Model → Agent programs: where each CLI was found, a binary-path override for
 * installs Passport cannot see (common when the Mac app starts from Finder), and Re-detect.
 */
export function HostAgentPaths({ onChange }: { onChange?: () => void }) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [paths, setPaths] = useState<Record<HostAgent["kind"], string>>({
    "claude-code": "",
    codex: "",
  });
  const task = useTask();
  useEffect(() => {
    let active = true;
    api
      .hostAgentSettings()
      .then((settings) => {
        if (active) {
          setLoad({ state: "ready", settings });
          setPaths(drafts(settings));
        }
      })
      .catch((error) => {
        // Host-agent settings could not be loaded.
        logger.warn("Host-agent settings could not be loaded");

        if (!active) {
          return;
        }
        // Older servers have no binary-path settings; the section stays hidden.
        setLoad(
          error instanceof ApiError && error.status === 404
            ? { state: "unsupported" }
            : { state: "error", message: (error as Error).message },
        );
      });
    return () => {
      active = false;
    };
  }, []);
  if (load.state === "unsupported") {
    return null;
  }
  const apply = async (request: Promise<HostAgentSettings>) => {
    const settings = await request;
    setLoad({ state: "ready", settings });
    setPaths(drafts(settings));
    onChange?.();
  };
  return (
    <section className="settings-block">
      <h3>Agent programs</h3>
      {load.state === "loading" && <Loading label="Checking agent programs…" />}
      {load.state === "error" && <Feedback error={load.message} />}
      {load.state === "ready" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void task.run(
              () =>
                apply(
                  api.saveHostAgentPaths({
                    claudePath: paths["claude-code"].trim() || null,
                    codexPath: paths.codex.trim() || null,
                  }),
                ),
              "Agent program paths saved.",
            );
          }}
        >
          <p className="hint">
            Passport searched {load.settings.pathSource.entries} folders on PATH (from{" "}
            {load.settings.pathSource.label}). If a program is installed but not found, enter its
            full path, for example the output of <code>which claude</code>.
          </p>
          {programs.map(({ kind, name, field }) => {
            const agent = load.settings.agents.find((a) => a.kind === kind),
              status = agentStatus(agent),
              environment = load.settings.paths[kind].environment;
            return (
              <div className="host-agent-program" key={kind}>
                <strong>{name}</strong>
                <small className={`agent-status ${status.tone}`}>
                  <span className="status-dot" aria-hidden="true" />
                  {status.text}
                </small>
                <small className="muted path">{agent?.binaryPath ?? "Not found"}</small>
                <label className="field">
                  {name} path
                  <input
                    name={field}
                    value={environment ?? paths[kind]}
                    disabled={!!environment}
                    placeholder="Found automatically"
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(e) => setPaths({ ...paths, [kind]: e.target.value })}
                  />
                </label>
                {environment && (
                  <p className="hint">
                    Set by <code>{envNames[kind]}</code> in the server environment.
                  </p>
                )}
              </div>
            );
          })}
          <Feedback error={task.error} />
          <div className="form-actions">
            <button
              type="button"
              className="btn"
              disabled={task.busy}
              onClick={() =>
                void task.run(
                  () => apply(api.redetectHostAgents()),
                  "Looked for agent programs again.",
                )
              }
            >
              Re-detect
            </button>
            <button className="btn btn-primary" disabled={task.busy}>
              {task.busy ? "Saving…" : "Save paths"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
