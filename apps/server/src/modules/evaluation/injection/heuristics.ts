import type { HeuristicSeverity } from '../../authorization/signals.js';

/**
 * Deterministic prompt-injection heuristics over untrusted, agent-supplied
 * text. Fast, free, and immune to being "talked out of" a finding.
 *
 * Severity drives the decision directly (see combiner.ts):
 * - high   → BLOCK. Reserved for wording that only makes sense as an attempt
 *            to steer an AI: overriding *its* instructions, chat-template
 *            tokens, claims that *this* purchase was approved, "*your* limit
 *            was raised", hiding the purchase from the user, invisible tag
 *            characters. Harmless lookalikes ("do not ignore the safety
 *            instructions", "You are now subscribed", "## System requirements",
 *            store promotions, emoji flags) must not reach this level.
 * - medium → ESCALATE to a human. Suspicious but plausibly innocent.
 * - low    → recorded only; the AI layers decide.
 *
 * They are one layer among several: a miss here is not a guarantee of safety,
 * and every hit is shown to the user with the exact excerpt that triggered it.
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

const PURCHASE_OBJECT = String.raw`(this|the|that|these|my|our|all)\s+(purchases?|payments?|orders?|transactions?|charges?|checkouts?)`;
const AGENT_LIMIT = String.raw`(spending|budget|purchase|purchasing|transaction|payment|approval)\s+(limits?|caps?|polic(y|ies)|rules?|restrictions?)`;
const AI_INSTRUCTIONS = String.raw`(instructions?|prompts?|directives?|system\s+messages?)`;

// Patterns run on NFKC-normalised text with invisible characters removed, so
// full-width or zero-width-split variants of a phrase are still caught.
export const PHRASE_RULES: Rule[] = [
  // ── high: unambiguous attempts to steer an AI ──────────────────────────
  {
    id: 'instruction_override',
    severity: 'high',
    pattern: new RegExp(
      String.raw`\b(ignore|disregard|forget|override)\s+(all\s+|any\s+)?(of\s+)?(your|the|my)?\s*(previous|prior|above|earlier|preceding|original|initial|system)\s+(${AI_INSTRUCTIONS.slice(1, -1)}|rules|guidelines|context)\b` +
        String.raw`|\b(ignore|disregard|forget)\s+(all|any|your)\s+(of\s+)?(your\s+|the\s+)?${AI_INSTRUCTIONS}\b` +
        String.raw`|\b(ignore|disregard|bypass|override|circumvent)\s+(your|the\s+user'?s|leash'?s)\s+${AGENT_LIMIT}\b`,
      'i',
    ),
  },
  {
    id: 'template_tokens',
    severity: 'high',
    pattern: /<\|(im_start|im_end|system|assistant|endoftext)\|>|\[\/?INST\]|<<\/?SYS>>/i,
  },
  {
    id: 'new_instructions',
    severity: 'high',
    pattern: new RegExp(
      String.raw`\b(new|updated|revised|real|actual)\s+system\s+${AI_INSTRUCTIONS}` +
        String.raw`|\b(new|updated|revised)\s+${AI_INSTRUCTIONS}\s+(for|to)\s+(the\s+)?(ai|assistant|agent|llm|language\s+model)\b` +
        String.raw`|\byou\s+are\s+now\s+(an?\s+)?(unrestricted|unfiltered|jailbroken|uncensored)\b` +
        String.raw`|\byou\s+are\s+no\s+longer\s+(bound|restricted|limited)\s+by\b`,
      'i',
    ),
  },
  {
    id: 'claimed_approval',
    severity: 'high',
    pattern: new RegExp(
      String.raw`\b(user|owner|admin(istrator)?|human|account\s+holder|leash)\b[^.\n]{0,15}\b(has|have)?\s*(already\s+|pre-?)?(approved|authori[sz]ed|signed\s+off\s+on|whitelisted)\s+${PURCHASE_OBJECT}\b`,
      'i',
    ),
  },
  {
    id: 'limit_tampering',
    severity: 'high',
    pattern: new RegExp(
      String.raw`\byour\s+${AGENT_LIMIT}\s+(has|have|was|were|is|are)\s+(now\s+)?(been\s+)?(raised|increased|removed|lifted|disabled|waived|suspended|doubled)\b` +
        String.raw`|\byour\s+${AGENT_LIMIT}\s+(no\s+longer\s+appl(y|ies)|do(es)?\s+not\s+apply)\b`,
      'i',
    ),
  },
  {
    id: 'concealment',
    severity: 'high',
    pattern:
      /\b(do not|don't|never)\s+(tell|inform|notify|alert|mention\s+(this|it)\s+to)\s+(the\s+)?(user|owner|human|account\s+holder)\s+(about|that|of)\b[^.\n]{0,40}\b(purchases?|orders?|payments?|charges?|gift\s*cards?|upgrades?|subscriptions?|this)\b/i,
  },

  // ── medium: suspicious, but could be innocent → a human decides ───────
  {
    id: 'role_markers',
    severity: 'medium',
    pattern: /<\/?\s*(system|assistant)\s*>|^\s*(system|assistant)\s*:\s/im,
  },
  {
    id: 'claimed_authority',
    severity: 'medium',
    pattern:
      /\b(user|owner|admin(istrator)?|manager|boss|ceo|finance|accounting)\b[^.\n]{0,20}\b(already\s+)?(approved|authori[sz]ed|signed\s+off)\b[^.\n]{0,30}\b(purchases?|payments?|orders?|spend(ing)?|budget|invoices?)\b/i,
  },
  {
    id: 'limit_change_claim',
    severity: 'medium',
    pattern:
      /\b(spending|budget|approval)\s+(limits?|caps?|polic(y|ies))\b[^.\n]{0,20}\b(raised|increased|removed|lifted|disabled|waived|no longer appl(y|ies))\b/i,
  },
  {
    id: 'concealment_request',
    severity: 'medium',
    pattern:
      /\b(do not|don't|never)\s+(tell|inform|notify|alert)\s+(the\s+)?(user|owner|human|account\s+holder)\b/i,
  },
  {
    id: 'approval_demand',
    severity: 'medium',
    pattern: new RegExp(
      String.raw`\b(approve|authori[sz]e|execute)\s+${PURCHASE_OBJECT}\b[^.\n]{0,20}\b(now|immediately|automatically|without\s+(asking|approval|confirmation|review))\b`,
      'i',
    ),
  },
  {
    id: 'payee_redirection',
    severity: 'medium',
    pattern:
      /\b(send|transfer|wire|pay|remit)\b[^.\n]{0,40}\b(to|into|via)\b[^.\n]{0,40}\b(this|the following|our new|a different|another|updated)\b[^.\n]{0,20}\b(account|wallet|paypal|iban|bank details)\b/i,
  },
  {
    id: 'addresses_the_ai',
    severity: 'medium',
    pattern:
      /\b(attention|note|message|instructions?)\s+(to|for)\s+(the\s+|any\s+)?(ai|ai\s+agents?|ai\s+assistants?|llms?|language\s+models?|chatbots?)\b|\bif\s+you\s+are\s+an?\s+(ai|ai\s+agent|ai\s+assistant|llm|language\s+model)\b/i,
  },
  {
    id: 'hidden_text',
    severity: 'medium',
    // An element styled to be invisible that still carries readable text.
    pattern:
      /<[a-z][^>]*style\s*=\s*["'][^"']*(display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(px|pt|em|rem)?\b|opacity\s*:\s*0(\.0+)?\b)[^"']*["'][^>]*>\s*[^<\s][^<]{15,}/i,
  },

  // ── low: recorded for the reviewer; the AI layers decide ──────────────
  { id: 'html_comment', severity: 'low', pattern: /<!--[\s\S]{0,2000}?-->/ },
  { id: 'hidden_css', severity: 'low', pattern: /display\s*:\s*none|visibility\s*:\s*hidden/i },
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

/**
 * Removes the legitimate uses of invisible characters before they are judged:
 * a byte-order mark at the start, zero-width joiners inside emoji sequences
 * (e.g. family or rainbow-flag emoji), and the tag characters of subdivision
 * flags (e.g. the Scotland or Wales flag emoji).
 */
export function stripBenignInvisibles(text: string): string {
  return text
    .replace(/^\uFEFF/u, '')
    .replace(
      /(\p{Extended_Pictographic}[\uFE0E\uFE0F]?)\u200D(?=\p{Extended_Pictographic})/gu,
      '$1',
    )
    .replace(/\u{1F3F4}[\u{E0030}-\u{E0039}\u{E0061}-\u{E007A}]{2,7}\u{E007F}/gu, '\u{1F3F4}');
}

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

  for (const { source, text: original } of inputs) {
    if (!original) continue;
    const text = stripBenignInvisibles(original);

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
