import tokens from "../styles/tokens.css?raw";
import { useUi } from "../ui-state";

const contentStyles = `
* { box-sizing: border-box; }
html { background: var(--canvas); color: var(--text); }
body { margin: 0; padding: 8px 0; font: 400 var(--t-m)/1.5 var(--font-ui); overflow-wrap: anywhere; }
h1,h2,h3,h4,h5,h6 { font-size: var(--t-l); font-weight: 500; line-height: 1.3; margin: 16px 0 8px; }
h1 { font-size: var(--t-xl); }
p,ul,ol,pre,blockquote { margin: 8px 0 16px; }
ul,ol { padding-left: 24px; }
table { border-collapse: collapse; width: 100%; margin: 16px 0; font-variant-numeric: tabular-nums; }
th,td { padding: 8px; text-align: left; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-weight: 500; color: var(--text-2); }
pre,code { font-family: var(--font-code); white-space: pre-wrap; }
blockquote { margin-left: 0; padding-left: 16px; border-left: 2px solid var(--line-strong); color: var(--text-2); }
hr { border: 0; border-top: 1px solid var(--line); margin: 16px 0; }
strong { font-weight: 500; }
.mail { font: 400 var(--t-l)/1.5 var(--font-mail); white-space: pre-wrap; }
.muted { color: var(--muted); } .num { font-variant-numeric: tabular-nums; }
`;

/** Only server-sanitised fragments enter this document. Nothing can load or execute in it. */
export function renderDocument(html: string, theme: "light" | "dark" | "system"): string {
  return `<!doctype html><html lang="en" data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><style>${tokens}\n${contentStyles}</style></head><body>${html}</body></html>`;
}

/** Empty sandbox means an opaque origin: no scripts, same-origin access, forms or navigation. */
export function RenderFrame({
  title,
  html,
  height,
  fullSize = false,
}: {
  title: string;
  html: string;
  height: number;
  fullSize?: boolean;
}) {
  const { theme } = useUi();
  return (
    <iframe
      title={title}
      className={`render-frame ${fullSize ? "full-size" : ""}`}
      tabIndex={0}
      sandbox=""
      srcDoc={renderDocument(html, theme)}
      referrerPolicy="no-referrer"
      style={fullSize ? undefined : { height: Math.min(1200, Math.max(80, height)) }}
    />
  );
}
