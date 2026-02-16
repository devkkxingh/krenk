import { cosmiconfig } from 'cosmiconfig';
import { DEFAULT_CONFIG, type KrenkConfig } from './defaults.js';

const MODULE_NAME = 'krenk';

/**
 * Load krenk config from .krenkrc, .krenkrc.json, package.json#krenk, etc.
 */
export async function loadConfig(cwd?: string): Promise<KrenkConfig> {
  const explorer = cosmiconfig(MODULE_NAME, {
    searchPlaces: [
      `.${MODULE_NAME}rc`,
      `.${MODULE_NAME}rc.json`,
      `.${MODULE_NAME}rc.yaml`,
      `.${MODULE_NAME}rc.yml`,
      `${MODULE_NAME}.config.js`,
      `${MODULE_NAME}.config.mjs`,
      'package.json',
    ],
  });

  try {
    const result = await explorer.search(cwd);
    if (result && result.config) {
      return mergeConfig(DEFAULT_CONFIG, result.config);
    }
  } catch {
    // Config file not found or invalid, use defaults
  }

  return { ...DEFAULT_CONFIG };
}

/**
 * Deep merge user config over defaults
 */
function mergeConfig(
  defaults: KrenkConfig,
  user: Partial<KrenkConfig>
): KrenkConfig {
  return {
    maxParallelAgents: user.maxParallelAgents ?? defaults.maxParallelAgents,
    claudePath: user.claudePath ?? defaults.claudePath,
    workflow: user.workflow ?? defaults.workflow,
    skipStages: user.skipStages ?? defaults.skipStages,
    agents: {
      ...defaults.agents,
      ...(user.agents || {}),
    },
  };
}
