// Order matters — earlier patterns run first. Token-shaped strings get hit before
// generic value-eaters can swallow them.

const PATTERNS: Array<[RegExp, string]> = [
  // GitHub PATs / OAuth tokens (ghp_, gho_, ghu_, ghs_, ghr_)
  [/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, "$1_***"],

  // OpenAI keys
  [/\bsk-[A-Za-z0-9_-]{20,}\b/g, "sk-***"],

  // Slack tokens
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "xox-***"],

  // AWS access key IDs
  [/\bAKIA[0-9A-Z]{16}\b/g, "AKIA***"],

  // Long hex secrets after Token: / Key: / Secret: header-style (X-*-Token: hex...)
  [/\b([A-Za-z0-9_-]*(?:Token|Key|Secret|Apikey|Api-Key))\s*[:=]\s*[A-Fa-f0-9]{16,}\b/gi, "$1: ***"],

  // Bearer / Basic auth header values — stop at whitespace OR quote
  [/((?:Authorization|X-[A-Za-z0-9-]+-Auth)\s*:\s*(?:Bearer|Basic)\s+)[^\s"'`]+/gi, "$1***"],

  // Generic *-Token: <value> headers (catch X-Emby-Token, X-API-Token, etc)
  [/\b([Xx]-[A-Za-z0-9-]*-?(?:Token|Key|Secret|Auth|ApiKey))\s*:\s*[^\s"'`]+/g, "$1: ***"],

  // ENV-style assignments where var name contains TOKEN/KEY/SECRET/PASSWORD/etc.
  // Capture the *full* var name (not just the keyword).
  [/\b([A-Z][A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD|PWD|API_KEY)[A-Z0-9_]*)\s*=\s*[^\s"'`]+/g, "$1=***"],

  // Long-form CLI flags: --token=val, --api-key val, -k val
  [/(--?(?:token|api[-_]?key|secret|password|passwd|pwd))[= ][^\s"'`]+/gi, "$1=***"],

  // URL basic-auth: https://user:pass@host
  [/(https?:\/\/)([^:\s/]+):([^@\s]+)@/g, "$1$2:***@"],

  // JWT-shaped strings (header.payload.sig in base64url)
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "eyJ***.***.***"],
];

export function redact(s: string): string {
  let out = s;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

export function looksSensitive(s: string): boolean {
  return PATTERNS.some(([re]) => { re.lastIndex = 0; return re.test(s); });
}
