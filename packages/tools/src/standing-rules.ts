/** Edit only the level-two Standing rules section; preserve other USER.md sections verbatim. */
export function standingRules(markdown: string): {
  rules: string[];
  start: number;
  end: number;
  contentStart: number;
} {
  const heading = /^## Standing rules[ \t]*\r?$/im.exec(markdown);
  if (!heading)
    return {
      rules: [],
      start: markdown.length,
      end: markdown.length,
      contentStart: markdown.length,
    };
  const contentStart = heading.index + heading[0].length;
  const rest = markdown.slice(contentStart);
  const next = /^(?:#|##)[ \t]+/m.exec(rest);
  const end = next ? contentStart + next.index : markdown.length;
  const rules = markdown
    .slice(contentStart, end)
    .split(/\r?\n/)
    .flatMap((line) => {
      const match = /^[ \t]*[-*][ \t]+(.+)$/.exec(line);
      return match ? [match[1]!.trim()] : [];
    });
  return { rules, start: heading.index, contentStart, end };
}

export function editStandingRule(markdown: string, rule: string, remove: boolean): string {
  const section = standingRules(markdown);
  if (section.contentStart === markdown.length && section.start === markdown.length) {
    return remove
      ? markdown
      : `${markdown}${markdown && !markdown.endsWith("\n") ? "\n" : ""}\n## Standing rules\n- ${rule}\n`;
  }
  const content = markdown.slice(section.contentStart, section.end);
  if (remove) {
    return (
      markdown.slice(0, section.contentStart) +
      content.replace(/^[ \t]*[-*][ \t]+(.+)(?:\r?\n|$)/gm, (line, text: string) =>
        text.trim() === rule ? "" : line,
      ) +
      markdown.slice(section.end)
    );
  }
  if (section.rules.includes(rule)) return markdown;
  return (
    markdown.slice(0, section.end).replace(/\s*$/, "") +
    `\n- ${rule}\n\n` +
    markdown.slice(section.end)
  );
}
