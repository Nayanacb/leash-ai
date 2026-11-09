import type { HeuristicSeverity } from '../../authorization/signals.js';

/**
 * Deterministic prompt-injection heuristics over untrusted, agent-supplied
 * text. Fast, free, and immune to being "talked out of" a finding. They are
 * one layer among several: a miss here is not a guarantee of safety, and a
 * hit is surfaced to the user with the exact excerpt that triggered it.
 */

export interface UntrustedText {
  /** Where the text came from, e.g. "justification", "sourceContext[2].content". */
  source: string;
  text: string;
}

export interface HeuristicFinding {
  source: string;
  rule: string;
  severity: Exclude<HeuristicSeverity, 'none'>;
  excerpt: string;
}

export interface HeuristicResult {
  severity: HeuristicSeverity;
  findings: HeuristicFinding[];
}

interface Rule {
  id: string;
  severity: Exclude<HeuristicSeverity, 'none'>;
  pattern: RegExp;
}

// Patterns run on NFKC-normalised text with invisible characters removed, so
// full-width or zero-width-split variants of a phrase are still caught.
const PHRASE_RULES: Rule[] = [
  {
    id: 'instruction_override',
    severity: 'high',
    pattern:
      /\b(ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|any|your|the|system)\b[^.\n]{0,25}\b(instructions?|prompts?|rules?|guidelines?|directions?|polic(y|ies)|restrictions?|limits?)\b/i,
  },
  {
    id: 'role_markers',
    severity: 'high',
    pattern:
      /<\/?\s*(system|assistant)\s*>|\[\/?INST\]|<\|im_(start|end)\|>|^\s*#{2,}\s*(system|instructions?)\b/im,
  },
  {
    id: 'new_instructions',
    severity: 'high',
    pattern:
      /\b(new|updated|revised|real|actual) (system )?(instructions?|directives?|orders?)\s*:|\byou are now\b|\bdeveloper mode\b|\bjailbreak\b/i,
  },
  {
    id: 'claimed_approval',
    severity: 'high',
    pattern:
      /\b(user|owner|admin(istrator)?|human|manager|leash)\b[^.\n]{0,20}\b(has|have)?\s*(already|pre-?)?\s*(approved|authori[sz]ed|confirmed|whitelisted)\b/i,
  },
  {
    id: 'limit_tampering',
    severity: 'high',
    pattern:
      /\b(spending|budget|purchase|transaction|approval)\s+(limits?|caps?|rules?|polic(y|ies))\b[^.\n]{0,20}\b(raised|increased|removed|lifted|disabled|waived|no longer appl(y|ies)|do(es)? not apply)\b/i,
  },
  {
    id: 'concealment',
    severity: 'high',
    pattern:
      /\b(do not|don't|never)\s+(tell|inform|notify|alert|mention (this )?to|ask)\s+(the\s+)?(user|owner|human|admin|operator)\b/i,
  },
  {
    id: 'approval_demand',
    severity: 'medium',
    pattern:
      /\b(approve|authori[sz]e|allow|complete|execute)\b[^.\n]{0,25}\b(this|the|all|my|these)\b[^.\n]{0,20}\b(purchase|payment|transaction|order)s?\b[^.\n]{0,20}\b(now|immediately|automatically|without)\b/i,
  },
  {
    id: 'payee_redirection',
    severity: 'medium',
    pattern:
      /\b(send|transfer|wire|pay|remit)\b[^.\n]{0,40}\b(to|into|via)\b[^.\n]{0,40}\b(this|the following|our new|a different|another)\b[^.\n]{0,20}\b(account|wallet|paypal|iban|address|email)\b/i,
  },
  {
    id: 'addresses_the_ai',
    severity: 'medium',
    pattern:
      /\b(attention|note|message|instructions?)\s+(to|for)\s+(the\s+)?(ai|assistant|agent|llm|model|bot|language model)\b|\bif you are an? (ai|assistant|agent|llm|language model)\b/i,
  },
  {
    id: 'hidden_css',
    severity: 'medium',
    pattern:
      /display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(px|pt|em|rem)?\b|opacity\s*:\s*0(\.0+)?\s*[;"]|color\s*:\s*(white|#fff(fff)?)\s*;?\s*background(-color)?\s*:\s*(white|#fff(fff)?)/i,
  },
  { id: 'html_comment', severity: 'low', pattern: /<!--[\s\S]{0,2000}?-->/ },
];

/** Long base64-looking runs (a common way to hide instructions). Real encodings mix cases and digits. */
function findEncodedBlob(text: string): RegExpExecArray | null {
  const runs = /[A-Za-z0-9+/]{200,}={0,2}/g;
  for (let m = runs.exec(text); m; m = runs.exec(text)) {
    if (/[A-Z]/.test(m[0]) && /[a-z]/.test(m[0]) && /[0-9]/.test(m[0])) return m;
  }
  return null;
}

/** Characters with no visible rendering that can hide or split text. */
const ZERO_WIDTH = /[\u200B-\u200D\u2060\u180E\uFEFF]/gu;
/** Bidirectional overrides: make text display in a different order than it is read. */
const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/gu;
/** Unicode "tag" characters: invisible ASCII look-alikes used to smuggle instructions. */
const TAG_CHARACTERS = /[\u{E0000}-\u{E007F}]/gu;

const RANK: Record<HeuristicSeverity, number> = { none: 0, low: 1, medium: 2, high: 3 };

function excerptAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, index + length + 40);
  const raw = `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
  // Excerpts are displayed to humans: make invisible characters visible and cap the length.
  return raw
    .replace(
      ZERO_WIDTH,
      (c) => `[U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}]`,
    )
    .replace(BIDI_CONTROLS, (c) => `[U+${c.codePointAt(0)!.toString(16).toUpperCase()}]`)
    .replace(TAG_CHARACTERS, '[TAG]')
    .slice(0, 200);
}

export function scanUntrustedText(inputs: readonly UntrustedText[]): HeuristicResult {
  const findings: HeuristicFinding[] = [];

  for (const { source, text } of inputs) {
    if (!text) continue;

    const hidden: [RegExp, string, HeuristicFinding['severity']][] = [
      [TAG_CHARACTERS, 'unicode_tag_characters', 'high'],
      [BIDI_CONTROLS, 'bidi_override', 'medium'],
      [ZERO_WIDTH, 'zero_width_characters', 'medium'],
    ];
    for (const [pattern, rule, severity] of hidden) {
      pattern.lastIndex = 0;
      const match = pattern.exec(text);
      if (match)
        findings.push({
          source,
          rule,
          severity,
          excerpt: excerptAround(text, match.index, match[0].length),
        });
    }
    if (text.includes('\u0000')) {
      findings.push({
        source,
        rule: 'nul_character',
        severity: 'medium',
        excerpt: '[NUL byte present]',
      });
    }

    const normalized = text
      .normalize('NFKC')
      .replace(ZERO_WIDTH, '')
      .replace(BIDI_CONTROLS, '')
      .replace(TAG_CHARACTERS, '')
      .replaceAll('\u0000', '');
    for (const rule of PHRASE_RULES) {
      const match = rule.pattern.exec(normalized);
      if (match) {
        findings.push({
          source,
          rule: rule.id,
          severity: rule.severity,
          excerpt: excerptAround(normalized, match.index, match[0].length),
        });
      }
    }
    const blob = findEncodedBlob(normalized);
    if (blob)
      findings.push({
        source,
        rule: 'encoded_blob',
        severity: 'low',
        excerpt: excerptAround(normalized, blob.index, 60),
      });
  }

  const severity = findings.reduce<HeuristicSeverity>(
    (max, f) => (RANK[f.severity] > RANK[max] ? f.severity : max),
    'none',
  );
  return { severity, findings: findings.slice(0, 50) };
}
