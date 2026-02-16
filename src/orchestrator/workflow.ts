export type Stage =
  | 'analyzing'
  | 'planning'
  | 'designing'
  | 'architecting'
  | 'coding'
  | 'qa-planning'
  | 'testing'
  | 'reviewing'
  | 'securing'
  | 'documenting'
  | 'deploying'
  | 'complete';

export interface StageInfo {
  stage: Stage;
  role: string;
  label: string;
  emoji: string;
  description: string;
}

export const STAGES: StageInfo[] = [
  {
    stage: 'analyzing',
    role: 'analyst',
    label: 'Analyze',
    emoji: '@',
    description: 'Business analysis, user stories, and acceptance criteria',
  },
  {
    stage: 'planning',
    role: 'strategist',
    label: 'Plan',
    emoji: '>',
    description: 'Analyzing requirements and creating implementation plan',
  },
  {
    stage: 'designing',
    role: 'designer',
    label: 'Design',
    emoji: '*',
    description: 'Designing UI/UX and component structure',
  },
  {
    stage: 'architecting',
    role: 'architect',
    label: 'Architect',
    emoji: '#',
    description: 'Designing system architecture and creating project skeleton',
  },
  {
    stage: 'coding',
    role: 'builder',
    label: 'Code',
    emoji: '+',
    description: 'Implementing code modules in parallel',
  },
  {
    stage: 'qa-planning',
    role: 'qa',
    label: 'QA',
    emoji: '%',
    description: 'Creating test strategy and detailed test plans',
  },
  {
    stage: 'testing',
    role: 'guardian',
    label: 'Test',
    emoji: '~',
    description: 'Generating and running test suites',
  },
  {
    stage: 'reviewing',
    role: 'sentinel',
    label: 'Review',
    emoji: '?',
    description: 'Reviewing code for quality and correctness',
  },
  {
    stage: 'securing',
    role: 'security',
    label: 'Security',
    emoji: '!',
    description: 'Security audit and vulnerability assessment',
  },
  {
    stage: 'documenting',
    role: 'scribe',
    label: 'Docs',
    emoji: '=',
    description: 'Generating documentation',
  },
  {
    stage: 'deploying',
    role: 'devops',
    label: 'DevOps',
    emoji: '&',
    description: 'Setting up CI/CD and deployment configuration',
  },
  {
    stage: 'complete',
    role: '',
    label: 'Done',
    emoji: '+',
    description: 'Workflow complete',
  },
];

export const TRANSITIONS: Record<Stage, Stage | null> = {
  analyzing: 'planning',
  planning: 'designing',
  designing: 'architecting',
  architecting: 'coding',
  coding: 'qa-planning',
  'qa-planning': 'testing',
  testing: 'reviewing',
  reviewing: 'securing', // or back to 'coding' if NEEDS_REVISION
  securing: 'documenting',
  documenting: 'deploying',
  deploying: 'complete',
  complete: null,
};

/** Get the next stage, with optional revision loop */
export function getNextStage(
  current: Stage,
  needsRevision: boolean = false
): Stage | null {
  if ((current === 'reviewing' || current === 'securing') && needsRevision) {
    return 'coding';
  }
  return TRANSITIONS[current];
}

/** Get stage info by stage name */
export function getStageInfo(stage: Stage): StageInfo | undefined {
  return STAGES.find((s) => s.stage === stage);
}

/** Check if a stage should be skipped */
export function shouldSkipStage(
  stage: Stage,
  skipStages: string[]
): boolean {
  const info = getStageInfo(stage);
  if (!info) return false;
  return (
    skipStages.includes(stage) ||
    skipStages.includes(info.role) ||
    skipStages.includes(info.label.toLowerCase())
  );
}
