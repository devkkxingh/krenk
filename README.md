<p align="center">
  <img src="https://raw.githubusercontent.com/devkkxingh/krenk/main/public/img/main.png" alt="Krenk CLI" width="700" />
</p>

# Krenk

**Like Claude Code, but with a team.**

Krenk is a multi-agent software engineering CLI that orchestrates an entire team of specialized AI agents to build your project -- from planning to deployment. Instead of one AI doing everything, Krenk assigns the right job to the right agent, just like a real engineering team.

---

## Why Krenk over plain Claude Code?

Claude Code is powerful, but it's one agent doing everything: planning, coding, testing, reviewing, documenting. That's like asking a single developer to be the architect, the frontend engineer, the QA lead, the security auditor, and the tech writer -- all at once, in one context window.

**Krenk fixes this.**

| | Claude Code | Krenk |
|---|---|---|
| Agents | 1 | Up to 11 specialized agents |
| Planning | Inline, ad-hoc | Dedicated Strategist creates a master plan with per-agent assignments |
| Architecture | Mixed with implementation | Dedicated Architect sets up skeleton before Builder writes features |
| Code review | You review manually | Sentinel agent reviews code automatically for bugs, security, and quality |
| Testing | You write tests or ask | Guardian agent writes and runs comprehensive test suites |
| Security | Hope for the best | Shield agent performs a dedicated security audit |
| Coordination | Single context window | Master Brain coordinates agents via shared memory |
| Supervision | None | Process Supervisor monitors memory, CPU, and kills hung agents |
| Parallelism | Sequential | Parallel builders for independent modules |

**The result:** Higher quality output, faster execution for large projects, and specialized attention to each concern -- planning, design, architecture, implementation, testing, review, security, documentation, and deployment all get dedicated focus.

---

## How it works

1. **You describe what you want to build** -- plain English, typos and all
2. **Krenk refines your prompt** -- using Claude to extract requirements, tech stack, and structure
3. **The Strategist creates a master plan** -- breaking work into tasks and assigning them to agents
4. **Agents execute in sequence** -- each one focused on its specialty, building on the previous agent's output
5. **The Master Brain coordinates** -- sharing context, reviewing output, ordering redos if quality is low
6. **The Supervisor watches everything** -- monitoring memory, CPU, and killing hung processes

### The Team

| Agent | Role | What it does |
|---|---|---|
| **Analyst** | Business analysis | User stories, acceptance criteria, priorities |
| **Strategist** | Planning | Master plan with per-agent task assignments |
| **Pixel** | UI/UX design | Component hierarchy, layouts, styling specs |
| **Blueprint** | Architecture | System design, project skeleton, data models |
| **Builder** | Implementation | Writes the actual production code |
| **QA Lead** | Test planning | Test strategy, test cases, coverage matrix |
| **Guardian** | Testing | Writes and runs unit/integration tests |
| **Sentinel** | Code review | Reviews for bugs, performance, and style |
| **Shield** | Security audit | OWASP checks, dependency audit, auth review |
| **Scribe** | Documentation | README, API docs, inline comments |
| **DevOps** | Deployment | CI/CD, Docker, deployment configs |

Not every project needs all 11. Krenk lets you pick your team:

- **Full Team** -- all 11 agents
- **Engineering** -- plan, architect, code, test, review
- **QA Focused** -- plan, code, QA, test, review
- **Startup MVP** -- plan, architect, code, review, docs
- **Quick Build** -- plan and code only
- **Custom** -- pick your own agents

---

## Installation

### Prerequisites

- Node.js >= 20
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated

### Install from source

```bash
git clone https://github.com/yourusername/krenk.git
cd krenk
npm install
npm run build
npm link
```

### Run

```bash
krenk
```

That's it. The interactive UI walks you through everything.

---

## Architecture

```
krenk
  |-- src/
  |   |-- orchestrator/
  |   |   |-- engine.ts        # Main pipeline: runs agents through stages
  |   |   |-- brain.ts         # Master Brain: coordinates agents, reviews, redos
  |   |   |-- memory.ts        # Shared memory: .krenk/shared/ files all agents read/write
  |   |   |-- supervisor.ts    # Process watchdog: memory, CPU, timeout monitoring
  |   |   |-- plan-parser.ts   # Parses strategist output into per-agent assignments
  |   |   |-- scheduler.ts     # Parallel execution with concurrency control
  |   |   |-- context.ts       # Accumulates output from previous agents
  |   |   |-- workflow.ts      # Stage definitions and ordering
  |   |-- agents/
  |   |   |-- roles.ts         # Agent definitions: prompts, tools, boundaries
  |   |   |-- spawner.ts       # Spawns Claude CLI processes with stream-json
  |   |   |-- registry.ts      # Tracks active agents, PIDs, output
  |   |-- ui/
  |   |   |-- interactive.ts   # Interactive CLI: team selection, prompt, refinement
  |   |   |-- renderer.ts      # Real-time spinner with stream-json activity
  |   |   |-- theme.ts         # Colors and gradients
  |   |-- config/
  |   |   |-- defaults.ts      # Default config: max turns, parallel agents
  |   |   |-- loader.ts        # Config file loader (cosmiconfig)
  |   |-- utils/
  |       |-- logger.ts        # Logging
  |       |-- process.ts       # Graceful shutdown
```

### Key design decisions

**Stream-JSON output** -- Agents use `--output-format stream-json` so the CLI shows real-time activity (which file is being read, which tool is being called) instead of a frozen spinner.

**Tool restrictions** -- Read-only agents (Strategist, Analyst, Sentinel) have `--disallowedTools Write,Edit,Bash` enforced at the CLI level so they cannot accidentally write code.

**Shared memory** -- All agents can read `.krenk/shared/` markdown files. The Master Brain writes directives to `brain.md`, agents write their progress. This lets later agents build on earlier agents' decisions without passing massive context strings.

**Process supervision** -- Every spawned Claude process is tracked. If an agent exceeds 512MB memory, runs longer than 10 minutes, or produces no output for 5 minutes, the Supervisor kills it and the Brain can retry.

---

## Configuration

Create a `.krenkrc.json`, `.krenkrc.yml`, or `krenk.config.js` in your project root:

```json
{
  "maxParallelAgents": 3,
  "agents": {
    "strategist": { "maxTurns": 30 },
    "architect": { "maxTurns": 50 },
    "builder": { "maxTurns": 100 },
    "guardian": { "maxTurns": 50 }
  }
}
```

---

## Modes

**Autonomous** -- agents run without asking. Fastest path from prompt to project.

**Supervised** -- you approve each agent before it runs. You see what it will do and can skip or abort.

---

## License

MIT

---

Built by Krishna with mass amount of coffee.
