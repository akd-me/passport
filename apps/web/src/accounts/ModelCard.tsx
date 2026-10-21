import type { HostAgentKind, HostAgentStatus, LlmConfig, LlmSelection } from "@passport/types";
import { request } from "../api";
import { useResource, useTask } from "../state";
import { Badge, Feedback } from "../components/ui";

type PublicLlm = Omit<LlmConfig, "apiKey"> & { configured?: boolean; selection?: LlmSelection };

const NAMES: Record<string, string> = { codex: "Codex", "claude-code": "Claude Code" };

/** Detected Claude Code / Codex subscriptions on the host; pick one without an API key. */
export function ModelCard({ llm, demo }: { llm: PublicLlm; demo: boolean }) {
  const agents = useResource<HostAgentStatus[]>("/host-agents"),
    task = useTask();
  const auto = (llm.selection ?? "auto") === "auto";
  const choose = (provider: HostAgentKind | "auto") =>
    task.run(
      () => request("/settings/llm", { method: "PUT", body: JSON.stringify({ provider }) }),
      provider === "auto" ? "Passport will use the best available agent." : `Passport will use ${NAMES[provider]}.`,
    );
  const current = NAMES[llm.provider]
    ? `${NAMES[llm.provider]} · ${llm.model}`
    : llm.configured
      ? `${llm.provider} · ${llm.model}`
      : "No agent yet";
  return (
    <section className="panel settings-panel">
      <div className="panel-heading">
        <div>
          <h2>Your agent</h2>
          <p className="subtle">
            Passport uses the Codex or Claude Code subscription already signed in on this computer. No API key needed.
          </p>
        </div>
        <button
          className="button secondary"
          disabled={task.busy}
          onClick={() => task.run(() => request("/host-agents?refresh=1"), "Checked this computer for agents.")}
        >
          Check again
        </button>
      </div>
      {demo && <div className="info-note">Demo mode uses a local toy agent; your choice applies to this session only.</div>}
      <p>
        <strong>In use:</strong> {current}
        {auto ? " (chosen automatically)" : ""}
      </p>
      <Feedback error={agents.error ?? task.error} />
      <ul className="doctor-checks">
        {(Array.isArray(agents.data) ? agents.data : []).map((agent) => (
          <li key={agent.kind}>
            <Badge tone={agent.ready ? "green" : "amber"}>{agent.ready ? "ready" : agent.installed ? "signed out" : "not installed"}</Badge>
            <div>
              <strong>{agent.label}</strong>
              <p>{agent.ready ? [agent.version, agent.account && `${agent.account} login`].filter(Boolean).join(" · ") : agent.fix}</p>
            </div>
            {agent.ready && (auto || llm.provider !== agent.kind) && (
              <button className="button secondary" disabled={task.busy} onClick={() => choose(agent.kind)}>
                Use {agent.label}
              </button>
            )}
          </li>
        ))}
      </ul>
      {!auto && (
        <button className="button secondary" disabled={task.busy} onClick={() => choose("auto")}>
          Choose automatically
        </button>
      )}
      <p className="subtle">Prefer an API key or a local model? Use the advanced settings below.</p>
    </section>
  );
}
