import { generateText, NoObjectGeneratedError, Output, type LanguageModel } from "ai";
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
import { defaultIntentClassifier, type IntentClassifier, type PlayerIntent } from "./intent.js";
import { productionPlansForStrategy } from "./productionPlanner.js";
import { defaultTacticalPlanner, tacticalPlanSchema, type TacticalPlanner } from "./tactical.js";
import { resolveCoordinatorPlan, type ResolvedPlan } from "./planResolver.js";

const plannedGoalSchema = z.object({
  title: z.string().min(1), description: z.string().min(1), priority: z.number().int().min(-100).max(100).default(0),
  dependsOnTitles: z.array(z.string()).default([]),
  area: z.object({ x: z.number(), y: z.number(), radius: z.number().positive().max(96) }).optional(),
  expectedInputs: z.array(z.string()).default([]), expectedOutput: z.string().min(1), definitionOfDone: z.string().min(1),
  verification: z.array(verificationSchema).min(1),
  parentTitle: z.string().optional(),
}).superRefine((goal, context) => {
  if (/\b(build|construct|place|deconstruct|blueprint)\b/i.test(goal.description) && !goal.area) context.addIssue({ code: "custom", message: "construction tactical goals require an area", path: ["area"] });
});
const strategicGoalSchema = z.object({ title: z.string().min(1), description: z.string().min(1), parentTitle: z.string().optional(), priority: z.number().int().min(-100).max(100).default(0), verification: z.array(verificationSchema).default([]) });
const coordinatorPlanSchema = z.object({
  decision: z.string().min(1), goals: z.array(plannedGoalSchema).max(3),
  strategicGoals: z.array(strategicGoalSchema).max(20).default([]), campaignVerification: z.array(verificationSchema).default([]),
  completeStrategicGoals: z.array(z.string()).max(20).default([]),
  objectiveComplete: z.boolean().default(false), blockedReason: z.string().nullable().optional().transform((value) => value ?? undefined), playerMessage: z.string().max(400).nullable().optional().transform((value) => value ?? undefined),
}).refine((plan) => new Set(plan.goals.map((goal) => goal.title)).size === plan.goals.length, "goal titles must be unique within a wave");
export type CoordinatorPlan = z.infer<typeof coordinatorPlanSchema>;
export type CoordinatorGenerate = (input: { model: LanguageModel; context: string; signal: AbortSignal }) => Promise<CoordinatorPlan>;

const DIAGNOSTIC_LIMIT = 12 * 1024;
function diagnosticText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = value instanceof Error
    ? `${value.name}: ${value.message}${value.cause ? `; cause: ${diagnosticText(value.cause) ?? String(value.cause)}` : ""}`
    : typeof value === "string" ? value : (() => { try { return JSON.stringify(value); } catch { return String(value); } })();
  return text.slice(0, DIAGNOSTIC_LIMIT);
}
function safeDiagnosticValue(value: unknown): unknown {
  if (value === undefined) return undefined;
  try { return JSON.parse(JSON.stringify(value)); } catch { return diagnosticText(value); }
}

export const defaultCoordinatorGenerate: CoordinatorGenerate = async ({ model, context, signal }) => {
  const result = await generateText({
    model, system: AUTONOMOUS_COORDINATOR_PROMPT, prompt: context, abortSignal: signal, maxRetries: 1,
    output: Output.object({ schema: coordinatorPlanSchema, name: "factorio_coordinator_plan" }),
  });
  return coordinatorPlanSchema.parse(result.output);
};

export interface AutonomousSupervisorOptions {
  key: string; workers?: number; continuationMs?: number; modelTimeoutMs?: number;
  memoryRoot?: string; brokerRoot?: string; coordinatorGenerate?: CoordinatorGenerate;
  workerGenerate?: WorkerGenerate; verificationReader?: VerificationReader;
  intentClassifier?: IntentClassifier; workerRenewalMs?: number;
  tacticalPlanner?: TacticalPlanner;
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
  private readonly intentClassifier: IntentClassifier;
  private readonly tacticalPlanner: TacticalPlanner;
  private readonly continuationMs: number;
  private readonly modelTimeoutMs: number;
  private readonly workerRenewalMs: number;
  private memory: AutonomousMemory;
  private coordinatorId = "";
  private disposed = false;
  private running = false;
  private wakeQueued = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly aborts = new Set<AbortController>();
  private readonly jobControllers = new Map<string, AbortController>();
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
    this.intentClassifier = opts.intentClassifier ?? defaultIntentClassifier;
    this.tacticalPlanner = opts.tacticalPlanner ?? defaultTacticalPlanner;
    this.continuationMs = Math.max(5_000, opts.continuationMs ?? 20_000);
    this.modelTimeoutMs = Math.max(20, opts.modelTimeoutMs ?? 5 * 60_000);
    this.workerRenewalMs = Math.max(20, opts.workerRenewalMs ?? 30_000);
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
      if (goal && goal.status === "active") this.graph.recover(goal.id, "ready", "recovered after supervisor restart");
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
    void this.handleChat(message).catch((error) => log.error(`chat routing failed: ${String(error)}`));
  }

  onEvent(event: { tick: number; text: string }): void {
    this.trajectory.append({ type: "game_event", tick: event.tick, data: { text: event.text } });
    const research = event.text.match(/Research completed:\s*([^\.]+)/i)?.[1];
    if (research) this.memory.research.push({ id: `research-complete:${research}`, summary: `${research} completed`, observedAt: new Date().toISOString(), tick: event.tick, source: "game", confirmed: true });
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
  async handleChat(message: ChatMessage): Promise<void> {
    const controller = this.modelController();
    let intent: PlayerIntent;
    try { intent = await this.intentClassifier({ model: this.model, message: message.text, objective: this.memory.objective, signal: controller.signal }); }
    catch (error) {
      await this.bridge.call("say", { text: "I couldn't safely classify that request, so I left the current campaign unchanged. Please rephrase it." }).catch(() => undefined);
      this.trajectory.append({ type: "intent_classification_failed", tick: message.tick, data: { message: message.text, error: String(error) } });
      return;
    } finally { this.releaseController(controller); }
    this.trajectory.append({ type: "player_intent", tick: message.tick, data: { kind: intent.kind, summary: intent.summary, target: intent.target } });
    switch (intent.kind) {
      case "status": await this.sayStatus(); return;
      case "tactical": await this.addTacticalInstruction(message); return;
      case "modify": await this.modifyCampaign(intent.target ?? intent.summary); return;
      case "replace": await this.replaceObjective(message, intent.target ?? message.text); return;
      case "resume": await this.resumeCampaign(); return;
      case "stop": await this.emergencyStop(); return;
    }
  }
  async whenIdle(): Promise<void> {
    if (!this.running && !this.wakeQueued && this.scheduler.countBusy() === 0) return;
    await new Promise<void>((resolve) => this.idleWaiters.add(resolve));
  }

  private async replaceObjective(message: ChatMessage, objective = message.text): Promise<void> {
    for (const controller of this.aborts) controller.abort();
    await this.bridge.call("cancel", { all: true }).catch(() => undefined);
    await this.broker.recoverAgents(this.scheduler.all().map((slot) => slot.id));
    await this.broker.abandonJobs(this.memory.activeJobs.map((job) => job.jobId), "superseded by player instruction");
    this.graph.cancelOpen("superseded by player instruction");
    this.memory.activeJobs = [];
    this.memory.objective = objective.trim();
    const state = await this.bridge.call<GetStateResult>("get_state", {}).catch(() => null);
    this.memory.campaignStartedTick = state?.tick;
    this.memory.objectiveHistory.push({ objective: this.memory.objective, at: new Date().toISOString(), player: message.player });
    this.memory.paused = false; this.memory.stopReason = undefined; this.memory.campaignStatus = "running";
    const root = this.graph.create({ kind: "campaign", title: this.memory.objective, description: this.memory.objective, priority: 100 });
    this.graph.recover(root.id, "active"); this.memory.rootGoalId = root.id;
    this.checkpoint("objective_change", { player: message.player, objective: this.memory.objective }, message.tick);
    this.requestWake("player_instruction");
  }

  private async sayStatus(): Promise<void> {
    const active = this.graph.active().filter((goal) => goal.kind === "tactical").map((goal) => goal.title);
    const done = this.memory.goals.filter((goal) => goal.status === "done").length;
    const blocked = this.memory.goals.filter((goal) => goal.status === "blocked").map((goal) => goal.title);
    await this.bridge.call("say", { text: `Campaign: ${this.memory.objective ?? "none"}. Working on: ${active.join(", ") || "planning"}. ${done} goals done${blocked.length ? `; blocked: ${blocked.join(", ")}` : ""}.` }).catch(() => undefined);
  }

  private async addTacticalInstruction(message: ChatMessage): Promise<void> {
    const controller = this.modelController();
    let plan;
    try { plan = tacticalPlanSchema.parse(await this.tacticalPlanner({ model: this.model, message: message.text, signal: controller.signal })); }
    catch (error) {
      await this.bridge.call("say", { text: "I couldn't derive a safely verifiable tactical job, so I left the campaign unchanged." }).catch(() => undefined);
      this.trajectory.append({ type: "tactical_plan_rejected", tick: message.tick, data: { message: message.text, error: String(error) } });
      return;
    } finally { this.releaseController(controller); }
    this.memory.paused = false; this.memory.campaignStatus = "running";
    const goal = this.graph.create({ kind: "tactical", parentId: this.memory.rootGoalId, title: plan.title, description: plan.description, priority: 100, verification: plan.verification, job: { area: plan.area, expectedInputs: plan.expectedInputs, expectedOutput: plan.expectedOutput, definitionOfDone: plan.definitionOfDone, requestedBy: message.player } });
    if (!plan.physical) {
      this.graph.transition(goal.id, "active"); this.graph.transition(goal.id, "verifying"); this.graph.transition(goal.id, "done", "informational tactical request");
      await this.bridge.call("say", { text: plan.expectedOutput }).catch(() => undefined);
      this.checkpoint("informational_tactical_request", { text: message.text }, message.tick, goal.id); return;
    }
    this.checkpoint("tactical_override", { text: message.text }, message.tick, goal.id); this.requestWake("tactical_instruction");
  }

  private async modifyCampaign(target: string): Promise<void> {
    const matches = this.memory.goals.filter((goal) => goal.id !== this.memory.rootGoalId && `${goal.title} ${goal.description}`.toLowerCase().includes(target.toLowerCase()));
    if (matches.length === 0) { await this.bridge.call("say", { text: `I couldn't find active campaign work matching “${target}”; the campaign is unchanged.` }).catch(() => undefined); return; }
    const cancelled = new Set(matches.flatMap((goal) => this.graph.cancelSubtree(goal.id, `cancelled by player: ${target}`).map((value) => value.id)));
    const active = this.memory.activeJobs.filter((job) => cancelled.has(job.goalId));
    for (const job of active) { this.jobControllers.get(job.jobId)?.abort("campaign branch cancelled"); await this.bridge.scoped(job.companion).call("cancel", { all: true }).catch(() => undefined); }
    await this.broker.abandonJobs(active.map((job) => job.jobId), `cancelled by player: ${target}`);
    this.memory.activeJobs = this.memory.activeJobs.filter((job) => !cancelled.has(job.goalId));
    this.checkpoint("campaign_modified", { target, cancelled: [...cancelled] });
    await this.bridge.call("say", { text: `Stopped the ${target} branch; the rest of the campaign continues.` }).catch(() => undefined);
    this.requestWake("campaign_modified");
  }

  private async resumeCampaign(): Promise<void> {
    if (!this.memory.objective) { await this.bridge.call("say", { text: "There is no campaign to resume." }).catch(() => undefined); return; }
    this.memory.paused = false; this.memory.stopReason = undefined; this.memory.campaignStatus = "running"; this.memory.blockers = [];
    for (const goal of this.memory.goals) if (goal.kind === "tactical" && goal.status === "blocked") this.graph.recover(goal.id, "ready", "player requested resume");
    this.checkpoint("campaign_resumed", {}); await this.bridge.call("say", { text: "Resuming the current campaign." }).catch(() => undefined); this.requestWake("player_resume");
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
    if (this.graph.ready().length === 0 && !this.graph.active().some((goal) => goal.kind === "tactical")) await this.planNextWave();
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
    const productionPlans = await productionPlansForStrategy(this.bridge, [this.memory.objective, ...this.memory.nextStrategicActions].join(" ")).catch(() => []);
    const context = JSON.stringify({
      objective: this.memory.objective,
      rootGoalId: this.memory.rootGoalId,
      goals: this.memory.goals.slice(-60).map((goal) => ({ id: goal.id, parentId: goal.parentId, kind: goal.kind, title: goal.title, status: goal.status, blockers: goal.blockers, result: goal.result })),
      world: { knownAreas: this.memory.knownAreas.slice(-8), productionLines: this.memory.productionLines.slice(-8), research: this.memory.research.slice(-8) },
      productionPlans, failures: this.memory.failedApproaches.slice(-8), crew: state ? { tick: state.tick, companion: state.companion, otherCompanions: state.other_companions, research: state.research, production: state.production_top } : null,
    });
    let plan: CoordinatorPlan | undefined; let resolved: ResolvedPlan | undefined; let semanticError = ""; let repairFeedback = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = this.modelController();
      try {
        plan = coordinatorPlanSchema.parse(await this.coordinatorGenerate({ model: this.model, context: attempt === 0 ? context : `${context}\nCOORDINATOR_PLAN_REPAIR_REQUIRED:\n${repairFeedback}\nCorrect the failed object so it conforms exactly to the required coordinator schema. Return one complete corrected object only.`, signal: controller.signal }));
        resolved = resolveCoordinatorPlan(this.memory, plan); break;
      } catch (error) {
        semanticError = error instanceof Error ? error.message : String(error);
        if (NoObjectGeneratedError.isInstance(error)) {
          const cause = diagnosticText(error.cause); const text = diagnosticText(error.text);
          const diagnostics = { message: error.message, finishReason: error.finishReason, cause, text, usage: safeDiagnosticValue(error.usage) };
          this.trajectory.append({ type: "coordinator_plan_rejected", data: { attempt: attempt + 1, error: semanticError, ...diagnostics } });
          log.error(`coordinator structured output rejected (finish=${error.finishReason ?? "unknown"}; cause=${cause ?? "unknown"}; text=${text ?? "<empty>"})`);
          repairFeedback = `Validation/parsing cause: ${cause ?? error.message}\nFinish reason: ${error.finishReason ?? "unknown"}${text ? `\nFailed generated object text:\n${text}` : ""}`;
        } else {
          this.trajectory.append({ type: "coordinator_plan_rejected", data: { attempt: attempt + 1, error: semanticError } });
          repairFeedback = `Semantic/schema validation error: ${semanticError}`;
        }
      } finally { this.releaseController(controller); }
    }
    if (!plan || !resolved) {
      this.memory.campaignStatus = "blocked"; this.memory.blockers = [`planner validation failed: ${semanticError}`];
      this.checkpoint("planner_validation_failed", { error: semanticError });
      await this.bridge.call("say", { text: "I couldn't safely construct the next plan, so I have not started any new work." }).catch(() => undefined);
      return;
    }
    this.memory.decisions.push(plan.decision);
    this.memory.nextStrategicActions = plan.goals.map((goal) => goal.title);
    this.trajectory.append({ type: "coordinator_decision", data: { decision: plan.decision, goals: plan.goals.map((goal) => goal.title) } });
    if (plan.objectiveComplete) {
      const root = this.memory.rootGoalId ? this.graph.get(this.memory.rootGoalId) : undefined;
      if (!root) throw new Error("campaign has no persistent root goal");
      if (plan.campaignVerification.length > 0) this.graph.update(root.id, { verification: plan.campaignVerification.map((check) => check.kind === "event_count" && check.afterTick === undefined ? { ...check, afterTick: this.memory.campaignStartedTick } : check) });
      const hasPhysicalCheck = root.verification.some((check) => !["manual", "goal_dependencies"].includes(check.kind));
      const verification = hasPhysicalCheck ? await verifyGoal(root, this.verifier, this.memory.goals) : { ok: false, evidence: ["campaign completion requires at least one physical verification predicate"], retryable: false };
      root.evidence.push(...verification.evidence);
      this.trajectory.append({ type: "campaign_verification", goalId: root.id, data: { ok: verification.ok, evidence: verification.evidence } });
      if (verification.ok) {
        this.graph.recover(root.id, "active"); this.graph.transition(root.id, "verifying"); this.graph.transition(root.id, "done", "campaign verification passed");
        this.memory.campaignStatus = "completed"; this.memory.paused = true;
        await this.bridge.call("say", { text: plan.playerMessage ?? `Objective complete: ${this.memory.objective}` }).catch(() => undefined);
        this.checkpoint("objective_completed", {}); return;
      }
      this.memory.decisions.push(`Rejected premature completion: ${verification.evidence.join("; ")}`);
      this.trajectory.append({ type: "premature_completion_rejected", goalId: root.id, data: { evidence: verification.evidence } });
    }
    if (plan.blockedReason && plan.goals.length === 0) {
      this.memory.campaignStatus = "blocked"; this.memory.blockers = [plan.blockedReason];
      await this.bridge.call("say", { text: `I need help to continue: ${plan.blockedReason}` }).catch(() => undefined);
      this.checkpoint("blocked_on_player", { reason: plan.blockedReason }); return;
    }
    for (const item of resolved.strategic) {
      const strategic = item.input as CoordinatorPlan["strategicGoals"][number];
      const goal = item.existing ?? this.graph.create({ id: item.id, kind: "strategic", parentId: item.parentId, title: strategic.title, description: strategic.description, priority: strategic.priority });
      if (strategic.verification?.length) this.graph.update(goal.id, { verification: strategic.verification });
      if (goal.status === "pending") this.graph.recover(goal.id, "active");
    }
    for (const item of resolved.tactical) {
      const planned = item.input as CoordinatorPlan["goals"][number];
      if (item.existing) continue;
      const goal = this.graph.create({
        id: item.id, kind: "tactical", parentId: item.parentId, title: planned.title, description: planned.description, priority: planned.priority,
        verification: planned.verification, job: { area: planned.area, expectedInputs: planned.expectedInputs, expectedOutput: planned.expectedOutput, definitionOfDone: planned.definitionOfDone },
      });
      this.trajectory.append({ type: "goal_created", goalId: goal.id, data: { title: goal.title } });
    }
    for (const item of resolved.tactical) for (const dependency of item.dependencyIds) this.graph.addDependency(item.id, dependency);
    this.graph.refreshReady();
    await this.completeProposedStrategicGoals(plan.completeStrategicGoals ?? []);
    if (plan.playerMessage) await this.bridge.call("say", { text: plan.playerMessage }).catch(() => undefined);
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
    const boundVerification = goal.verification.map((check) => check.kind === "companion_near_player"
      ? { ...check, companion, player: check.player ?? goal.job?.requestedBy }
      : check);
    const packet: WorkerPacket = {
      goalId: goal.id, objective: goal.description, companion, agentId: workerId, relevantArea: goal.job?.area,
      expectedInputs: goal.job?.expectedInputs ?? [], expectedOutput: goal.job?.expectedOutput ?? goal.title,
      definitionOfDone: goal.job?.definitionOfDone ?? goal.title, verification: boundVerification,
      priorFailures: this.memory.failedApproaches.filter((failure) => failure.startsWith(`${goal.title}:`)).slice(-2),
    };
    const controller = this.modelController();
    this.jobControllers.set(job.id, controller);
    let renewalInFlight: Promise<void> = Promise.resolve();
    const renewal = setInterval(() => {
      renewalInFlight = Promise.all([
        this.broker.heartbeat(workerId),
        this.broker.leaseCompanion(workerId, companion, 10 * 60),
        reservationId ? this.broker.renewArea(workerId, reservationId, 10 * 60) : Promise.resolve(undefined),
      ]).then(() => undefined).catch((error) => controller.abort(error));
    }, this.workerRenewalMs);
    this.trajectory.append({ type: "worker_started", agentId: workerId, goalId: goal.id, jobId: job.id });
    try {
      const result = await worker.execute(job, packet, controller.signal);
      await this.persistWorkerDiscoveries(result.discoveries, job.id);
      goal.evidence.push(result.summary, ...result.evidence);
      if (result.status === "blocked") {
        const blocker = result.blocker ?? result.summary;
        await this.broker.failJob(workerId, job.id, blocker, false);
        goal.blockers = [blocker]; this.graph.transition(goal.id, "blocked", blocker);
        this.trajectory.append({ type: "worker_blocked", agentId: workerId, goalId: goal.id, jobId: job.id, data: { blocker } });
        return;
      }
      if (result.status === "failed") {
        const failure = result.blocker ?? result.summary;
        await this.broker.failJob(workerId, job.id, failure, false);
        await this.handleFailure(goal, failure);
        return;
      }
      await this.broker.finishJob(workerId, job.id, result.summary);
      this.graph.transition(goal.id, "verifying");
      const verification = await verifyGoal({ ...goal, verification: boundVerification }, this.verifier, this.memory.goals);
      goal.evidence.push(...verification.evidence);
      this.trajectory.append({ type: "verification_result", tick: verification.tick, goalId: goal.id, jobId: job.id, data: { ok: verification.ok, evidence: verification.evidence } });
      if (verification.ok) {
        this.graph.transition(goal.id, "done", result.summary); goal.result = result.summary;
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
      clearInterval(renewal);
      await renewalInFlight;
      this.jobControllers.delete(job.id);
      this.releaseController(controller);
      this.memory.activeJobs = this.memory.activeJobs.filter((active) => active.jobId !== job.id);
      await this.releaseWorker(workerId, companion, reservationId);
      if (!this.memory.objective && this.memory.activeJobs.length === 0 && !this.memory.goals.some((candidate) => candidate.kind === "tactical" && ["ready", "active", "verifying"].includes(candidate.status))) this.memory.campaignStatus = "idle";
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

  private async completeProposedStrategicGoals(titles: string[]): Promise<void> {
    for (const title of titles) {
      const goal = this.memory.goals.find((candidate) => candidate.kind === "strategic" && candidate.title === title && candidate.status !== "done");
      if (!goal) continue;
      const children = this.memory.goals.filter((candidate) => candidate.parentId === goal.id);
      const prerequisitesDone = children.length > 0 && children.every((child) => child.status === "done") && goal.dependencies.every((id) => this.graph.get(id)?.status === "done");
      if (!prerequisitesDone) { goal.evidence.push("strategic completion rejected: unfinished child or dependency"); continue; }
      if (goal.verification.length > 0) {
        const outcome = await verifyGoal(goal, this.verifier, this.memory.goals); goal.evidence.push(...outcome.evidence);
        if (!outcome.ok) continue;
      }
      this.graph.recover(goal.id, "active"); this.graph.transition(goal.id, "verifying"); this.graph.transition(goal.id, "done", "coordinator explicitly completed strategic goal");
      this.trajectory.append({ type: "strategic_goal_completed", goalId: goal.id, data: { title } });
    }
  }

  private async releaseWorker(workerId: string, companion: string, reservationId?: string): Promise<void> {
    await this.bridge.scoped(companion).call("cancel", { all: true }).catch(() => undefined);
    if (reservationId) await this.broker.releaseArea(workerId, reservationId).catch(() => undefined);
    await this.broker.releaseCompanion(workerId, companion).catch(() => undefined);
    this.scheduler.release(workerId);
  }

  private async persistWorkerDiscoveries(discoveries: import("./worker.js").WorkerResult["discoveries"], jobId: string): Promise<void> {
    const at = new Date().toISOString();
    const lists: Record<string, AutonomousMemory["knownAreas"]> = {
      knownArea: this.memory.knownAreas, resourcePatch: this.memory.resourcePatches,
      productionLine: this.memory.productionLines, importantEntity: this.memory.importantEntities,
      infrastructure: this.memory.infrastructure, research: this.memory.research,
    };
    for (const [index, discovery] of discoveries.entries()) {
      if (discovery.category === "blueprint") continue;
      lists[discovery.category]?.push({ id: `worker:${jobId}:${index}`, summary: discovery.summary, position: discovery.position, observedAt: at, source: "model", confirmed: false });
    }
    if (discoveries.some((value) => value.category === "blueprint")) {
      const blueprints = await this.bridge.call<unknown>("list_blueprints", {}).catch(() => null);
      if (blueprints) this.memory.knownBlueprints.push({ id: `blueprints:${jobId}`, summary: JSON.stringify(blueprints).slice(0, 1000), observedAt: at, source: "game", confirmed: true });
    }
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
    return !this.disposed && !this.memory.paused && this.memory.campaignStatus === "running" && !!this.memory.objective && (this.graph.ready().length > 0 || !this.graph.active().some((goal) => goal.kind === "tactical"));
  }

  private modelController(): AbortController {
    const controller = new AbortController(); this.aborts.add(controller);
    const timeout = setTimeout(() => controller.abort(new Error("model request timed out")), this.modelTimeoutMs);
    controller.signal.addEventListener("abort", () => clearTimeout(timeout), { once: true });
    return controller;
  }
  private releaseController(controller: AbortController): void {
    this.aborts.delete(controller);
    if (!controller.signal.aborted) controller.abort("completed");
  }
  private refreshWorldMemory(state: GetStateResult): void {
    const at = new Date().toISOString();
    const upsert = (list: AutonomousMemory["knownAreas"], id: string, summary: string, position?: { x: number; y: number }) => {
      const fact = { id, summary, observedAt: at, tick: state.tick, position, staleAfterTick: state.tick + 60 * 60 * 5, source: "game" as const, confirmed: true };
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
