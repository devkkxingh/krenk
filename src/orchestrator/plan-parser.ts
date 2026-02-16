/**
 * Parses the Strategist's master plan to extract per-agent assignments.
 *
 * Looks for sections like:
 *   ### ASSIGN:BUILDER
 *   <task description>
 *
 * Returns a map of role → task string.
 */

export interface ParsedPlan {
  /** Raw full plan text */
  raw: string;
  /** Extracted per-agent assignments: role key → task description */
  assignments: Map<string, string>;
  /** Modules extracted for parallel coding */
  modules: string[];
  /** Overview section */
  overview: string;
}

const ROLE_KEY_MAP: Record<string, string> = {
  ANALYST: 'analyst',
  STRATEGIST: 'strategist',
  DESIGNER: 'designer',
  PIXEL: 'designer',
  ARCHITECT: 'architect',
  BLUEPRINT: 'architect',
  BUILDER: 'builder',
  QA: 'qa',
  'QA LEAD': 'qa',
  GUARDIAN: 'guardian',
  TESTER: 'guardian',
  SENTINEL: 'sentinel',
  REVIEWER: 'sentinel',
  SECURITY: 'security',
  SHIELD: 'security',
  SCRIBE: 'scribe',
  DOCS: 'scribe',
  DOCUMENTATION: 'scribe',
  DEVOPS: 'devops',
  DEPLOY: 'devops',
  DEPLOYMENT: 'devops',
};

/**
 * Parse the strategist's plan output to extract agent assignments.
 */
export function parsePlan(planText: string): ParsedPlan {
  const assignments = new Map<string, string>();

  // Extract ASSIGN sections: ### ASSIGN:ROLENAME
  const assignRegex = /###\s*ASSIGN\s*:\s*(\w[\w\s]*?)[\n\r]([\s\S]*?)(?=###\s*ASSIGN\s*:|$)/gi;
  let match: RegExpExecArray | null;

  while ((match = assignRegex.exec(planText)) !== null) {
    const rawRole = match[1].trim().toUpperCase();
    const taskBody = match[2].trim();

    const roleKey = ROLE_KEY_MAP[rawRole];
    if (roleKey && taskBody) {
      assignments.set(roleKey, taskBody);
    }
  }

  // Extract modules for parallel coding
  const modules = extractModules(planText);

  // Extract overview
  const overview = extractSection(planText, 'OVERVIEW') || '';

  return {
    raw: planText,
    assignments,
    modules,
    overview,
  };
}

/**
 * Get the assignment for a specific agent, or fall back to a generic prompt.
 */
export function getAgentTask(plan: ParsedPlan, role: string, fallbackPrompt: string): string {
  const assignment = plan.assignments.get(role);

  if (assignment) {
    return `You have been assigned the following tasks by the team Strategist:\n\n${assignment}\n\nHere is the full plan for context:\n\n${plan.raw}`;
  }

  // No specific assignment — use the fallback but still include the plan as context
  return `${fallbackPrompt}\n\nHere is the master plan from the Strategist:\n\n${plan.raw}`;
}

/**
 * Extract MODULE sections from architect output.
 */
function extractModules(text: string): string[] {
  const moduleRegex = /### MODULE:\s*(.+?)(?:\n|$)([\s\S]*?)(?=### MODULE:|$)/g;
  const modules: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = moduleRegex.exec(text)) !== null) {
    const moduleName = match[1].trim();
    const moduleBody = match[2].trim();
    modules.push(`${moduleName}\n${moduleBody}`);
  }

  return modules;
}

/**
 * Extract a named section from markdown text.
 */
function extractSection(text: string, sectionName: string): string | null {
  // Match ## SECTIONNAME or # SECTIONNAME or **SECTIONNAME**
  const regex = new RegExp(
    `(?:#{1,3}\\s*(?:\\d+\\.?\\s*)?${sectionName}[:\\s]*\\n)([\\s\\S]*?)(?=\\n#{1,3}\\s|$)`,
    'i'
  );
  const match = regex.exec(text);
  return match ? match[1].trim() : null;
}
