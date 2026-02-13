/**
 * Expand prompt variables defined as comma-separated lists inside curly braces.
 * Example: "a {red, blue} {cat, dog}" -> ["a red cat", "a red dog", "a blue cat", "a blue dog"]
 */
export function expandPromptTemplate(template: string): string[] {
  if (!template) return [];
  const regex = /\{([^{}]+)\}/g;
  const segments: string[] = [];
  const variables: string[][] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(template)) !== null) {
    segments.push(template.slice(lastIndex, match.index));
    const options = match[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    variables.push(options.length ? options : [""]);
    lastIndex = regex.lastIndex;
  }
  segments.push(template.slice(lastIndex));

  if (!variables.length) return [template];

  const results: string[] = [];
  const build = (idx: number, current: string) => {
    if (idx === variables.length) {
      results.push(current + segments[idx]);
      return;
    }
    for (const opt of variables[idx]) {
      build(idx + 1, current + segments[idx] + opt);
    }
  };
  build(0, "");
  return results;
}
