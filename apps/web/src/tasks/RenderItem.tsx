import type { TaskItem } from "@passport/types";
import { useState } from "react";
import { Dialog } from "../components/Dialog";
import { RenderFrame } from "./RenderFrame";

export function RenderItem({ item }: { item: Extract<TaskItem, { kind: "render" }> }) {
  const [fullSize, setFullSize] = useState(false);
  return (
    <section className="tl-render" aria-label={item.payload.title}>
      <div className="render-heading">
        <h3>{item.payload.title}</h3>
        <button type="button" className="link-btn" onClick={() => setFullSize(true)}>
          Open full size
        </button>
      </div>
      <RenderFrame {...item.payload} />
      {fullSize && (
        <Dialog
          title={item.payload.title}
          onClose={() => setFullSize(false)}
          className="render-dialog"
          size="lg"
        >
          <RenderFrame {...item.payload} fullSize />
        </Dialog>
      )}
    </section>
  );
}
