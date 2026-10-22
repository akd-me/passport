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

function open(path: string) {
  stubApi({
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

  it("leaves other addresses alone", async () => {
    open("/activity");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByLabelText("location")).toHaveTextContent("/activity");
  });
});
