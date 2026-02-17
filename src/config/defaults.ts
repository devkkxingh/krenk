export interface KrenkConfig {
  maxParallelAgents: number;
  claudePath: string;
  workflow: string[];
  skipStages: string[];
  agents: Record<string, { maxTurns?: number; model?: string }>;
}

export const DEFAULT_CONFIG: KrenkConfig = {
  maxParallelAgents: 3,
  claudePath: 'claude',
  workflow: ['plan', 'design', 'architect', 'code', 'test', 'review', 'docs'],
  skipStages: [],
  agents: {
    analyst: { maxTurns: 50 },
    strategist: { maxTurns: 50 },
    designer: { maxTurns: 50 },
    architect: { maxTurns: 75 },
    builder: { maxTurns: 150 },
    qa: { maxTurns: 60 },
    guardian: { maxTurns: 75 },
    sentinel: { maxTurns: 50 },
    security: { maxTurns: 50 },
    scribe: { maxTurns: 50 },
    devops: { maxTurns: 60 },
  },
};
