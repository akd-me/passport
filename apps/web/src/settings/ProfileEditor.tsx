import { useState } from "react";
import { api } from "../api";
import { useTask } from "../state";
import { Feedback } from "../components/ui";

/** USER.md: tone, preferences and standing instructions the agent follows. */
export function ProfileEditor({ markdown }: { markdown: string }) {
  const [body, setBody] = useState(markdown),
    task = useTask();
  return (
    <form
      className="settings-block"
      onSubmit={(e) => {
        e.preventDefault();
        void task.run(
          () => api.saveProfile(body),
          "Standing instructions saved.",
        );
      }}
    >
      <h3>Standing instructions</h3>
      <p className="hint">
        How you write, who matters, what never to do. Plain Markdown, saved as
        USER.md and read by every agent run.
      </p>
      <label className="sr-only" htmlFor="user-profile">
        USER.md standing instructions
      </label>
      <textarea
        id="user-profile"
        className="code-editor"
        rows={12}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        spellCheck={false}
      />
      <Feedback error={task.error} />
      <div className="form-actions">
        <button
          className="btn btn-primary"
          disabled={task.busy || body === markdown}
        >
          {task.busy ? "Saving…" : "Save instructions"}
        </button>
      </div>
    </form>
  );
}
