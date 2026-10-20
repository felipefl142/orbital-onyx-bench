/** Pulls the strategy module out of a model reply: the fenced block that defines `control` / a default export. */
export function extractCode(reply: string): string | null {
  // Drop reasoning sections some local models leave in the content.
  const text = reply.replace(/<think>[\s\S]*?<\/think>/g, '');
  const blocks = [...text.matchAll(/```[ \t]*([a-zA-Z0-9_+-]*)[^\n]*\n([\s\S]*?)```/g)].map((m) => ({ lang: m[1].toLowerCase(), code: m[2] }));
  const looksRight = (c: string) => /export\s+default/.test(c) || /function\s+control\s*\(/.test(c);
  const js = blocks.filter((b) => ['js', 'javascript', 'mjs', 'ts', 'typescript', ''].includes(b.lang));
  const pick = js.filter((b) => looksRight(b.code)).sort((a, b) => b.code.length - a.code.length)[0] ?? blocks.filter((b) => looksRight(b.code))[0];
  if (pick) return pick.code.trim() + '\n';
  // An unterminated fence (reply cut off by max tokens) is still worth a validation attempt; it will report the error.
  const open = text.match(/```[ \t]*(?:js|javascript)?[^\n]*\n([\s\S]*)$/);
  if (open && looksRight(open[1])) return open[1].trim() + '\n';
  if (!blocks.length && looksRight(text)) return text.trim() + '\n';
  return null;
}
