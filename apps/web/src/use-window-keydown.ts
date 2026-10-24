import { useEffect, useLayoutEffect, useRef } from "react";

/**
 * A window `keydown` listener that always sees the latest render. The listener is registered
 * once; the handler it calls is swapped in a layout effect, which runs inside the commit. A
 * passive effect could run a frame later, so a key pressed right after a toast appeared (⌘Z)
 * would reach the handler from before it (R1-52).
 */
export function useWindowKeydown(handler: (event: KeyboardEvent) => void) {
  const latest = useRef(handler);
  useLayoutEffect(() => {
    latest.current = handler;
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => latest.current(event);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
