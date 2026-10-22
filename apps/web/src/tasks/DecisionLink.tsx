import { useEffect, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { logger } from "../logger";
import { taskApi } from "./api";
import { useTasks } from "./store";

const approvalPath = (taskId: string, actionId: string) =>
  `/tasks/${encodeURIComponent(taskId)}?approval=${encodeURIComponent(actionId)}`;

/**
 * `?decision=<actionId>` (desktop notifications, `passport://decision/<id>`): open the task that
 * holds the action, with the approval selected. `GET /api/tasks/by-action/:id` answers first;
 * when it cannot (unknown action, older server), the loaded tasks' `pendingActionIds` are
 * searched, and otherwise the queue selects it.
 */
export function DecisionLink() {
  const [params] = useSearchParams(),
    location = useLocation(),
    navigate = useNavigate(),
    { tasks, loaded } = useTasks();
  const id = params.get("decision"),
    skip = !id || location.pathname === "/needs-you";
  const [unresolved, setUnresolved] = useState<string>();
  useEffect(() => {
    if (skip || !id) {
      return;
    }
    let cancelled = false;
    taskApi
      .byAction(id)
      .then(({ taskId }) => {
        if (typeof taskId !== "string" || !taskId) {
          throw new Error("No task for the action");
        }
        if (!cancelled) {
          navigate(approvalPath(taskId, id), { replace: true });
        }
      })
      .catch(() => {
        logger.warn("Action lookup failed; searching the loaded tasks");
        if (!cancelled) {
          setUnresolved(id);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [id, skip, navigate]);
  useEffect(() => {
    if (skip || !id || unresolved !== id || !loaded) {
      return;
    }
    const owner = tasks.find((task) => task.pendingActionIds?.includes(id));
    navigate(owner ? approvalPath(owner.id, id) : `/needs-you?decision=${encodeURIComponent(id)}`, {
      replace: true,
    });
  }, [id, skip, unresolved, loaded, tasks, navigate]);
  return null;
}
