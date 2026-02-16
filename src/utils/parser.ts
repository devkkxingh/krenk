/**
 * Parse Claude Code JSON output to extract useful information
 */

export interface ClaudeOutput {
  result: string;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  duration?: number;
  model?: string;
}

/**
 * Parse the JSON output from `claude -p --output-format json`
 */
export function parseClaudeOutput(raw: string): ClaudeOutput {
  try {
    const parsed = JSON.parse(raw);
    return {
      result: parsed.result || raw,
      costUsd: parsed.cost_usd,
      inputTokens: parsed.input_tokens,
      outputTokens: parsed.output_tokens,
      duration: parsed.duration_ms,
      model: parsed.model,
    };
  } catch {
    // If not valid JSON, return raw text as the result
    return { result: raw };
  }
}

/**
 * Extract text content from potentially mixed JSON/text output.
 * Claude Code may output streaming text before the final JSON.
 */
export function extractResult(raw: string): string {
  // Try to find JSON at the end of the output
  const lastBrace = raw.lastIndexOf('}');
  if (lastBrace === -1) return raw;

  // Find matching opening brace
  let depth = 0;
  let start = -1;
  for (let i = lastBrace; i >= 0; i--) {
    if (raw[i] === '}') depth++;
    if (raw[i] === '{') depth--;
    if (depth === 0) {
      start = i;
      break;
    }
  }

  if (start === -1) return raw;

  try {
    const jsonStr = raw.substring(start, lastBrace + 1);
    const parsed = JSON.parse(jsonStr);
    return parsed.result || raw;
  } catch {
    return raw;
  }
}

/**
 * Extract cost information from Claude output
 */
export function extractCost(raw: string): { input: number; output: number } | null {
  try {
    const parsed = JSON.parse(raw);
    if (parsed.cost_usd !== undefined) {
      return { input: parsed.cost_usd, output: 0 };
    }
    if (parsed.input_tokens !== undefined && parsed.output_tokens !== undefined) {
      // Rough cost estimate based on Sonnet pricing
      return {
        input: (parsed.input_tokens / 1_000_000) * 3,
        output: (parsed.output_tokens / 1_000_000) * 15,
      };
    }
  } catch {
    // Not JSON
  }
  return null;
}
