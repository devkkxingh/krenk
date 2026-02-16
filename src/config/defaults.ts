export interface KrenkConfig {
  maxParallelAgents: number;
  claudePath: string;
  workflow: string[];
  skipStages: string[];
  agents: Record<string, { maxTurns?: number }>;
}

export const DEFAULT_CONFIG: KrenkConfig = {
  maxParallelAgents: 3,
  claudePath: 'claude',
  workflow: ['plan', 'design', 'architect', 'code', 'test', 'review', 'docs'],
  skipStages: [],
  agents: {
    analyst: { maxTurns: 30 },
    strategist: { maxTurns: 30 },
    designer: { maxTurns: 30 },
    architect: { maxTurns: 50 },
    builder: { maxTurns: 100 },
    qa: { maxTurns: 40 },
    guardian: { maxTurns: 50 },
    sentinel: { maxTurns: 30 },
    security: { maxTurns: 30 },
    scribe: { maxTurns: 30 },
    devops: { maxTurns: 40 },
  },
};
