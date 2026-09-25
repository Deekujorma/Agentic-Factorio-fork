import { generateText, type LanguageModel } from "ai";
import { z } from "zod";
import type { Bridge } from "../bridge.js";
import { CoordinationBroker, type CoordinationEvent, type CoordinationJob } from "../coordination/broker.js";
import { log } from "../log.js";
import type { ChatMessage, GetStateResult } from "../types.js";
import { GoalGraph } from "./goals.js";
import { autonomousMemorySchema, MemoryStore, verificationSchema, type AutonomousMemory, type Goal } from "./memory.js";
import { AUTONOMOUS_COORDINATOR_PROMPT } from "./prompts.js";
import { WorkerScheduler } from "./scheduler.js";
import { TrajectoryLog } from "./trajectory.js";
import { AutonomousWorker, defaultWorkerGenerate, type WorkerGenerate, type WorkerPacket } from "./worker.js";
import { BridgeVerificationReader, verifyGoal, type VerificationReader } from "./verifier.js";

const plannedGoalSchema = z.object({
  title: z.string().min(1), description: z.string().min(1), priority: z.number().int().min(-100).max(100).default(0),
  dependsOnTitles: z.array(z.string()).default([]),
  area: z.object({ x: z.number(), y: z.number(), radius: z.number().positive().max(96) }).optional(),
  expectedInputs: z.array(z.string()).default([]), expectedOutput: z.string().min(1), definitionOfDone: z.string().min(1),
  verification: z.array(verificationSchema).min(1),
});
const coordinatorPlanSchema = z.object({
  decision: z.string().min(1), goals: z.array(plannedGoalSchema).max(3),
  objectiveComplete: z.boolean().default(false), blockedReason: z.string().nullable().optional().transform((value) => value ?? undefined), playerMessage: z.string().max(400).nullable().optional().transform((value) => value ?? undefined),
}).refine((plan) => new Set(plan.goals.map((goal) => goal.title)).size === plan.goals.length, "goal titles must be unique within a wave");
export type CoordinatorPlan = z.infer<typeof coordinatorPlanSchema>;
export type CoordinatorGenerate = (input: { model: LanguageModel; context: string; signal: AbortSignal }) => Promise<CoordinatorPlan>;

export const defaultCoordinatorGenerate: CoordinatorGenerate = async ({ model, context, signal }) => {
  const result = await generateText({ model, system: AUTONOMOUS_COORDINATOR_PROMPT, prompt: context, abortSignal: signal });
  const json = result.text.match(/\{[\s\S]*\}/)?.[0];
  if (!json) throw new Error("coordinator returned no JSON object");
  return coordinatorPlanSchema.parse(JSON.parse(json));
};

export interface AutonomousSupervisorOptions {
  key: string; workers?: number; continuationMs?: number; modelTimeoutMs?: number;
  memoryRoot?: string; brokerRoot?: string; coordinatorGenerate?: CoordinatorGenerate;
  workerGenerate?: WorkerGenerate; verificationReader?: VerificationReader;
}

export class AutonomousSupervisor {
  private readonly store: MemoryStore;
  private readonly trajectory: TrajectoryLog;
  private readonly broker: CoordinationBroker;
  private readonly scheduler: WorkerScheduler;
  private readonly graph: GoalGraph;
  private readonly coordinatorGenerate: CoordinatorGenerate;
  private readonly workerGenerate: WorkerGenerate;
  private readonly verifier: VerificationReader;
  private readonly continuationMs: number;
  private readonly modelTimeoutMs: number;
  private memory: AutonomousMemory;
  private coordinatorId = "";
  private disposed = false;
  private running = false;
  private wakeQueued = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly aborts = new Set<AbortController>();
  private readonly idleWaiters = new Set<() => void>();
  private readonly companionPositions = new Map<string, { x: number; y: number }>();
  private latestState: GetStateResult | null = null;

  constructor(private readonly bridge: Bridge, private readonly model: LanguageModel, opts: AutonomousSupervisorOptions) {
    this.store = new MemoryStore(opts.key, opts.memoryRoot);
    this.memory = this.store.load();
    this.graph = new GoalGraph(this.memory);
    this.trajectory = new TrajectoryLog(opts.key, opts.memoryRoot);
    this.broker = new CoordinationBroker(opts.key, opts.brokerRoot);
    this.scheduler = new WorkerScheduler(opts.workers ?? 3);
    this.coordinatorGenerate = opts.coordinatorGenerate ?? defaultCoordinatorGenerate;
    this.workerGenerate = opts.workerGenerate ?? defaultWorkerGenerate;
    this.verifier = opts.verificationReader ?? new BridgeVerificationReader(bridge);
    this.continuationMs = Math.max(5_000, opts.continuationMs ?? 20_000);
    this.modelTimeoutMs = Math.max(10_000, opts.modelTimeoutMs ?? 5 * 60_000);
  }

  async start(): Promise<void> {
    this.coordinatorId = (await this.broker.registerAgent({ name: "autonomous-coordinator", role: "coordinator", agentId: "autonomous-coordinator" })).id;
    for (const slot of this.scheduler.all()) {
      await this.broker.registerAgent({ name: slot.id, role: "worker", capabilities: [slot.id], agentId: slot.id });
      await this.bridge.call("spawn_companion", { name: slot.companion });
    }
    const recovered = await this.broker.recoverAgents(this.scheduler.all().map((slot) => slot.id));
    await this.broker.abandonJobs(this.memory.activeJobs.map((job) => job.jobId), "supervisor restarted; rescheduling from checkpoint");
    for (const active of this.memory.activeJobs) {
      const goal = this.graph.get(active.goalId);
      if (goal && goal.status === "active") { goal.status = "ready"; goal.blockers = []; goal.updatedAt = new Date().toISOString(); }
    }
    this.memory.activeJobs = [];
    this.checkpoint("restart_recovery", { recoveredClaims: recovered });
    this.timer = setInterval(() => {
      if (this.hasActionableWork()) this.requestWake("continuation_timer");
    }, this.continuationMs);
    if (this.memory.objective && this.memory.campaignStatus === "running" && !this.memory.paused) this.requestWake("restart");
  }

  onChat(message: ChatMessage): void {
    log.chat(message.player, message.text);
    if (message.text.trim() === "!stop") { void this.stop(); return; }
    void this.instruct(message).catch((error) => log.error(`objective override failed: ${String(error)}`));
  }

  onEvent(event: { tick: number; text: string }): void {
    this.trajectory.append({ type: "game_event", tick: event.tick, data: { text: event.text } });
    if (this.memory.campaignStatus === "running") this.requestWake("game_event");
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    for (const controller of this.aborts) controller.abort();
    this.checkpoint("shutdown", {});
  }

  snapshot(): AutonomousMemory { return autonomousMemorySchema.parse(structuredClone(this.memory)); }
  async stop(): Promise<void> { await this.emergencyStop(); }
  async instruct(message: ChatMessage): Promise<void> { await this.replaceObjective(message); }
  async whenIdle(): Promise<void> {
    if (!this.running && !this.wakeQueued && this.scheduler.countBusy() === 0) return;
    await new Promise<void>((resolve) => this.idleWaiters.add(resolve));
  }

  private async replaceObjective(message: ChatMessage): Promise<void> {
    for (const controller of this.aborts) controller.abort();
    await this.bridge.call("cancel", { all: true }).catch(() => undefined);
    await this.broker.recoverAgents(this.scheduler.all().map((slot) => slot.id));
    await this.broker.abandonJobs(this.memory.activeJobs.map((job) => job.jobId), "superseded by player instruction");
    this.graph.cancelOpen("superseded by player instruction");
    this.memory.activeJobs = [];
    this.memory.objective = message.text.trim();
    this.memory.objectiveHistory.push({ objective: this.memory.objective, at: new Date().toISOString(), player: message.player });
    this.memory.paused = false; this.memory.stopReason = undefined; this.memory.campaignStatus = "running";
    this.checkpoint("objective_change", { player: message.player, objective: this.memory.objective }, message.tick);
    this.requestWake("player_instruction");
  }

  private requestWake(reason: string): void {
    if (this.disposed || this.memory.paused || this.memory.campaignStatus !== "running") return;
    if (this.running) { this.wakeQueued = true; return; }
    this.running = true;
    void this.run(reason).catch(async (error) => {
      const text = error instanceof Error ? error.message : String(error);
      log.error(`autonomous supervisor: ${text}`);
      this.trajectory.append({ type: "important_tool_failure", data: { reason, error: text } });
    }).finally(() => {
      this.running = false;
      if (this.wakeQueued) { this.wakeQueued = false; this.requestWake("queued_event"); }
      else this.resolveIdle();
    });
  }

  private async run(reason: string): Promise<void> {
    this.trajectory.append({ type: "supervisor_wake", data: { reason } });
    await this.consumeBrokerEvents();
    this.latestState = await this.bridge.call<GetStateResult>("get_state", {}).catch(() => null);
    if (this.latestState) this.refreshWorldMemory(this.latestState);
    this.graph.refreshReady();
    if (this.scheduler.countBusy() > 0) { this.checkpoint("waiting_for_workers", {}); return; }
    if (this.graph.ready().length === 0 && this.graph.active().length === 0) await this.planNextWave();
    await this.dispatchReady();
    this.checkpoint("scheduler_checkpoint", { ready: this.graph.ready().length, active: this.graph.active().length });
  }

  private async consumeBrokerEvents(): Promise<void> {
    if (!this.coordinatorId) return;
    const events = await this.broker.takeCoordinationEvents(this.coordinatorId);
    for (const event of events) {
      const goal = event.key ? this.graph.get(event.key) : undefined;
      if (!goal || ["done", "cancelled"].includes(goal.status)) continue;
      if (event.kind === "job_failed" || event.kind === "job_expired") await this.handleFailure(goal, event.text, event);
    }
  }

  private async planNextWave(): Promise<void> {
    if (!this.memory.objective) return;
    const state = this.latestState;
    const context = JSON.stringify({
      objective: this.memory.objective,
      goals: this.memory.goals.slice(-30).map((goal) => ({ id: goal.id, title: goal.title, status: goal.status, blockers: goal.blockers, result: goal.result })),
      world: { knownAreas: this.memory.knownAreas.slice(-8), productionLines: this.memory.productionLines.slice(-8), research: this.memory.research.slice(-8) },
      failures: this.memory.failedApproaches.slice(-8), crew: state ? { tick: state.tick, companion: state.companion, otherCompanions: state.other_companions, research: state.research, production: state.production_top } : null,
    });
    const controller = this.modelController();
    let plan: CoordinatorPlan;
    try { plan = await this.coordinatorGenerate({ model: this.model, context, signal: controller.signal }); }
    finally { this.releaseController(controller); }
    this.memory.decisions.push(plan.decision);
    this.memory.nextStrategicActions = plan.goals.map((goal) => goal.title);
    this.trajectory.append({ type: "coordinator_decision", data: { decision: plan.decision, goals: plan.goals.map((goal) => goal.title) } });
    if (plan.playerMessage) await this.bridge.call("say", { text: plan.playerMessage }).catch(() => undefined);
    if (plan.objectiveComplete) {
      this.memory.campaignStatus = "completed"; this.memory.paused = true;
      await this.bridge.call("say", { text: plan.playerMessage ?? `Objective complete: ${this.memory.objective}` }).catch(() => undefined);
      this.checkpoint("objective_completed", {}); return;
    }
    if (plan.blockedReason && plan.goals.length === 0) {
      this.memory.campaignStatus = "blocked"; this.memory.blockers = [plan.blockedReason];
      await this.bridge.call("say", { text: `I need help to continue: ${plan.blockedReason}` }).catch(() => undefined);
      this.checkpoint("blocked_on_player", { reason: plan.blockedReason }); return;
    }
    const ids = new Map<string, string>();
    for (const planned of plan.goals) {
      const goal = this.graph.create({
        title: planned.title, description: planned.description, priority: planned.priority,
        verification: planned.verification, job: { area: planned.area, expectedInputs: planned.expectedInputs, expectedOutput: planned.expectedOutput, definitionOfDone: planned.definitionOfDone },
      });
      ids.set(planned.title, goal.id);
      this.trajectory.append({ type: "goal_created", goalId: goal.id, data: { title: goal.title } });
    }
    for (const planned of plan.goals) {
      const id = ids.get(planned.title)!;
      for (const dependencyTitle of planned.dependsOnTitles) {
        const dependency = ids.get(dependencyTitle) ?? this.memory.goals.find((goal) => goal.title === dependencyTitle)?.id;
        if (!dependency) throw new Error(`coordinator referenced unknown dependency ${dependencyTitle}`);
        this.graph.addDependency(id, dependency);
      }
    }
    this.graph.refreshReady();
  }

  private async dispatchReady(): Promise<void> {
    const ready = this.graph.ready();
    const allocations = this.scheduler.allocate(ready, this.companionPositions);
    if (ready.length > 0 && allocations.length === 0 && this.companionPositions.size > 0) {
      const reason = "no leased companion is within the 128-tile travel limit";
      ready[0]!.blockers = [reason]; this.graph.transition(ready[0]!.id, "blocked", reason);
      await this.bridge.call("say", { text: `I cannot safely reach the next work site: ${reason}.` }).catch(() => undefined);
      this.trajectory.append({ type: "goal_blocked", goalId: ready[0]!.id, data: { reason } });
      return;
    }
    for (const { slot, goal } of allocations) {
      this.graph.transition(goal.id, "active");
      let reservationId: string | undefined;
      try {
        await this.broker.leaseCompanion(slot.id, slot.companion, 10 * 60);
        if (goal.job?.area) reservationId = (await this.broker.reserveArea({ agentId: slot.id, label: goal.title, center: goal.job.area, radius: goal.job.area.radius, ttlSeconds: 10 * 60 })).id;
        const [job] = await this.broker.submitJobs(this.coordinatorId, [{
          key: goal.id, title: goal.title, instructions: goal.description, priority: goal.priority,
          capability: slot.id, companion: slot.companion, idempotencyKey: `${goal.id}:attempt:${goal.attempts}`,
        }]);
        const claimed = await this.broker.claimJob(slot.id);
        if (!job || claimed?.id !== job.id) throw new Error("worker could not claim its assigned broker job");
        this.memory.activeJobs.push({ jobId: job.id, goalId: goal.id, workerId: slot.id, companion: slot.companion, startedAt: new Date().toISOString(), areaReservationId: reservationId });
        this.checkpoint("job_submitted", { title: goal.title }, undefined, goal.id, job.id, slot.id);
        void this.executeWorker(slot.id, slot.companion, goal, job, reservationId);
      } catch (error) {
        await this.releaseWorker(slot.id, slot.companion, reservationId);
        await this.handleFailure(goal, error instanceof Error ? error.message : String(error));
      }
    }
  }

  private async executeWorker(workerId: string, companion: string, goal: Goal, job: CoordinationJob, reservationId?: string): Promise<void> {
    const worker = new AutonomousWorker(workerId, this.model, this.bridge, this.broker, this.workerGenerate);
    const packet: WorkerPacket = {
      goalId: goal.id, objective: goal.description, companion, agentId: workerId, relevantArea: goal.job?.area,
      expectedInputs: goal.job?.expectedInputs ?? [], expectedOutput: goal.job?.expectedOutput ?? goal.title,
      definitionOfDone: goal.job?.definitionOfDone ?? goal.title, verification: goal.verification,
      priorFailures: this.memory.failedApproaches.filter((failure) => failure.startsWith(`${goal.title}:`)).slice(-2),
    };
    const controller = this.modelController();
    this.trajectory.append({ type: "worker_started", agentId: workerId, goalId: goal.id, jobId: job.id });
    try {
      const result = await worker.execute(job, packet, controller.signal);
      await this.broker.finishJob(workerId, job.id, result.report);
      goal.evidence.push(result.report);
      this.graph.transition(goal.id, "verifying");
      const verification = await verifyGoal(goal, this.verifier, this.memory.goals);
      goal.evidence.push(...verification.evidence);
      this.trajectory.append({ type: "verification_result", tick: verification.tick, goalId: goal.id, jobId: job.id, data: { ok: verification.ok, evidence: verification.evidence } });
      if (verification.ok) {
        this.graph.transition(goal.id, "done", result.report); goal.result = result.report;
        this.memory.recentAchievements.push(goal.title);
        this.trajectory.append({ type: "goal_completed", goalId: goal.id, jobId: job.id });
      } else {
        goal.blockers = ["deterministic verification failed"];
        if (goal.attempts < goal.maxAttempts) { goal.blockers = []; this.graph.transition(goal.id, "ready", verification.evidence.join("; ")); }
        else this.graph.transition(goal.id, "blocked", verification.evidence.join("; "));
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      await this.broker.failJob(workerId, job.id, text, false).catch(() => undefined);
      await this.handleFailure(goal, text);
    } finally {
      this.releaseController(controller);
      this.memory.activeJobs = this.memory.activeJobs.filter((active) => active.jobId !== job.id);
      await this.releaseWorker(workerId, companion, reservationId);
      this.checkpoint("worker_result", { status: goal.status }, undefined, goal.id, job.id, workerId);
      this.requestWake("worker_terminal");
      this.resolveIdle();
    }
  }

  private async handleFailure(goal: Goal, error: string, event?: CoordinationEvent): Promise<void> {
    this.memory.failedApproaches.push(`${goal.title}: ${error}`);
    if (goal.status === "active" || goal.status === "verifying") {
      if (goal.attempts < goal.maxAttempts) { goal.blockers = []; this.graph.transition(goal.id, "ready", error); }
      else { goal.blockers = [error]; this.graph.transition(goal.id, "blocked", error); }
    }
    this.trajectory.append({ type: "replanning", goalId: goal.id, jobId: event?.jobId, data: { error, attempts: goal.attempts } });
  }

  private async releaseWorker(workerId: string, companion: string, reservationId?: string): Promise<void> {
    if (reservationId) await this.broker.releaseArea(workerId, reservationId).catch(() => undefined);
    await this.broker.releaseCompanion(workerId, companion).catch(() => undefined);
    this.scheduler.release(workerId);
  }

  private async emergencyStop(): Promise<void> {
    this.memory.paused = true; this.memory.campaignStatus = "stopped"; this.memory.stopReason = "player issued !stop";
    for (const controller of this.aborts) controller.abort();
    await this.bridge.call("cancel", { all: true }).catch(() => undefined);
    await this.broker.recoverAgents(this.scheduler.all().map((slot) => slot.id)).catch(() => undefined);
    await this.broker.abandonJobs(this.memory.activeJobs.map((job) => job.jobId), "player issued !stop").catch(() => undefined);
    this.memory.activeJobs = [];
    await this.bridge.call("say", { text: "Stopped everything. Autonomous work is paused until a new instruction." }).catch(() => undefined);
    this.checkpoint("emergency_stop", {});
  }

  private hasActionableWork(): boolean {
    return !this.disposed && !this.memory.paused && this.memory.campaignStatus === "running" && !!this.memory.objective && (this.graph.ready().length > 0 || this.graph.active().length === 0);
  }

  private modelController(): AbortController {
    const controller = new AbortController(); this.aborts.add(controller);
    const timeout = setTimeout(() => controller.abort(new Error("model request timed out")), this.modelTimeoutMs);
    controller.signal.addEventListener("abort", () => clearTimeout(timeout), { once: true });
    return controller;
  }
  private releaseController(controller: AbortController): void { this.aborts.delete(controller); }
  private refreshWorldMemory(state: GetStateResult): void {
    const at = new Date().toISOString();
    const upsert = (list: AutonomousMemory["knownAreas"], id: string, summary: string, position?: { x: number; y: number }) => {
      const fact = { id, summary, observedAt: at, tick: state.tick, position, staleAfterTick: state.tick + 60 * 60 * 5 };
      const index = list.findIndex((value) => value.id === id); if (index >= 0) list[index] = fact; else list.push(fact);
      if (list.length > 100) list.splice(0, list.length - 100);
    };
    if (state.companion?.position) { const name = state.companion.name ?? "AI"; this.companionPositions.set(name, state.companion.position); upsert(this.memory.knownAreas, `companion:${name}`, `companion ${name} at (${state.companion.position.x},${state.companion.position.y})`, state.companion.position); }
    for (const crew of state.other_companions ?? []) if (crew.position) this.companionPositions.set(crew.name, crew.position);
    for (const patch of Array.isArray(state.resource_patches) ? state.resource_patches : []) upsert(this.memory.resourcePatches, `resource:${patch.name}:${Math.round(patch.center.x)}:${Math.round(patch.center.y)}`, `${patch.name}: ${patch.total_amount} remaining`, patch.center);
    for (const structure of Array.isArray(state.structures) ? state.structures : []) upsert(this.memory.infrastructure, `structure:${structure.name}`, `${structure.count} ${structure.name}; statuses ${JSON.stringify(structure.status ?? {})}`, structure.nearest);
    if (state.research) upsert(this.memory.research, `research:${state.research.current}`, `${state.research.current} ${(state.research.progress * 100).toFixed(1)}%`);
    for (const [item, production] of Object.entries(state.production_top ?? {})) upsert(this.memory.productionLines, `production:${item}`, `${item}: ${production.produced_per_min}/min produced, ${production.consumed_per_min}/min consumed`);
  }
  private resolveIdle(): void {
    if (this.running || this.wakeQueued || this.scheduler.countBusy() > 0) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }

  private checkpoint(type: string, data: Record<string, unknown>, tick?: number, goalId?: string, jobId?: string, agentId?: string): void {
    this.store.save(this.memory); this.trajectory.append({ type, data, tick, goalId, jobId, agentId });
  }
}
