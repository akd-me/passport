import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { Harness, stubApi } from "../test-utils";
import { Composer } from "./Composer";

function pendingRun() {
  let fail!: (error: Error) => void;
  const runAgent = vi
    .spyOn(api, "runAgent")
    .mockImplementation(() => new Promise((_resolve, reject) => (fail = reject)));
  return { runAgent, fail: (error: Error) => fail(error) };
}

function send(text: string) {
  const input = screen.getByLabelText("Instruction for Passport");
  fireEvent.change(input, { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Send instruction" }));
  return input;
}

describe("composer failures", () => {
  it("V2-15: a draft typed during a failed run is kept and the instruction can be retried", async () => {
    stubApi({});
    const run = pendingRun();
    render(
      <Harness>
        <Composer />
      </Harness>,
    );
    const input = send("First instruction");
    fireEvent.change(input, { target: { value: "Second draft already typed" } });
    await act(async () => run.fail(new Error("model unavailable")));
    expect(input).toHaveValue("Second draft already typed");
    expect(screen.getByRole("status")).toHaveTextContent("model unavailable");

    fireEvent.click(screen.getByRole("button", { name: "Retry: First instruction" }));
    expect(run.runAgent).toHaveBeenLastCalledWith({ instruction: "First instruction" });
    expect(input).toHaveValue("Second draft already typed");
  });

  it("V2-15: an untouched input gets the failed instruction back", async () => {
    stubApi({});
    const run = pendingRun();
    render(
      <Harness>
        <Composer />
      </Harness>,
    );
    const input = send("First instruction");
    expect(input).toHaveValue("");
    await act(async () => run.fail(new Error("model unavailable")));
    expect(input).toHaveValue("First instruction");
    expect(screen.queryByRole("button", { name: /^Retry/ })).toBeNull();
  });
});
