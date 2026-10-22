import { render, screen } from "@testing-library/react";
import { Route, Routes, useLocation } from "react-router";
import { describe, expect, it } from "vitest";
import { Harness, stubApi } from "../test-utils";
import { DecisionLink } from "./DecisionLink";
import { TasksProvider } from "./store";
import { task } from "./test-fixtures";

function Where() {
  const location = useLocation();
  return <output aria-label="location">{`${location.pathname}${location.search}`}</output>;
}

function open(path: string, byAction?: Record<string, string>) {
  const fetchMock = stubApi({
    "/tasks/by-action": (url: URL) => {
      const owner = byAction?.[decodeURIComponent(url.pathname.split("/").at(-1) ?? "")];
      return owner
        ? { taskId: owner, runId: null }
        : Response.json({ error: { code: "NOT_FOUND", message: "Not found" } }, { status: 404 });
    },
    "/tasks": {
      items: [
        task("t-other", { pendingActionIds: ["a-9"] }),
        task("t-owner", { needsUser: "approval", pendingActionIds: ["a-1", "a-2"] }),
      ],
      total: 2,
    },
  });
  render(
    <Harness path={path}>
      <TasksProvider>
        <DecisionLink />
        <Routes>
          <Route path="*" element={<Where />} />
        </Routes>
      </TasksProvider>
    </Harness>,
  );
  return fetchMock;
}

describe("decision deep links", () => {
  it("opens the task whose pending approvals hold the action, with it selected", async () => {
    open("/?decision=a-2");
    expect(
      await screen.findByText("/tasks/t-owner?approval=a-2", undefined, { timeout: 2000 }),
    ).toBeInTheDocument();
  });

  it("falls back to the Needs you queue when no loaded task owns it", async () => {
    open("/matters?decision=a-404");
    expect(await screen.findByText("/needs-you?decision=a-404")).toBeInTheDocument();
  });

  it("deep link: asks the server which task holds the action before searching", async () => {
    // a-77 is in no loaded task (an older run, or a settled task outside the sidebar).
    const fetchMock = open("/?decision=a-77", { "a-77": "t-far" });
    expect(await screen.findByText("/tasks/t-far?approval=a-77")).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes("/api/tasks/by-action/a-77")),
    ).toBe(true);
  });

  it("leaves other addresses alone", async () => {
    open("/activity");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByLabelText("location")).toHaveTextContent("/activity");
  });
});
