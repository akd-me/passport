import type { ActionRecord, ActionRequest, TaskRun } from "@passport/types";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type ApproveScope, api } from "../api";
import { logger } from "../logger";
import { useWorkspace, useWorkspaceEvents } from "../state";

export type LoadState = "loading" | "loaded" | "failed";
export type Decision =
  | { kind: "approve"; edited?: ActionRequest; scope?: ApproveScope }
  | { kind: "reject" };

export interface ActionsState {
  /** ActionRecords by id: open decisions plus the runs that were expanded. */
  records: Map<string, ActionRecord>;
  /** The `/decisions` request behind pending approvals. */
  pending: LoadState | "idle";
  /** `/api/actions?runId=` per agent run id, fetched when its change summary opens. */
  runs: Map<string, LoadState>;
  /** Fetch the open decisions when one of `ids` has no record (once per id). */
  ensurePending: (ids: string[]) => void;
  retryPending: () => void;
  loadRun: (run: TaskRun) => void;
  /** Action ids with a decision in flight, shared by every button for that action. */
  busy: Set<string>;
  /** Decided here; hidden until the task frame drops them from `pendingActionIds`. */
  decided: Set<string>;
  decide: (id: string, decision: Decision) => Promise<ActionRecord>;
}

const call = (id: string, decision: Decision) =>
  decision.kind === "approve" ? api.approve(id, decision.edited, decision.scope) : api.reject(id);

const none = new Set<string>();
const Actions = createContext<ActionsState>({
  records: new Map(),
  pending: "idle",
  runs: new Map(),
  ensurePending: () => {},
  retryPending: () => {},
  loadRun: () => {},
  busy: none,
  decided: none,
  decide: call,
});

const without = (set: Set<string>, id: string) => {
  const next = new Set(set);
  next.delete(id);
  return next;
};

/**
 * One cache of ActionRecords for the task views (R5-2). Nothing here refetches on a workspace
 * refresh: `action.*` frames patch records in place, the decisions are fetched when a pending id
 * has no record (and again after a reconnect), and a run's records when its summary opens.
 */
export function ActionsProvider({ children }: { children: ReactNode }) {
  const { reconnects } = useWorkspace();
  const [records, setRecords] = useState<Map<string, ActionRecord>>(() => new Map()),
    [pending, setPending] = useState<ActionsState["pending"]>("idle"),
    [runs, setRuns] = useState<Map<string, LoadState>>(() => new Map()),
    [busy, setBusy] = useState<Set<string>>(none),
    [decided, setDecided] = useState<Set<string>>(none);
  const asked = useRef(new Set<string>()),
    inflight = useRef<Promise<void> | null>(null),
    latest = useRef({ records, runs });
  latest.current = { records, runs };

  const put = useCallback((list: ActionRecord[]) => {
    if (list.length) {
      setRecords((current) => {
        const next = new Map(current);
        for (const record of list) {
          next.set(record.id, record);
        }
        return next;
      });
    }
  }, []);

  const fetchPending = useCallback(() => {
    if (inflight.current) {
      return;
    }
    setPending("loading");
    inflight.current = api
      .decisions()
      .then((page) => {
        put(page.items ?? []);
        setPending("loaded");
      })
      .catch(() => {
        logger.warn("Open decisions request failed");
        setPending("failed");
      })
      .finally(() => {
        inflight.current = null;
      });
  }, [put]);

  const ensurePending = useCallback(
    (ids: string[]) => {
      const missing = ids.filter((id) => !latest.current.records.has(id) && !asked.current.has(id));
      if (missing.length) {
        for (const id of missing) {
          asked.current.add(id);
        }
        fetchPending();
      }
    },
    [fetchPending],
  );

  const loadRun = useCallback(
    (run: TaskRun) => {
      const key = run.agentRunId,
        state = latest.current.runs.get(key);
      const complete = run.actionIds.every((id) => latest.current.records.has(id));
      if (!run.actionIds.length || state === "loading" || (state === "loaded" && complete)) {
        return;
      }
      setRuns((current) => new Map(current).set(key, "loading"));
      api
        .actions({ runId: key, limit: 200 })
        .then((page) => {
          put(page.items ?? []);
          setRuns((current) => new Map(current).set(key, "loaded"));
        })
        .catch(() => {
          logger.warn("Run actions request failed");
          setRuns((current) => new Map(current).set(key, "failed"));
        });
    },
    [put],
  );

  // Frames missed while offline: refetch the decisions and forget which runs were loaded.
  useEffect(() => {
    if (reconnects) {
      asked.current.clear();
      setRuns(new Map());
      fetchPending();
    }
  }, [reconnects, fetchPending]);

  useWorkspaceEvents((event) => {
    if (event.type.startsWith("action.") && "action" in event) {
      const record = event.action as ActionRecord;
      if (latest.current.records.has(record.id) || record.status === "proposed") {
        put([record]);
      }
    }
  });

  const decide = useCallback(
    async (id: string, decision: Decision) => {
      setBusy((current) => new Set(current).add(id));
      try {
        const record = await call(id, decision);
        if (record?.id) {
          put([record]);
        }
        setDecided((current) => new Set(current).add(id));
        return record;
      } finally {
        setBusy((current) => without(current, id));
      }
    },
    [put],
  );

  const value = useMemo<ActionsState>(
    () => ({
      records,
      pending,
      runs,
      ensurePending,
      retryPending: () => {
        asked.current.clear();
        fetchPending();
      },
      loadRun,
      busy,
      decided,
      decide,
    }),
    [records, pending, runs, ensurePending, fetchPending, loadRun, busy, decided, decide],
  );
  return <Actions.Provider value={value}>{children}</Actions.Provider>;
}

export const useActions = () => useContext(Actions);

/** Approve or reject one action; busy is shared with every other control for that action. */
export function useDecision(actionId: string) {
  const actions = useActions(),
    { refresh, notify } = useWorkspace();
  const [local, setLocal] = useState(false),
    [error, setError] = useState("");
  const busy = local || actions.busy.has(actionId);
  const decide = async (decision: Decision, message: string) => {
    if (busy) {
      return false;
    }
    setLocal(true);
    setError("");
    try {
      await actions.decide(actionId, decision);
      refresh();
      notify(message);
      return true;
    } catch (e) {
      logger.warn("Decision failed");
      setError(e instanceof Error ? e.message : "Please try again.");
      return false;
    } finally {
      setLocal(false);
    }
  };
  return { busy, error, decide };
}
