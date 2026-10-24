import type { Task, TaskPendingQuestion } from "@passport/types";
import { useState } from "react";
import { Markdown } from "../components/Markdown";
import { Feedback, Icon } from "../components/ui";
import { orchestrationApi } from "./orchestration-api";
import { useTasks } from "./store";

function Question({ task, question }: { task: Task; question: TaskPendingQuestion }) {
  const { upsert } = useTasks(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const act = async (work: () => Promise<Task>) => {
    setBusy(true);
    setError("");
    try {
      upsert(await work());
    } catch (e) {
      setError(e instanceof Error ? e.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  };
  const answer = (text: string) =>
    act(async () => (await orchestrationApi.answer(task.id, question.itemId, text)).task);
  return (
    <li className="question-card" data-question={question.itemId}>
      <p className="question-label">
        <Icon name="question" size={13} />
        {task.delegation ? "Asked of the parent task" : "Passport asks"}
        {question.blocking && <span className="muted"> · waiting for your answer</span>}
      </p>
      <Markdown text={question.text} className="agent-text" />
      <div className="question-actions">
        {question.options?.map((option) => (
          <button
            key={option}
            type="button"
            className="btn btn-sm"
            disabled={busy}
            onClick={() => void answer(option)}
          >
            {option}
          </button>
        ))}
        <button
          type="button"
          className="link-btn"
          disabled={busy}
          onClick={() => void act(() => orchestrationApi.dismiss(task.id, question.itemId))}
        >
          Dismiss
        </button>
      </div>
      <Feedback error={error} />
    </li>
  );
}

/**
 * Open `ask_user` questions, above the composer. Picking an option answers it; a message sent
 * from the composer answers every open question; Dismiss resolves it without an answer.
 */
export function QuestionCard({ task }: { task: Task }) {
  const questions = task.pendingQuestions ?? [];
  if (!questions.length) {
    return null;
  }
  return (
    <section className="question-panel" aria-label="Questions">
      <ul>
        {questions.map((question) => (
          <Question key={question.itemId} task={task} question={question} />
        ))}
      </ul>
      <p className="question-hint muted">Or type your answer below.</p>
    </section>
  );
}
