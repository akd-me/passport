import { useEffect } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { useTasks } from "./store";

/**
 * `?decision=<actionId>` (desktop notifications, `passport://decision/<id>`): open the task whose
 * `pendingActionIds` holds the action, with the approval selected. No route maps an action to its
 * task, so the loaded inbox and working tasks are searched; otherwise the queue selects it.
 */
export function DecisionLink() {
  const [params] = useSearchParams(),
    location = useLocation(),
    navigate = useNavigate(),
    { tasks, loaded } = useTasks();
  const id = params.get("decision");
  useEffect(() => {
    if (!id || !loaded || location.pathname === "/needs-you") {
      return;
    }
    const owner = tasks.find((task) => task.pendingActionIds?.includes(id));
    navigate(
      owner
        ? `/tasks/${encodeURIComponent(owner.id)}?approval=${encodeURIComponent(id)}`
        : `/needs-you?decision=${encodeURIComponent(id)}`,
      { replace: true },
    );
  }, [id, loaded, tasks, navigate, location.pathname]);
  return null;
}
