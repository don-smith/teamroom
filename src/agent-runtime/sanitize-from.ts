/**
 * Sanitize a `mail.from` value before interpolating it into an LLM prompt.
 *
 * `mail.from` is prefix-validated at the dispatcher boundary, but the
 * `externalId` portion (e.g. `channel:cli:<externalId>`) can be arbitrary
 * user-controlled text. This helper removes prompt-breaking characters
 * (newlines/carriage returns), escapes backticks and backslashes that could
 * be interpreted as prompt structure, trims whitespace, and caps length so
 * a very long injected value cannot dominate the context window.
 */
export function sanitizeMailFrom(from: string): string {
  return from
    .replace(/[\r\n\t]/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .trim()
    .slice(0, 200);
}
