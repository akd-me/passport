import { ProviderError } from "./errors.js";

export interface XmlNode { name: string; text: string; children: XmlNode[] }
export function xmlEscape(value: string): string { return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;"); }
function decode(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, key: string) => {
    if (key.startsWith("#")) { const n = key[1] === "x" ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10); return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ""; }
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[key.toLowerCase()]!;
  });
}

/** Small namespace-insensitive WebDAV XML reader. DTDs/entities are deliberately rejected. */
export function parseXml(xml: string): XmlNode {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new ProviderError("INVALID_XML", "WebDAV XML must not contain a DTD");
  const root: XmlNode = { name: "root", text: "", children: [] }, stack = [root];
  for (const match of xml.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<\/([^>]+)>|<([^>]+)>|([^<]+)/g)) {
    const parent = stack[stack.length - 1]!;
    if (match[1] !== undefined) parent.text += match[1];
    else if (match[2]) {
      const name = match[2].trim().split(":").pop()!.toLowerCase();
      if (stack.length === 1 || parent.name !== name) throw new ProviderError("INVALID_XML", "Malformed WebDAV XML");
      stack.pop();
    } else if (match[3]) {
      const tag = match[3], name = tag.trim().split(/\s/)[0]!.replace(/\/$/, "").split(":").pop()!.toLowerCase();
      const node = { name, text: "", children: [] }; parent.children.push(node); if (!/\/\s*$/.test(tag)) stack.push(node);
    } else if (match[4]) parent.text += decode(match[4]);
  }
  if (stack.length !== 1 || root.children.length !== 1) throw new ProviderError("INVALID_XML", "Malformed WebDAV XML document");
  return root;
}
export function descendants(node: XmlNode, name: string): XmlNode[] { return node.children.flatMap(c => [...(c.name === name ? [c] : []), ...descendants(c, name)]); }
export function xmlText(node: XmlNode, name: string): string | undefined { return descendants(node, name)[0]?.text.trim(); }
