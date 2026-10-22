import type { Task } from "@passport/types";
import { Icon } from "../components/ui";
import { glyphOf, glyphText } from "./model";

const glyphIcon = {
  running: "spinner",
  watching: "watch",
  approval: "approval",
  failure: "alert",
  question: "question",
  idle: "",
};

/** The row's status mark, with its meaning for screen readers. */
export function TaskGlyph({ task, running = false }: { task: Task; running?: boolean }) {
  const glyph = glyphOf(task, running);
  return (
    <span className={`task-glyph ${glyph}`} title={glyphText[glyph] || undefined}>
      {glyph === "idle" ? (
        <span className="task-dot" aria-hidden="true" />
      ) : (
        <Icon name={glyphIcon[glyph]} size={13} />
      )}
      {glyphText[glyph] && <span className="sr-only">{glyphText[glyph]}</span>}
    </span>
  );
}
