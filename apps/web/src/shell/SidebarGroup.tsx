import type { ReactNode } from "react";

export function Group({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="side-group" aria-label={title}>
      <div className="side-group-head">
        <h2>{title}</h2>
        {action}
      </div>
      <ul>{children}</ul>
    </section>
  );
}
