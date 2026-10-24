import { render } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { describe, expect, it } from "vitest";
import { useWindowKeydown } from "./use-window-keydown";

function Listener({ value, seen }: { value: number; seen: number[] }) {
  useWindowKeydown(() => seen.push(value));
  return null;
}

/** Presses a key inside the commit, before passive effects run: the earliest a person can. */
function PressOnCommit({ value }: { value: number }) {
  useLayoutEffect(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "z" }));
  }, [value]);
  return null;
}

describe("useWindowKeydown", () => {
  it("R1-52: a key pressed right after a render reaches that render's handler", () => {
    const seen: number[] = [];
    const tree = (value: number) => (
      <>
        <Listener value={value} seen={seen} />
        <PressOnCommit value={value} />
      </>
    );
    const { rerender } = render(tree(1));
    rerender(tree(2));
    rerender(tree(3));
    // The first press lands before the listener is attached on mount; every later one sees the
    // value of the render that just committed, never the one before it.
    expect(seen).toEqual([2, 3]);
  });
});
