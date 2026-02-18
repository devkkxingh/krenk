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
| Architecture | Single process, one context | Separate OS processes per agent with dedicated roles |
| Agents | 1 (with ad-hoc subagents via Task tool) | Up to 11 specialized agents with enforced boundaries |
| Planning | Inline, ad-hoc | Dedicated Strategist creates a master plan with per-agent assignments |
| Architecture | Mixed with implementation | Dedicated Architect sets up project skeleton before Builder writes features |
| Code review | You review manually | Sentinel agent reviews code automatically for bugs, security, and quality |
| Testing | You write tests or ask | Guardian agent writes and runs comprehensive test suites |
| Security | Hope for the best | Shield agent performs a dedicated security audit |
| Human control | None mid-flow | Approval gates between every stage -- you see output before the next agent runs |
| Coordination | Single context window | Shared memory (.krenk/shared/) + explicit context handoff between agents |
| Supervision | None | Process Supervisor monitors memory, CPU, and kills hung agents |
| Recovery | Start over | Resume interrupted runs from last completed stage (`krenk --resume`) |
| Tool restrictions | All tools available always | Per-role enforcement -- read-only agents can't write, architect can only scaffold |

---

## How Krenk differs from Claude Code's subagents

Claude Code can spawn subagents internally via the Task tool. Here's how Krenk's approach is fundamentally different:

| | Claude Code subagents | Krenk |
|---|---|---|
| **Process model** | In-process function calls sharing memory | Separate OS processes with isolated contexts |
| **Roles** | None -- same capabilities, no restrictions | Typed roles with enforced tool restrictions per agent |
| **Flow** | Ad-hoc -- the model decides when to delegate | Structured pipeline -- analyst → strategist → architect → builder → QA → review |
| **Human oversight** | No approval gates mid-flow | You approve each stage after seeing what the previous agent produced |
| **Context** | Shared within one conversation window | Explicit handoff -- each agent receives curated context from prior stages |
| **Recovery** | None -- if it fails, start over | State persisted after each stage, resume from where it left off |
| **Supervision** | None | Memory, CPU, and timeout monitoring with automatic hung-process kills |
| **Planning** | Model plans implicitly | Dedicated strategist agent creates an explicit plan with per-agent task assignments |

Think of it this way: Claude Code's subagents are one developer talking to themselves. Krenk is a **managed team** with a PM (you) approving each phase.

---

## How it works

1. **You describe what you want to build** -- plain English, typos and all
2. **You choose project type** -- new project (agents won't search existing files) or existing project (agents analyze your codebase)
3. **You pick your team** -- full team, engineering-focused, QA-focused, or custom
4. **You choose the mode** -- autonomous (agents run freely) or supervised (you approve each stage)
5. **The Strategist creates a master plan** -- breaking work into tasks and assigning them to agents
6. **Agents execute in sequence** -- each one focused on its specialty, building on the previous agent's output
7. **You see output previews** -- after each agent completes, you see what it produced before approving the next
8. **The Supervisor watches everything** -- monitoring memory, CPU, and killing hung processes
9. **State is saved after each stage** -- if anything fails, resume with `krenk --resume`

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

### Install via npm

```bash
npm install -g krenk
```

### Install from source

```bash
git clone https://github.com/devkkxingh/krenk.git
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

### Resume a previous run

```bash
krenk --resume
```

Shows a list of previous runs with their status. Select one to continue from the last completed stage.

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
  |   |   |-- context.ts       # Accumulates output + state persistence for resume
  |   |   |-- workflow.ts      # Stage definitions and ordering
  |   |-- agents/
  |   |   |-- roles.ts         # Agent definitions: prompts, tools, boundaries
  |   |   |-- spawner.ts       # Spawns Claude CLI processes with stream-json
  |   |   |-- registry.ts      # Tracks active agents, PIDs, output
  |   |-- commands/
  |   |   |-- resume.ts        # Resume command: discovers and restores previous runs
  |   |-- ui/
  |   |   |-- interactive.ts   # Interactive CLI: project type, team selection, prompt
  |   |   |-- renderer.ts      # Real-time spinner with output previews
  |   |   |-- theme.ts         # Colors and gradients
  |   |-- config/
  |   |   |-- defaults.ts      # Default config: max turns, parallel agents
  |   |   |-- loader.ts        # Config file loader (cosmiconfig)
  |   |-- utils/
  |       |-- logger.ts        # Logging
  |       |-- process.ts       # Graceful shutdown
```

### Key design decisions

**Separate processes, not subagents** -- Each agent is a standalone `claude` CLI process. This gives true isolation: each agent has its own context window, tool restrictions, and system prompt. No shared state leakage between agents.

**Stream-JSON output** -- Agents use `--output-format stream-json` so the CLI shows real-time activity (which file is being read, which tool is being called) instead of a frozen spinner.

**Tool restrictions** -- Read-only agents (Strategist, Analyst, Sentinel) have `--disallowedTools Write,Edit,Bash` enforced at the CLI level so they cannot accidentally write code. The Architect can write files but its system prompt enforces skeleton-only output (configs, types, empty files -- no implementation code).

**Shared memory** -- All agents can read `.krenk/shared/` markdown files. The Master Brain writes directives to `brain.md`, agents write their progress. This lets later agents build on earlier agents' decisions without passing massive context strings.

**Process supervision** -- Every spawned Claude process is tracked. If an agent exceeds memory limits, runs longer than 15 minutes, or produces no output for 3 minutes, the Supervisor kills it and the Brain can retry.

**Per-stage state persistence** -- After each agent completes, the full pipeline state (completed stages, outputs, assignments) is saved to `.krenk/history/<runId>/state.json`. If the run fails or is interrupted, `krenk --resume` picks up from the last successful stage.

**Cross-platform** -- Works on macOS, Linux, and Windows. On Windows, agents spawn with `shell: true` to resolve `.cmd` extensions and use `taskkill` for process cleanup. On Unix, process groups with `detached: true` enable clean tree kills.

---

## Configuration

Create a `.krenkrc.json`, `.krenkrc.yml`, or `krenk.config.js` in your project root:

```json
{
  "maxParallelAgents": 3,
  "agents": {
    "strategist": { "maxTurns": 50 },
    "architect": { "maxTurns": 75 },
    "builder": { "maxTurns": 150, "model": "sonnet" },
    "guardian": { "maxTurns": 75 }
  }
}
```

The `model` field is optional -- only set it if you want a specific agent to use a different Claude model.

---

## Modes

**Autonomous** -- agents run without asking. Fastest path from prompt to project.

**Supervised** -- you approve each agent before it runs. You see what the previous agent produced and can approve, skip, or abort.

---

## License

MIT

---

Built by Krishna with mass amount of coffee.
