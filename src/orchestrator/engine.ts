import { EventEmitter } from 'node:events';
import { ContextManager } from './context.js';
import { Scheduler } from './scheduler.js';
import {
  type Stage,
  STAGES,
  getNextStage,
  shouldSkipStage,
} from './workflow.js';
import { ROLES, type AgentRole } from '../agents/roles.js';
import { AgentRegistry } from '../agents/registry.js';
import {
  spawnClaudeAgent,
  killAllAgents,
  type AgentResult,
  type SpawnOptions,
} from '../agents/spawner.js';
import { logger } from '../utils/logger.js';
import { ProcessSupervisor, type SupervisorLimits } from './supervisor.js';
import { parsePlan, getAgentTask, type ParsedPlan } from './plan-parser.js';
import { MasterBrain } from './brain.js';

export interface PersistedState {
  prompt: string;
  completedStages: string[];
  skipStages: string[];
  status: 'running' | 'complete' | 'failed';
  runId: string;
  stageCount: number;
  duration: number;
  planAssignments: string[];
}

export interface EngineOptions {
  cwd: string;
  maxParallel: number;
  skipStages: string[];
  noUi: boolean;
  supervised: boolean;
  agentConfig?: Record<string, { maxTurns?: number; model?: string }>;
  supervisorLimits?: Partial<SupervisorLimits>;
  resumeRunId?: string;
  resumeCompletedStages?: string[];
  isNewProject?: boolean;
}

export interface EngineState {
  stage: Stage;
  stages: typeof STAGES;
  agents: AgentRegistry;
  activeAgent: string;
  currentOutput: string[];
  artifacts: string[];
  startTime: number;
  error?: string;
}

/**
 * Main orchestration engine that drives agents through the workflow.
 *
 * Architecture:
 *   Engine       — orchestrates stages, spawns agents
 *   MasterBrain  — top-level intelligence: shared memory, directives, reviews, redos
 *   SharedMemory — hybrid in-memory + .krenk/shared/ files all agents can read
 *   Supervisor   — watchdog: monitors memory, CPU, timeouts, kills runaways
 *   Scheduler    — parallel execution with concurrency control
 *   Registry     — tracks active agents, PIDs, output
 */
export class OrchestrationEngine extends EventEmitter {
  private context: ContextManager;
  private scheduler: Scheduler;
  private registry: AgentRegistry;
  private supervisor: ProcessSupervisor;
  private brain: MasterBrain;
  private opts: EngineOptions;
  private _stage: Stage = 'analyzing';
  private _currentOutput: string[] = [];
  private _activeAgent: string = '';
  private _artifacts: string[] = [];
  private _startTime: number = 0;
  private _revisionCount: number = 0;
  private readonly MAX_REVISIONS = 2;

  constructor(opts: EngineOptions) {
    super();
    this.opts = opts;
    this.context = new ContextManager(opts.cwd, opts.resumeRunId);
    this.scheduler = new Scheduler(opts.maxParallel);
    this.registry = new AgentRegistry();
    this.supervisor = new ProcessSupervisor(opts.supervisorLimits);
    this.brain = new MasterBrain(opts.cwd);

    // Register all roles
    for (const [key, role] of Object.entries(ROLES)) {
      this.registry.register(key, role.name, role.emoji, role.color);
    }

    // Forward supervisor events
    this.supervisor.on('stats', (stats) => this.emit('supervisor:stats', stats));
    this.supervisor.on('warning', (data) => this.emit('supervisor:warning', data));
    this.supervisor.on('killed', (data) => this.emit('supervisor:killed', data));

    // Forward brain events
    this.brain.on('brief', (data) => this.emit('director:brief', data));
    this.brain.on('review', (data) => this.emit('director:review', data));
    this.brain.on('intervention', (data) => this.emit('director:intervention', data));
    this.brain.on('directive', (data) => this.emit('director:directive', data));
    this.brain.on('decision', (data) => this.emit('brain:decision', data));
  }

  get state(): EngineState {
    return {
      stage: this._stage,
      stages: STAGES,
      agents: this.registry,
      activeAgent: this._activeAgent,
      currentOutput: this._currentOutput,
      artifacts: this._artifacts,
      startTime: this._startTime,
    };
  }

  /**
   * Run the full orchestration pipeline.
   *
   * Flow:
   *   1. Analyst analyzes the request
   *   2. Strategist creates a MASTER PLAN with per-agent assignments
   *   3. Plan is parsed → Director gets it
   *   4. For each agent:
   *      a. Director prepares a brief (plan assignment + learnings + guardrails)
   *      b. Agent runs (with real-time monitoring by Director)
   *      c. Director reviews output → accept / redo / skip
   *      d. If redo → re-run with Director's corrections
   *   5. Supervisor watches memory/CPU/timeouts throughout
   */
  async run(userPrompt: string): Promise<{ success: boolean; stages: number; duration: number }> {
    this._startTime = Date.now();
    let stageCount = 0;
    let plan: ParsedPlan | null = null;
    const completedStages: string[] = [];
    const resumeCompleted = new Set(this.opts.resumeCompletedStages || []);
    const isResume = resumeCompleted.size > 0;

    // On resume: load previous outputs into memory
    if (isResume && this.opts.resumeRunId) {
      await this.context.loadFromHistory(this.opts.resumeRunId);

      // Re-parse plan from strategist output if available
      const strategistOutput = this.context.get('strategist');
      if (strategistOutput) {
        plan = parsePlan(strategistOutput);
        this.brain.setPlan(plan);
      }
    }

    const saveProgress = async (status: 'running' | 'complete' | 'failed') => {
      const state: PersistedState = {
        prompt: userPrompt,
        completedStages,
        skipStages: this.opts.skipStages,
        status,
        runId: this.context.getRunId(),
        stageCount,
        duration: Math.round((Date.now() - this._startTime) / 1000),
        planAssignments: plan ? Array.from(plan.assignments.keys()) : [],
      };
      await this.context.saveStateToHistory(state);
    };

    const newProjectHint = this.opts.isNewProject
      ? '\n\nIMPORTANT: This is a NEW project. Do NOT search or read any existing files. Create your plan purely from the requirements above.'
      : '';

    try {
      // ── Stage 1: Business Analysis ──────────────────────────
      if (!this.shouldSkip('analyzing') && !resumeCompleted.has('analyzing')) {
        this.setStage('analyzing');
        const result = await this.runDirectedAgent(
          'analyst',
          `Analyze the following request and produce detailed user stories, acceptance criteria, and priorities:\n\n${userPrompt}${newProjectHint}`
        );
        await this.context.save('analyst', result.output);
        stageCount++;
        completedStages.push('analyzing');
        await saveProgress('running');
      }

      // ── Stage 2: Planning (MASTER PLAN) ─────────────────────
      if (!this.shouldSkip('planning') && !resumeCompleted.has('planning')) {
        this.setStage('planning');

        const analysisContext = this.context.get('analyst');
        const planPrompt = analysisContext
          ? `${userPrompt}\n\nBusiness Analysis:\n${analysisContext}${newProjectHint}`
          : `${userPrompt}${newProjectHint}`;

        const planResult = await this.runDirectedAgent('strategist', planPrompt);
        await this.context.save('strategist', planResult.output);
        stageCount++;
        completedStages.push('planning');

        // Parse the plan → Director gets the master plan
        plan = parsePlan(planResult.output);
        this.brain.setPlan(plan);

        logger.info(
          `Plan parsed: ${plan.assignments.size} agent assignments, ${plan.modules.length} modules`
        );
        this.emit('plan:parsed', {
          assignments: Array.from(plan.assignments.keys()),
          modules: plan.modules.length,
        });

        await saveProgress('running');
      }

      // ── Stage 3: Design ─────────────────────────────────────
      if (!this.shouldSkip('designing') && !resumeCompleted.has('designing') && this.needsDesign()) {
        this.setStage('designing');
        const prompt = plan
          ? getAgentTask(plan, 'designer', userPrompt)
          : userPrompt;
        const result = await this.runDirectedAgent('designer', prompt);
        await this.context.save('designer', result.output);
        stageCount++;
        completedStages.push('designing');
        await saveProgress('running');
      }

      // ── Stage 4: Architecture ───────────────────────────────
      if (!this.shouldSkip('architecting') && !resumeCompleted.has('architecting')) {
        this.setStage('architecting');
        const prompt = plan
          ? getAgentTask(plan, 'architect', userPrompt)
          : userPrompt;
        const result = await this.runDirectedAgent('architect', prompt);
        await this.context.save('architect', result.output);
        stageCount++;
        completedStages.push('architecting');

        // Update modules from architect output
        if (plan) {
          const archModules = this.extractModules(result.output);
          if (archModules.length > 0) {
            plan.modules = archModules;
          }
        }

        await saveProgress('running');
      }

      // ── Stage 5: Coding (phased for builder) ────────────────
      if (!this.shouldSkip('coding') && !resumeCompleted.has('coding')) {
        this.setStage('coding');
        const prompt = plan
          ? getAgentTask(plan, 'builder', userPrompt)
          : userPrompt;
        await this.runCodingStage(prompt, plan);
        stageCount++;
        completedStages.push('coding');
        await saveProgress('running');
      }

      // ── Stage 6: QA Planning ────────────────────────────────
      if (!this.shouldSkip('qa-planning') && !resumeCompleted.has('qa-planning')) {
        this.setStage('qa-planning');
        const prompt = plan
          ? getAgentTask(plan, 'qa', 'Create a comprehensive test strategy and detailed test plans.')
          : 'Create a comprehensive test strategy and detailed test plans for the codebase.';
        const result = await this.runDirectedAgent('qa', prompt);
        await this.context.save('qa', result.output);
        stageCount++;
        completedStages.push('qa-planning');
        await saveProgress('running');
      }

      // ── Stage 7: Testing ────────────────────────────────────
      if (!this.shouldSkip('testing') && !resumeCompleted.has('testing')) {
        this.setStage('testing');
        const prompt = plan
          ? getAgentTask(plan, 'guardian', 'Write and run comprehensive tests.')
          : 'Analyze the codebase and write comprehensive tests. Run them and report results.';
        const result = await this.runDirectedAgent('guardian', prompt);
        await this.context.save('guardian', result.output);
        stageCount++;
        completedStages.push('testing');
        await saveProgress('running');
      }

      // ── Stage 8: Code Review ────────────────────────────────
      if (!this.shouldSkip('reviewing') && !resumeCompleted.has('reviewing')) {
        this.setStage('reviewing');
        const prompt = plan
          ? getAgentTask(plan, 'sentinel', 'Review all code for bugs, security issues, and quality.')
          : 'Review all code in this project for bugs, security issues, and quality.';
        const review = await this.runDirectedAgent('sentinel', prompt);
        await this.context.save('sentinel', review.output);
        stageCount++;
        completedStages.push('reviewing');

        // Revision loop
        if (
          review.output.includes('NEEDS_REVISION') &&
          this._revisionCount < this.MAX_REVISIONS
        ) {
          this._revisionCount++;
          logger.info(`Revision ${this._revisionCount}/${this.MAX_REVISIONS} - fixing review issues`);
          this.setStage('coding');
          const fix = await this.runDirectedAgent(
            'builder',
            `Fix the following issues from code review:\n${review.output}`
          );
          await this.context.save('builder', fix.output);
          stageCount++;
        }

        await saveProgress('running');
      }

      // ── Stage 9: Security Audit ─────────────────────────────
      if (!this.shouldSkip('securing') && !resumeCompleted.has('securing')) {
        this.setStage('securing');
        const prompt = plan
          ? getAgentTask(plan, 'security', 'Perform a thorough security audit.')
          : 'Perform a thorough security audit of this project.';
        const secAudit = await this.runDirectedAgent('security', prompt);
        await this.context.save('security', secAudit.output);
        stageCount++;
        completedStages.push('securing');

        if (
          secAudit.output.includes('NEEDS_REVISION') &&
          this._revisionCount < this.MAX_REVISIONS
        ) {
          this._revisionCount++;
          logger.info(`Security revision ${this._revisionCount}/${this.MAX_REVISIONS}`);
          this.setStage('coding');
          const fix = await this.runDirectedAgent(
            'builder',
            `Fix the following security issues:\n${secAudit.output}`
          );
          await this.context.save('builder', fix.output);
          stageCount++;
        }

        await saveProgress('running');
      }

      // ── Stage 10: Documentation ─────────────────────────────
      if (!this.shouldSkip('documenting') && !resumeCompleted.has('documenting')) {
        this.setStage('documenting');
        const prompt = plan
          ? getAgentTask(plan, 'scribe', 'Write comprehensive documentation.')
          : 'Write comprehensive documentation for this project.';
        const result = await this.runDirectedAgent('scribe', prompt);
        await this.context.save('scribe', result.output);
        stageCount++;
        completedStages.push('documenting');
        await saveProgress('running');
      }

      // ── Stage 11: DevOps ────────────────────────────────────
      if (!this.shouldSkip('deploying') && !resumeCompleted.has('deploying')) {
        this.setStage('deploying');
        const prompt = plan
          ? getAgentTask(plan, 'devops', 'Set up CI/CD, Docker, and deployment.')
          : 'Set up CI/CD pipeline, Docker configuration, and deployment setup.';
        const result = await this.runDirectedAgent('devops', prompt);
        await this.context.save('devops', result.output);
        stageCount++;
        completedStages.push('deploying');
        await saveProgress('running');
      }

      this.setStage('complete');
      this.supervisor.stop();
      const duration = Math.round((Date.now() - this._startTime) / 1000);

      await saveProgress('complete');

      return { success: true, stages: stageCount, duration };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`Engine failed: ${msg}`);
      this.emit('error', error);

      await saveProgress('failed').catch(() => {});

      return {
        success: false,
        stages: stageCount,
        duration: Math.round((Date.now() - this._startTime) / 1000),
      };
    }
  }

  /**
   * Run only the planning stage
   */
  async runPlanOnly(userPrompt: string): Promise<AgentResult> {
    this._startTime = Date.now();
    this.setStage('planning');
    const plan = await this.runDirectedAgent('strategist', userPrompt);
    await this.context.save('strategist', plan.output);
    this.setStage('complete');
    return plan;
  }

  // ── Director-driven agent execution ─────────────────────

  /**
   * Run an agent through the full Director cycle:
   *   1. Director prepares brief (learnings + guardrails + cross-agent context)
   *   2. Agent runs (Director monitors output in real-time)
   *   3. Director reviews result → accept / redo
   *   4. If redo → re-run with Director's corrections
   */
  private async runDirectedAgent(role: string, basePrompt: string): Promise<AgentResult> {
    // Step 1: Director prepares the brief
    const briefedPrompt = this.brain.prepareBrief(role, basePrompt);

    // Step 2: Run the agent
    let result = await this.runSingleAgent(role, briefedPrompt);

    // Step 3: Director reviews the output
    const verdict = this.brain.reviewOutput(role, result);

    // Step 4: Handle redo if Director says so
    if (verdict.verdict === 'redo' && verdict.correction) {
      logger.info(`Director: redo ${role} — ${verdict.notes}`);
      this.emit('director:redo', { role, reason: verdict.notes });

      const redoPrompt = this.brain.prepareRedoPrompt(
        role,
        basePrompt,
        verdict.correction
      );
      result = await this.runSingleAgent(role, redoPrompt);

      // Review again (but won't redo twice — Director tracks count)
      this.brain.reviewOutput(role, result);
    }

    return result;
  }

  /**
   * Run coding stage with phased execution and parallel modules.
   *
   * For the builder, the Director can split work into phases:
   *   Phase 1: Setup (structure, deps, configs)
   *   Phase 2: Core implementation
   *   Phase 3: Polish (error handling, edge cases)
   *
   * Between each phase, the Director reviews and can course-correct.
   */
  private async runCodingStage(builderPrompt: string, plan: ParsedPlan | null): Promise<void> {
    let modules: string[] = plan?.modules || [];
    if (modules.length === 0) {
      const archOutput = this.context.get('architect') || '';
      modules = this.extractModules(archOutput);
    }

    if (modules.length > 1) {
      // Parallel coding — multiple builders, each gets a module
      logger.info(`Found ${modules.length} modules - spawning parallel builders`);

      const builderRole = ROLES.builder;
      const contextStr = this.context.buildContext('builder');

      // Director prepares the base brief for all builders
      const briefedPrompt = this.brain.prepareBrief('builder', builderPrompt);

      const spawnOpts: SpawnOptions[] = modules.map((mod, i) => ({
        role: `builder-${i}`,
        prompt: `${briefedPrompt}\n\n---\n\nYou are assigned MODULE ${i + 1} of ${modules.length}:\n\n${mod}\n\nFocus only on this module.`,
        systemPrompt: builderRole.systemPrompt,
        cwd: this.opts.cwd,
        maxTurns: this.opts.agentConfig?.builder?.maxTurns || 50,
        model: builderRole.model,
        allowedTools: builderRole.allowedTools,
        context: contextStr,
      }));

      const results = await this.scheduler.runParallel(
        spawnOpts,
        (role, event, data) => {
          this._activeAgent = role;
          if (event === 'data' && data && typeof data === 'object' && 'text' in data) {
            const text = String((data as { text: string }).text);
            // Director monitors in real-time
            this.brain.monitorOutput(role, text);
            this._currentOutput.push(text);
            if (this._currentOutput.length > 50) {
              this._currentOutput = this._currentOutput.slice(-50);
            }
            this.emit('output', { role, text });
          }
        }
      );

      const combinedOutput = results.map((r) => r.output).join('\n---\n');
      await this.context.save('builder', combinedOutput);
    } else {
      // Single builder — use phased execution
      const phases = this.brain.getPhases('builder', builderPrompt);

      if (phases.length > 1) {
        // Phased execution with Director review between phases
        let combinedOutput = '';

        for (let i = 0; i < phases.length; i++) {
          this.emit('director:phase', {
            role: 'builder',
            phase: i + 1,
            total: phases.length,
          });

          const phasePrompt = this.brain.prepareBrief('builder', phases[i]);
          const result = await this.runSingleAgent('builder', phasePrompt);

          combinedOutput += result.output + '\n---\n';

          // Director reviews between phases (not after the last one)
          if (i < phases.length - 1) {
            const verdict = this.brain.reviewOutput('builder', result);
            if (verdict.verdict === 'redo' && verdict.correction) {
              // Redo this phase before moving on
              logger.info(`Director: redo builder phase ${i + 1} — ${verdict.notes}`);
              this.emit('director:redo', { role: 'builder', reason: `Phase ${i + 1}: ${verdict.notes}` });

              const redoPrompt = this.brain.prepareRedoPrompt(
                'builder',
                phases[i],
                verdict.correction
              );
              const redoResult = await this.runSingleAgent('builder', redoPrompt);
              combinedOutput += redoResult.output + '\n---\n';
              this.brain.reviewOutput('builder', redoResult);
            }
          }
        }

        await this.context.save('builder', combinedOutput);
      } else {
        // Simple single-phase execution
        const result = await this.runDirectedAgent('builder', builderPrompt);
        await this.context.save('builder', result.output);
      }
    }
  }

  // ── Low-level agent spawn ───────────────────────────────

  /**
   * Spawn a single agent and wait for completion.
   * Handles supervised mode approval, supervisor tracking, and output monitoring.
   */
  private async runSingleAgent(role: string, prompt: string): Promise<AgentResult> {
    const roleDef = ROLES[role] || ROLES[role.replace(/-\d+$/, '')];
    if (!roleDef) {
      throw new Error(`Unknown role: ${role}`);
    }

    // Supervised mode: ask user before spawning
    const decision = await this.requestApproval(role, roleDef.allowedTools);

    if (decision === 'abort') {
      throw new Error('Aborted by user');
    }

    if (decision === 'skip') {
      return {
        role,
        output: '',
        duration: 0,
        success: true,
        exitCode: 0,
      };
    }

    return new Promise((resolve, reject) => {
      this._activeAgent = role;
      this._currentOutput = [];

      // Build context: previous agents + shared memory
      const prevContext = this.context.buildContext(role);
      const sharedContext = this.brain.memory.getFullContext();
      const contextStr = prevContext
        ? `${prevContext}\n\n${sharedContext}`
        : sharedContext;
      const baseRole = role.replace(/-\d+$/, '');
      const agentCfg = this.opts.agentConfig?.[baseRole];
      const maxTurns = agentCfg?.maxTurns || 50;
      const model = agentCfg?.model || roleDef.model;

      // For new projects: restrict file-reading tools on planning agents
      let allowedTools = roleDef.allowedTools;
      let disallowedTools = roleDef.disallowedTools;
      if (this.opts.isNewProject && ['analyst', 'strategist'].includes(baseRole)) {
        allowedTools = ['WebSearch', 'WebFetch'];
        disallowedTools = ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash', 'NotebookEdit'];
      }

      const emitter = spawnClaudeAgent({
        role,
        prompt,
        systemPrompt: roleDef.systemPrompt,
        cwd: this.opts.cwd,
        maxTurns,
        model,
        allowedTools,
        disallowedTools,
        context: contextStr,
      });

      emitter.on('spawned', (pid: number) => {
        this.registry.activate(role, pid, emitter);
        if (emitter.child) {
          this.supervisor.track(role, emitter.child);
        }
        this.emit('agent:spawned', { role, pid });
        logger.info(`${roleDef.emoji} ${roleDef.name} spawned (PID: ${pid})`);
      });

      emitter.on('data', (text: string) => {
        this.registry.appendOutput(role, text);
        this.supervisor.heartbeat(role);

        // Director monitors output in real-time
        const intervention = this.brain.monitorOutput(role, text);
        if (intervention) {
          this.emit('director:intervention', intervention);
        }

        this._currentOutput.push(text);
        if (this._currentOutput.length > 50) {
          this._currentOutput = this._currentOutput.slice(-50);
        }
        this.emit('output', { role, text });
      });

      emitter.on('done', (result: AgentResult) => {
        this.registry.complete(role, result);
        this._artifacts.push(`${role}: ${result.success ? 'completed' : 'failed'} in ${result.duration}s`);
        this.emit('agent:done', { role, result });
        logger.info(
          `${roleDef.emoji} ${roleDef.name} ${result.success ? 'completed' : 'failed'} in ${result.duration}s`
        );
        resolve(result);
      });

      emitter.on('error', (err: Error) => {
        this.registry.complete(role, {
          role,
          output: '',
          duration: 0,
          success: false,
          exitCode: 1,
        });
        this.emit('agent:error', { role, error: err });
        logger.error(`${roleDef.emoji} ${roleDef.name} error: ${err.message}`);
        reject(err);
      });
    });
  }

  /**
   * Request approval from user before spawning (supervised mode).
   */
  private requestApproval(role: string, tools: string[]): Promise<'approve' | 'skip' | 'abort'> {
    return new Promise((resolve) => {
      if (!this.opts.supervised) {
        resolve('approve');
        return;
      }
      const handler = (response: 'approve' | 'skip' | 'abort') => {
        resolve(response);
      };
      this.once('approve:response', handler);
      this.emit('approve:request', { role, tools });
    });
  }

  // ── Helpers ─────────────────────────────────────────────

  private extractModules(archOutput: string): string[] {
    const moduleRegex = /### MODULE:\s*(.+?)(?:\n|$)([\s\S]*?)(?=### MODULE:|$)/g;
    const modules: string[] = [];
    let match: RegExpExecArray | null;

    while ((match = moduleRegex.exec(archOutput)) !== null) {
      modules.push(`${match[1].trim()}\n${match[2].trim()}`);
    }

    return modules;
  }

  private needsDesign(): boolean {
    const planOutput = this.context.get('strategist') || '';
    const uiKeywords = [
      'ui', 'frontend', 'react', 'vue', 'angular', 'svelte',
      'component', 'page', 'layout', 'css', 'html', 'web app',
      'website', 'dashboard', 'interface', 'design',
    ];
    const lower = planOutput.toLowerCase();
    return uiKeywords.some((kw) => lower.includes(kw));
  }

  private shouldSkip(stage: Stage): boolean {
    return shouldSkipStage(stage, this.opts.skipStages);
  }

  private setStage(stage: Stage): void {
    this._stage = stage;
    this.emit('stage', stage);
    logger.info(`\n--- Stage: ${stage.toUpperCase()} ---`);
  }

  /**
   * Graceful shutdown
   */
  shutdown(): void {
    this.supervisor.stop();
    this.scheduler.killAll();
    this.registry.killAll();
    killAllAgents();
  }
}
