/** Shell-style quoting so a command line survives storage and replay. */
function quoteToken(token: string): string {
  if (token.length > 0 && /^[A-Za-z0-9_@%+=:,./-]+$/.test(token)) return token;
  return `'${token.replaceAll("'", `'\\''`)}'`;
}

/** Joins a command and its arguments into a copy-pasteable, parseable string. */
export function quoteCommandLine(command: string, args: readonly string[]): string {
  return [command, ...args].map(quoteToken).join(' ');
}

/** Parses the stored command line back into command + args (single/double quotes). */
export function parseCommandLine(text: string): { command: string; args: string[] } {
  const tokens: string[] = [];
  let current = '';
  let quote: "'" | '"' | undefined;
  let started = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string;
    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined;
      } else if (char === '\\' && quote === '"' && index + 1 < text.length) {
        index += 1;
        current += text[index] as string;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '\\' && index + 1 < text.length) {
      index += 1;
      current += text[index] as string;
      started = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) {
        tokens.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }

  if (quote !== undefined) throw new Error(`unbalanced ${quote} quote in command line`);
  if (started) tokens.push(current);
  const [command, ...args] = tokens;
  if (command === undefined) throw new Error('empty command line');
  return { command, args };
}
