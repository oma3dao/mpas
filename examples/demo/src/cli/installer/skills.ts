/**
 * Returns the prime-directive block from a role SKILL.md: the fenced markdown
 * block that starts with "## Prime Directive", without the fence.
 */
export function extractPreamble(skillMarkdown: string): string {
  const match = /```markdown\n(## Prime Directive[\s\S]*?)\n```/.exec(skillMarkdown);
  if (!match) {
    throw new Error("SKILL.md has no prime directive block.");
  }
  return `${match[1].trimEnd()}\n`;
}
