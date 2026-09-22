/**
 * Pure content scanners (no external dependencies) used to flag Golden items
 * that either try to instruct an AI (prompt injection) or expose secrets.
 *
 * Kept dependency-free so both the document converter (doc-convert.ts) and the
 * Golden store (golden.ts) can import it without pulling in mammoth/unpdf.
 */

/** Phrases that read as instructions to an agent rather than as policy. */
export const INJECTION_PATTERNS: Array<[RegExp, string]> = [
  [/\bignore\s+(all\s+)?(previous|prior|above)\s+(instructions|rules|prompts)\b/i, "tells the reader to ignore previous instructions"],
  [/\byou\s+are\s+(now\s+)?(an?\s+)?(AI|assistant|language model|chatbot)\b/i, "addresses the reader as an AI assistant"],
  [/\b(system|developer)\s+prompt\b/i, "refers to a system or developer prompt"],
  [/\bdisregard\s+(the\s+)?(rules|guardrails|policy|restrictions)\b/i, "tells the reader to disregard rules"],
  [/\b(jailbreak|prompt\s+injection|DAN\s+mode)\b/i, "mentions jailbreaking or prompt injection"],
  [/\bdo\s+not\s+(tell|inform|mention\s+to)\s+the\s+user\b/i, "asks the reader to withhold information from the user"],
];

/**
 * Patterns that indicate a leaked secret / credential. The matched VALUE is
 * never echoed back — only the type is reported (report location, not the secret).
 */
export const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/, "contains a private key block"],
  [/\bAKIA[0-9A-Z]{16}\b/, "contains an AWS access key ID"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/, "contains a GitHub access token"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, "contains a Slack token"],
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}\b/, "contains an API key (sk-… style)"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}\b/, "contains a JWT"],
  [/\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|mariadb|redis|amqp):\/\/[^\s/:@]+:[^\s/:@]+@/i, "contains a database connection string with an embedded password"],
  [/\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|client[_-]?secret|private[_-]?key)\b\s*[:=]\s*['"]?\S{4,}/i, "contains a credential assignment (password / secret / API key / token)"],
];

function firstMatch(patterns: Array<[RegExp, string]>, text: string, withSnippet: boolean): string[] {
  const hits: string[] = [];
  for (const [re, why] of patterns) {
    const m = re.exec(text);
    if (!m) continue;
    if (withSnippet) {
      const at = Math.max(0, m.index - 40);
      hits.push(`${why} — near: "${text.slice(at, m.index + m[0].length + 40).replace(/\s+/g, " ").trim()}"`);
    } else {
      hits.push(why); // never echo the secret value itself
    }
  }
  return hits;
}

export function scanForInjection(text: string): string[] {
  return firstMatch(INJECTION_PATTERNS, text, true);
}

export function scanForSecrets(text: string): string[] {
  return firstMatch(SECRET_PATTERNS, text, false);
}

/** All flaggable issues in the content — prompt injection AND secrets. */
export function scanContent(text: string): string[] {
  return [...scanForInjection(text), ...scanForSecrets(text)];
}
