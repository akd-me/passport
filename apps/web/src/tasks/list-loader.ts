import type { Task } from "@passport/types";
import { queryString } from "../api";
import { taskApi } from "./api";

export const LIST_PAGE = 200;
export const SETTLED_PAGE = 50;
/** A runaway cursor must not page forever. */
const MAX_PAGES = 50;

/** Every page of a `GET /api/tasks` query, following `nextCursor`. */
export async function listAll(query: Record<string, unknown>): Promise<Task[]> {
  const tasks: Task[] = [];
  let cursor: string | null | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await taskApi.list(queryString({ ...query, limit: LIST_PAGE, cursor }));
    tasks.push(...result.items);
    cursor = result.nextCursor;
    if (!cursor) {
      break;
    }
  }
  return tasks;
}

/**
 * The sidebar's open tasks in full (R5-3): inbox first (what needs the person), then working and
 * snoozed, then pinned settled tasks. Unpinned settled tasks page in when their section opens.
 */
export async function listOpen(): Promise<Task[]> {
  const inbox = listAll({ status: ["inbox"] });
  const [first, rest, pinned] = await Promise.all([
    inbox,
    listAll({ status: ["working", "snoozed"] }),
    listAll({ status: ["settled"], pinned: true }),
  ]);
  return [...first, ...rest, ...pinned];
}

/** One page of settled tasks; `limit` lets a refresh refetch what is already shown. */
export const listSettled = (cursor?: string | null, limit = SETTLED_PAGE) =>
  taskApi.list(queryString({ status: ["settled"], limit: Math.min(limit, 500), cursor }));

/** What `listOpen` returns; anything else in the store survives its refetch. */
export const isOpen = (task: Task) =>
  task.status !== "archived" && (task.pinned || task.status !== "settled");
