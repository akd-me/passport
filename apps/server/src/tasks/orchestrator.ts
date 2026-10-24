import type { TaskOrchestrator } from "@passport/types";
import { ApiError } from "../errors.js";
import type { TaskOrganizer } from "./organize.js";
import type { TaskQuestions } from "./questions.js";
import type { TaskSubtasks } from "./subtasks.js";

/** Authored refusals reach the model as tool errors (`toolSafe`); anything else stays private. */
function toolSafe(error: unknown): never {
  if (error instanceof ApiError) {
    throw Object.assign(new Error(error.message), { code: error.code, toolSafe: true });
  }
  throw error;
}

/**
 * The host behind the W2A registry tools, handed to every task run as
 * `AgentRunOptions.orchestrator` (`TaskRunner.orchestrator`).
 */
export function taskOrchestrator(parts: {
  questions: TaskQuestions;
  subtasks: TaskSubtasks;
  organizer: TaskOrganizer;
}): TaskOrchestrator {
  const { questions, subtasks, organizer } = parts;
  return {
    ask: (caller, input) => questions.ask(caller, input).catch(toolSafe),
    delegate: (caller, input) => subtasks.delegate(caller, input).catch(toolSafe),
    status: (caller, taskId) => subtasks.status(caller, taskId).catch(toolSafe),
    cancel: (caller, taskId) => subtasks.cancel(caller, taskId).catch(toolSafe),
    organize: (caller, input) => organizer.organize(caller, input).catch(toolSafe),
  };
}
