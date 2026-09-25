import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Bridge } from "../src/bridge.js";
import { GoalGraph } from "../src/autonomous/goals.js";
import { freshMemory, MemoryStore, type Goal } from "../src/autonomous/memory.js";
import { planProduction } from "../src/autonomous/productionPlanner.js";
import { WorkerScheduler } from "../src/autonomous/scheduler.js";
import { AutonomousSupervisor, type CoordinatorPlan } from "../src/autonomous/supervisor.js";
import { TrajectoryLog } from "../src/autonomous/trajectory.js";
import { verifyGoal } from "../src/autonomous/verifier.js";
import { CoordinationBroker } from "../src/coordination/broker.js";

const roots: string[] = [];
const root = () => { const value = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-autonomous-")); roots.push(value); return value; };
afterEach(() => roots.splice(0).forEach((value) => fs.rmSync(value, { recursive: true, force: true })));

function goal(overrides: Partial<Goal> = {}): Goal {
  const now = new Date().toISOString();
  return { id: "g", title: "goal", description: "goal", status: "verifying", priority: 0, dependencies: [], createdAt: now, updatedAt: now, attempts: 1, maxAttempts: 3, blockers: [], verification: [], evidence: [], ...overrides };
}

function fakeBridge(calls: Array<{ method: string; params: unknown }>): Bridge {
  return { call: async (method: string, params?: unknown) => {
    calls.push({ method, params });
    if (method === "spawn_companion") return { name: (params as { name: string }).name, position: { x: 0, y: 0 }, unit_number: 1, already_existed: false };
    if (method === "get_state") return { tick: 10, players: [], resource_patches: [], trees_nearby: 0, structures: [] };
    if (method === "cancel") return { cancelled: 1 };
    return {};
  } } as unknown as Bridge;
}

const wave = (): CoordinatorPlan => ({
  decision: "bootstrap", objectiveComplete: false,
  goals: [{ title: "Build power", description: "build a closed power loop", priority: 10, dependsOnTitles: [], area: { x: 0, y: 0, radius: 8 }, expectedInputs: ["boiler"], expectedOutput: "electricity", definitionOfDone: "power is operational", verification: [{ kind: "manual", description: "informational test goal" }] }],
});

describe("autonomous memory and goals", () => {
  it("persists atomically and recovers corrupt memory", () => {
    const store = new MemoryStore("game", root()); const memory = freshMemory(); memory.objective = "launch"; store.save(memory);
    expect(store.load().objective).toBe("launch"); fs.writeFileSync(store.file, "not-json");
    expect(store.load().objective).toBeNull(); expect(fs.readdirSync(path.dirname(store.file)).some((name) => name.includes(".corrupt-"))).toBe(true);
  });

  it("enforces dependencies, transitions, idempotency, and cycles", () => {
    const memory = freshMemory(); const graph = new GoalGraph(memory);
    const ore = graph.create({ id: "ore", title: "Ore" }); expect(graph.create({ id: "ore", title: "duplicate" })).toBe(ore);
    const plates = graph.create({ id: "plates", title: "Plates", dependencies: [ore.id] });
    expect(graph.ready().map((value) => value.id)).toEqual(["ore"]);
    graph.transition("ore", "active"); graph.transition("ore", "verifying"); graph.transition("ore", "done", "count passed");
    expect(graph.ready().map((value) => value.id)).toEqual([plates.id]);
    expect(() => graph.addDependency("ore", "plates")).toThrow(/cycle/);
    expect(() => graph.transition("ore", "active")).toThrow(/invalid/);
  });
});

describe("deterministic helpers", () => {
  it("verifies mixed local and live predicates", async () => {
    const current = goal({ verification: [{ kind: "goal_dependencies", goalIds: ["dep"] }, { kind: "entity_count", entity: "assembling-machine-1", minimum: 2, area: { x: 0, y: 0, radius: 5 } }] });
    const result = await verifyGoal(current, { verify: async () => ({ tick: 99, results: [{ kind: "entity_count", ok: true, actual: 2, expected: 2 }] }) }, [goal({ id: "dep", status: "done" }), current]);
    expect(result).toMatchObject({ ok: true, tick: 99 }); expect(result.evidence).toHaveLength(2);
  });

  it("rejects missing verification and failed observations", async () => {
    expect((await verifyGoal(goal(), { verify: async () => ({ tick: 0, results: [] }) }, [])).ok).toBe(false);
    const current = goal({ verification: [{ kind: "research", technology: "automation" }] });
    expect((await verifyGoal(current, { verify: async () => ({ tick: 2, results: [{ kind: "research", ok: false, actual: false, expected: true }] }) }, [current])).ok).toBe(false);
  });

  it("calculates recipes, coproducts, fluids, alternatives, locked recipes, and cycles", () => {
    const recipes = [
      { name: "science", category: "crafting", energy: 5, enabled: true, ingredients: [{ item: "gear", amount: 1, type: "item" as const }, { item: "water", amount: 10, type: "fluid" as const }], products: [{ item: "science", amount: 2, type: "item" as const }] },
      { name: "gear", category: "crafting", energy: 0.5, enabled: true, ingredients: [{ item: "iron", amount: 2, type: "item" as const }], products: [{ item: "gear", amount: 1, type: "item" as const }, { item: "scrap", amount: 1, type: "item" as const }] },
      { name: "gear-alt", category: "crafting", energy: 1, enabled: false, ingredients: [{ item: "copper", amount: 1, type: "item" as const }], products: [{ item: "gear", amount: 1, type: "item" as const }] },
    ];
    const plan = planProduction(recipes, "science", 60);
    expect(plan.root.machinesAtSpeedOne).toBe(2.5); expect(plan.rawDemandPerMinute).toMatchObject({ iron: 60, water: 300 });
    expect(plan.root.ingredients[0]?.alternatives).toEqual(["gear-alt"]);
    expect(() => planProduction([{ name: "loop", category: "x", energy: 1, enabled: true, ingredients: [{ item: "loop", amount: 1, type: "item" }], products: [{ item: "loop", amount: 1, type: "item" }] }], "loop", 1)).toThrow(/cycle/);
  });

  it("bounds worker concurrency", () => {
    const scheduler = new WorkerScheduler(2); const goals = [goal({ id: "1" }), goal({ id: "2" }), goal({ id: "3" })];
    expect(scheduler.allocate(goals)).toHaveLength(2); expect(scheduler.available()).toHaveLength(0);
    scheduler.release("local-worker-1"); expect(scheduler.available()).toHaveLength(1);
  });

  it("writes concise JSONL events", () => {
    const log = new TrajectoryLog("game", root()); log.append({ type: "goal_created", goalId: "g", data: { title: "Power" } });
    expect(JSON.parse(fs.readFileSync(log.file, "utf8"))).toMatchObject({ type: "goal_created", goalId: "g" });
  });
});

describe("AutonomousSupervisor", () => {
  it("continues after completion, shares one model object, and recovers on restart", async () => {
    const stateRoot = root(); const brokerRoot = root(); const calls: Array<{ method: string; params: unknown }> = [];
    const sharedModel = { specificationVersion: "v3", provider: "fake", modelId: "one-endpoint", supportedUrls: {} } as never;
    let plans = 0; const seenModels: unknown[] = [];
    const supervisor = new AutonomousSupervisor(fakeBridge(calls), sharedModel, {
      key: "game", workers: 2, memoryRoot: stateRoot, brokerRoot,
      coordinatorGenerate: async ({ model }) => { seenModels.push(model); return plans++ === 0 ? wave() : { decision: "done", goals: [], objectiveComplete: true }; },
      workerGenerate: async ({ model }) => { seenModels.push(model); return { success: true, report: "power observed", toolSteps: 2 }; },
    });
    await supervisor.start(); await supervisor.instruct({ id: 1, tick: 1, player: "P", text: "launch a rocket" }); await supervisor.whenIdle();
    expect(supervisor.snapshot().campaignStatus).toBe("completed"); expect(supervisor.snapshot().goals[0]?.status).toBe("done");
    expect(seenModels.every((model) => model === sharedModel)).toBe(true); supervisor.dispose();

    const resumed = new AutonomousSupervisor(fakeBridge(calls), sharedModel, { key: "game", workers: 2, memoryRoot: stateRoot, brokerRoot, coordinatorGenerate: async () => ({ decision: "done", goals: [], objectiveComplete: true }), workerGenerate: async () => ({ success: true, report: "ok", toolSteps: 0 }) });
    await resumed.start(); expect(resumed.snapshot().objective).toBe("launch a rocket"); resumed.dispose();
  });

  it("replans a failed worker with bounded attempts", async () => {
    let attempts = 0; let plans = 0; const supervisor = new AutonomousSupervisor(fakeBridge([]), {} as never, {
      key: "retry", workers: 1, memoryRoot: root(), brokerRoot: root(),
      coordinatorGenerate: async () => plans++ === 0 ? wave() : ({ decision: "done", goals: [], objectiveComplete: true }),
      workerGenerate: async () => { attempts++; if (attempts === 1) throw new Error("temporary model failure"); return { success: true, report: "recovered", toolSteps: 1 }; },
    });
    await supervisor.start(); await supervisor.instruct({ id: 1, tick: 1, player: "P", text: "build power" }); await supervisor.whenIdle();
    expect(attempts).toBe(2); expect(supervisor.snapshot().goals[0]?.status).toBe("done"); supervisor.dispose();
  });

  it("reschedules an active checkpoint after a coordinator restart", async () => {
    const memoryRoot = root(); const brokerRoot = root(); const memory = freshMemory();
    memory.objective = "restore power"; memory.campaignStatus = "running";
    const graph = new GoalGraph(memory); const pending = graph.create({ id: "power", title: "Restore power", verification: [{ kind: "manual", description: "informational test" }], job: { expectedInputs: [], expectedOutput: "power", definitionOfDone: "power" } });
    graph.transition(pending.id, "active");
    const broker = new CoordinationBroker("resume", brokerRoot); const coordinator = await broker.registerAgent({ name: "lead", role: "coordinator", agentId: "autonomous-coordinator" });
    const worker = await broker.registerAgent({ name: "worker", role: "worker", capabilities: ["local-worker-1"], agentId: "local-worker-1" });
    const [job] = await broker.submitJobs(coordinator.id, [{ key: pending.id, title: pending.title, instructions: pending.description, capability: worker.id }]); await broker.claimJob(worker.id);
    memory.activeJobs.push({ jobId: job!.id, goalId: pending.id, workerId: worker.id, companion: "Ada", startedAt: new Date().toISOString() }); new MemoryStore("resume", memoryRoot).save(memory);
    let plans = 0; const supervisor = new AutonomousSupervisor(fakeBridge([]), {} as never, { key: "resume", workers: 1, memoryRoot, brokerRoot, coordinatorGenerate: async () => ({ decision: "complete", goals: [], objectiveComplete: ++plans > 0 }), workerGenerate: async () => ({ success: true, report: "restored", toolSteps: 1 }) });
    await supervisor.start(); await supervisor.whenIdle();
    expect(supervisor.snapshot().goals[0]).toMatchObject({ status: "done", attempts: 2 }); expect((await broker.snapshot()).jobs.filter((value) => value.status === "failed").length).toBeGreaterThan(0); supervisor.dispose();
  });

  it("hard-stops and never resumes without a new instruction", async () => {
    const calls: Array<{ method: string; params: unknown }> = []; const supervisor = new AutonomousSupervisor(fakeBridge(calls), {} as never, { key: "stop", workers: 1, memoryRoot: root(), brokerRoot: root(), coordinatorGenerate: async () => wave(), workerGenerate: async () => ({ success: true, report: "ok", toolSteps: 0 }) });
    await supervisor.start(); await supervisor.stop();
    expect(supervisor.snapshot()).toMatchObject({ paused: true, campaignStatus: "stopped", stopReason: "player issued !stop" });
    expect(calls.some((call) => call.method === "cancel")).toBe(true); supervisor.onEvent({ tick: 3, text: "research completed" });
    expect(supervisor.snapshot().campaignStatus).toBe("stopped"); supervisor.dispose();
  });
});
