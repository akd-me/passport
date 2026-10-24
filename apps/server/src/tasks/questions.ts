import {
  SUBTASK_LIMITS,
  type StoreTasks,
  type Task,
  type TaskAskInput,
  type TaskAskResult,
  type TaskPendingQuestion,
  type TaskRun,
  type TaskToolCaller,
} from "@passport/types";
import { ApiError } from "../errors.js";
import type { TaskQueueService } from "./queue.js";
import type { TaskService } from "./service.js";
import { resolveTaskStatus } from "./status.js";
import { clip, neutralize } from "./untrusted.js";

/** Where a subtask's question goes instead of the person (`TaskSubtasks.forwardQuestion`). */
export interface QuestionForwarding {
  forwardQuestion(child: Task, question: TaskPendingQuestion): Promise<void>;
}

/**
 * The prompt text of a message that answers questions: each question (JSON-quoted, it is model
 * text) and the answer. A subtask's answers come from its parent task's agent.
 */
export async function answeredRequest(
  tasks: StoreTasks,
  task: Task,
  answers: string[],
  text: string,
): Promise<string> {
  const asked = (await tasks.items.recent(task.id, ["question"], 50))
    .filter((item) => answers.includes(item.id))
    .reverse()
    .map((item) => (item.kind === "question" ? item.payload.text : ""))
    .filter(Boolean);
  if (!asked.length) {
    return text;
  }
  const who = task.delegation ? "Your parent task's answer" : "The person's answer";
  const questions = asked.map((question) => `- ${JSON.stringify(question)}`).join("\n");
  return `You asked:\n${questions}\n\n${who}:\n${text}`;
}

/**
 * `ask_user` questions (T3 pending `user_input` requests): a `question` item, the task's
 * `pendingQuestions` and `needsUser: "question"`. The answer is the next message of the task
 * (`POST …/questions/:itemId/answer`, or any message sent while a question is pending), so it
 * runs through the follow-up queue. A subtask's question goes to its parent task instead.
 */
export class TaskQuestions {
  forwarding?: QuestionForwarding;

  constructor(
    private readonly service: TaskService,
    private readonly queue: TaskQueueService,
  ) {}

  async ask(caller: TaskToolCaller, input: TaskAskInput): Promise<TaskAskResult> {
    const task = await this.service.task(caller.taskId);
    if ((task.pendingQuestions?.length ?? 0) >= SUBTASK_LIMITS.maxPendingQuestions) {
      throw new ApiError(
        "QUESTION_LIMIT",
        `At most ${SUBTASK_LIMITS.maxPendingQuestions} questions can wait for an answer; end your turn.`,
        409,
      );
    }
    const run = caller.runId ? await this.service.tasks.runs.byAgentRunId(caller.runId) : null;
    const text = clip(neutralize(input.text), 2000);
    const options = input.options
      ?.slice(0, SUBTASK_LIMITS.maxOptions)
      .map((option) => clip(neutralize(option), 200));
    const item = await this.service.runner.appendItem({
      taskId: task.id,
      runId: run?.taskId === task.id ? run.id : null,
      kind: "question",
      at: this.service.now(),
      // Model text that may quote mail.
      untrusted: true,
      payload: { text, ...(options?.length ? { options } : {}), blocking: input.blocking },
    });
    const question: TaskPendingQuestion = {
      itemId: item.id,
      runId: item.runId,
      text,
      ...(options?.length ? { options } : {}),
      blocking: input.blocking,
      askedAt: item.at,
    };
    const updated = await this.service.runner.updateTask(task.id, (current) => {
      const pendingQuestions = [...(current.pendingQuestions ?? []), question];
      return {
        pendingQuestions,
        ...resolveTaskStatus(
          { ...current, pendingQuestions },
          { kind: "question_asked", now: this.service.now() },
        ),
      };
    });
    if (updated.delegation && this.forwarding) {
      await this.forwarding.forwardQuestion(updated, question);
      return { itemId: item.id, status: "forwarded", blocking: input.blocking };
    }
    return { itemId: item.id, status: "pending", blocking: input.blocking };
  }

  /** `POST /api/tasks/:id/questions/:itemId/answer`: the answer is the task's next message. */
  async answer(
    taskId: string,
    itemId: string,
    text: string,
  ): Promise<{ task: Task; run: TaskRun }> {
    await this.pending(taskId, itemId);
    return this.queue.send(taskId, { text, mode: "queue" }, { answers: [itemId] });
  }

  /** `POST /api/tasks/:id/questions/:itemId/dismiss`: resolved without an answer. */
  async dismiss(taskId: string, itemId: string): Promise<Task> {
    const question = await this.pending(taskId, itemId);
    const task = await this.resolve(taskId, [itemId]);
    await this.service.runner.appendItem({
      taskId,
      runId: null,
      kind: "system_notice",
      at: this.service.now(),
      untrusted: true,
      payload: {
        text: `The question “${clip(question.text, 120)}” was dismissed without an answer.`,
        code: "QUESTION_DISMISSED",
      },
    });
    return task;
  }

  /** Drops questions nobody will answer (a cancelled subtask); returns the task. */
  resolve(taskId: string, itemIds: string[]): Promise<Task> {
    return this.service.runner.updateTask(taskId, (current) => {
      const pending = current.pendingQuestions ?? [];
      const left = pending.filter((question) => !itemIds.includes(question.itemId));
      if (left.length === pending.length) {
        return {};
      }
      return {
        pendingQuestions: left,
        ...resolveTaskStatus({ ...current, pendingQuestions: left }, { kind: "question_resolved" }),
      };
    });
  }

  /** The pending question, or 404 (no such question) / 409 (already answered or dismissed). */
  private async pending(taskId: string, itemId: string): Promise<TaskPendingQuestion> {
    const task = await this.service.task(taskId);
    const question = task.pendingQuestions?.find((entry) => entry.itemId === itemId);
    if (question) {
      return question;
    }
    const asked = await this.service.tasks.items.recent(taskId, ["question"], 500);
    if (asked.some((item) => item.id === itemId)) {
      throw new ApiError(
        "QUESTION_RESOLVED",
        "This question was already answered or dismissed",
        409,
      );
    }
    throw new ApiError("NOT_FOUND", "Question not found", 404);
  }
}
