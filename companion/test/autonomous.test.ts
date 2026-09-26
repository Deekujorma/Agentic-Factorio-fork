import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NoObjectGeneratedError } from "ai";
import type { Bridge } from "../src/bridge.js";
import { CoordinationBroker } from "../src/coordination/broker.js";
import { GoalGraph } from "../src/autonomous/goals.js";
import { deterministicIntent } from "../src/autonomous/intent.js";
import { freshMemory, MemoryStore, type Goal } from "../src/autonomous/memory.js";
import { planProduction } from "../src/autonomous/productionPlanner.js";
import { WorkerScheduler } from "../src/autonomous/scheduler.js";
import { AutonomousSupervisor, type CoordinatorPlan } from "../src/autonomous/supervisor.js";
import { TrajectoryLog } from "../src/autonomous/trajectory.js";
import { verifyGoal } from "../src/autonomous/verifier.js";
import type { WorkerResult } from "../src/autonomous/worker.js";
import { deterministicTacticalPlan, tacticalPlanSchema } from "../src/autonomous/tactical.js";
import { resolveCoordinatorPlan } from "../src/autonomous/planResolver.js";
import { shouldSpawnGenericCompanion } from "../src/autonomous/startup.js";

const roots: string[] = [];
const root = () => { const value = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-autonomous-")); roots.push(value); return value; };
afterEach(() => roots.splice(0).forEach((value) => fs.rmSync(value, { recursive: true, force: true })));

function goal(overrides: Partial<Goal> = {}): Goal {
  const now = new Date().toISOString();
  return { id: "g", kind: "tactical", title: "goal", description: "goal", status: "verifying", priority: 0, dependencies: [], createdAt: now, updatedAt: now, attempts: 1, maxAttempts: 3, blockers: [], verification: [], evidence: [], ...overrides };
}

interface BridgeHarness { bridge: Bridge; calls: Array<{ method: string; params: unknown; companion?: string }>; verificationOk: { value: boolean } }
function fakeBridge(): BridgeHarness {
  const calls: BridgeHarness["calls"] = []; const verificationOk = { value: true };
  const make = (companion?: string): Bridge => ({
    call: async (method: string, params?: unknown) => {
      calls.push({ method, params, companion });
      if (method === "spawn_companion") return { name: (params as { name: string }).name, position: { x: 0, y: 0 }, unit_number: 1, already_existed: false };
      if (method === "get_state") return { tick: 10, players: [], resource_patches: [], trees_nearby: 0, structures: [], other_companions: [{ name: "Ada", position: { x: 0, y: 0 } }] };
      if (method === "verify_autonomous") return { tick: 11, results: [{ kind: "event_count", ok: verificationOk.value, actual: verificationOk.value ? 1 : 0, expected: 1 }] };
      if (method === "cancel") return { cancelled: 1 };
      if (method === "list_blueprints") return { books: [{ label: "Power" }] };
      if (method === "get_recipe_graph") return { recipes: [] };
      if (method === "describe_prototype") return Object.fromEntries(((params as { names: string[] }).names).map((name) => [name, name === "iron-ore" ? { kind: "entity", entity: name, entity_type: "resource" } : ["assembling-machine-1", "burner-mining-drill", "stone-furnace"].includes(name) ? { kind: "entity", entity: name, entity_type: "assembling-machine" } : { kind: "unknown" }]));
      return {};
    },
    scoped: (name: string) => make(name),
  } as unknown as Bridge);
  return { bridge: make(), calls, verificationOk };
}

const completed = (summary = "completed"): WorkerResult => ({ status: "completed", summary, evidence: ["observed"], discoveries: [], blocker: null, toolSteps: 2 });
const blockedPlan = (): CoordinatorPlan => ({ decision: "waiting", goals: [], strategicGoals: [], campaignVerification: [], objectiveComplete: false, blockedReason: "test stop" });
const wave = (title = "Inspect power"): CoordinatorPlan => ({
  decision: "bootstrap", objectiveComplete: false, strategicGoals: [{ title: "Power", description: "Stable power", priority: 10 }], campaignVerification: [],
  goals: [{ title, parentTitle: "Power", description: "inspect the power loop", priority: 10, dependsOnTitles: [], expectedInputs: [], expectedOutput: "electricity", definitionOfDone: "power observed", verification: [{ kind: "event_count", event: "rocket_launched", minimum: 1 }] }],
});

function sequence(...plans: CoordinatorPlan[]) {
  let index = 0; return async () => plans[Math.min(index++, plans.length - 1)]!;
}

describe("autonomous memory, goals, and deterministic helpers", () => {
  it("persists atomically and recovers corrupt memory", () => {
    const store = new MemoryStore("game", root()); const memory = freshMemory(); memory.objective = "launch"; store.save(memory);
    expect(store.load().objective).toBe("launch"); fs.writeFileSync(store.file, "not-json");
    expect(store.load().objective).toBeNull(); expect(fs.readdirSync(path.dirname(store.file)).some((name) => name.includes(".corrupt-"))).toBe(true);
  });

  it.each([1, 2] as const)("repairs and resumes a schema-v%s campaign with a stable root", async (version) => {
    const directory = root(); const store = new MemoryStore(`v${version}`, directory); const memory = freshMemory();
    memory.objective = "launch rocket"; memory.campaignStatus = "running";
    const oldGoal = goal({ id: "legacy", status: version === 2 ? "active" : "ready" }); memory.goals = [oldGoal];
    const raw = structuredClone(memory) as unknown as Record<string, unknown>; raw.schemaVersion = version; delete raw.rootGoalId;
    if (version === 1) { delete raw.activeJobs; const timestamps = raw.timestamps as Record<string, unknown>; delete timestamps.lastCheckpointAt; (raw.goals as Array<Record<string, unknown>>).forEach((value) => delete value.kind); }
    fs.mkdirSync(path.dirname(store.file), { recursive: true }); fs.writeFileSync(store.file, JSON.stringify(raw));
    const loaded = store.load(); const rootGoal = loaded.goals.find((value) => value.kind === "campaign");
    expect(rootGoal).toBeDefined(); expect(loaded.rootGoalId).toBe(rootGoal!.id); expect(loaded.goals.find((value) => value.id === "legacy")).toMatchObject({ parentId: rootGoal!.id, status: "ready" });
    const supervisor = new AutonomousSupervisor(fakeBridge().bridge, {} as never, { key: `v${version}`, workers: 1, memoryRoot: directory, brokerRoot: root(), coordinatorGenerate: sequence(blockedPlan()), workerGenerate: async () => completed() });
    await supervisor.start(); await supervisor.whenIdle(); expect(supervisor.snapshot().rootGoalId).toBe(rootGoal!.id); supervisor.dispose();
  });

  it("enforces dependencies, centralized recovery, and hierarchy", () => {
    const memory = freshMemory(); const graph = new GoalGraph(memory);
    const rootGoal = graph.create({ id: "root", kind: "campaign", title: "Rocket" }); graph.recover(rootGoal.id, "active");
    const science = graph.create({ id: "science", kind: "strategic", parentId: rootGoal.id, title: "Science" }); graph.recover(science.id, "active");
    const red = graph.create({ id: "red", parentId: science.id, title: "Red science" });
    expect(graph.descendants(rootGoal.id).map((value) => value.id)).toEqual(["science", "red"]);
    graph.transition(red.id, "active"); graph.recover(red.id, "ready", "restart"); expect(red).toMatchObject({ status: "ready", blockers: [] });
    expect(() => graph.addDependency(rootGoal.id, red.id)).not.toThrow(); expect(() => graph.addDependency(red.id, rootGoal.id)).toThrow(/cycle/);
  });

  it("verifies live predicates and rejects missing criteria", async () => {
    const current = goal({ verification: [{ kind: "entity_count", entity: "assembling-machine-1", minimum: 2, area: { x: 0, y: 0, radius: 5 } }] });
    expect((await verifyGoal(current, { verify: async () => ({ tick: 99, results: [{ kind: "entity_count", ok: true, actual: 2, expected: 2 }] }) }, [current])).ok).toBe(true);
    expect((await verifyGoal(goal(), { verify: async () => ({ tick: 0, results: [] }) }, [])).ok).toBe(false);
  });

  it("converts resource_count to the dedicated read-only RPC predicate", async () => {
    let rpc: unknown;
    const current = goal({ verification: [{ kind: "resource_count", resource: "iron-ore", minimum: 8, area: { x: -34, y: 83.5, radius: 20 } }] });
    const outcome = await verifyGoal(current, { verify: async (checks) => { rpc = checks[0]; return { tick: 99, results: [{ kind: "resource_count", ok: true, actual: 735, expected: 8 }] }; } }, [current]);
    expect(rpc).toEqual({ kind: "resource_count", resource: "iron-ore", minimum: 8, area: { x: -34, y: 83.5, radius: 20 } }); expect(outcome.ok).toBe(true);
  });

  it("calculates speed-one recipe math, alternatives, probability, fluids, and cycles", () => {
    const plan = planProduction([
      { name: "science", category: "crafting", energy: 5, enabled: true, ingredients: [{ item: "water", amount: 10, type: "fluid" }], products: [{ item: "science", amount: 2, probability: 0.5, type: "item" }] },
      { name: "science-alt", category: "crafting", energy: 6, enabled: false, ingredients: [], products: [{ item: "science", amount: 1, type: "item" }] },
    ], "science", 60);
    expect(plan.root.machinesAtSpeedOne).toBe(5); expect(plan.rawDemandPerMinute.water).toBe(600); expect(plan.root.alternatives).toEqual(["science-alt"]);
    expect(() => planProduction([{ name: "loop", category: "x", energy: 1, enabled: true, ingredients: [{ item: "loop", amount: 1, type: "item" }], products: [{ item: "loop", amount: 1, type: "item" }] }], "loop", 1)).toThrow(/cycle/);
  });

  it("bounds worker concurrency and writes trajectory JSONL", () => {
    const scheduler = new WorkerScheduler(2); expect(scheduler.allocate([goal({ id: "1" }), goal({ id: "2" }), goal({ id: "3" })])).toHaveLength(2);
    const log = new TrajectoryLog("game", root()); log.append({ type: "goal_created", goalId: "g" }); expect(JSON.parse(fs.readFileSync(log.file, "utf8"))).toMatchObject({ type: "goal_created" });
  });
});

describe("player intent routing", () => {
  it.each([
    ["how is it going?", "status"], ["what are you working on?", "status"], ["come here", "tactical"],
    ["stop working on oil", "modify"], ["forget the rocket, build defenses instead", "replace"], ["continue", "resume"],
  ] as const)("routes %s as %s", (message, kind) => expect(deterministicIntent(message, true)?.kind).toBe(kind));

  it("requires deterministic evidence for physical tactical plans", () => {
    expect(deterministicTacticalPlan("come here")?.verification).toEqual([{ kind: "companion_near_player", maximumDistance: 5 }]);
    expect(() => tacticalPlanSchema.parse({ title: "move", description: "move", physical: true, expectedInputs: [], expectedOutput: "moved", definitionOfDone: "moved", verification: [{ kind: "manual", description: "model says so" }] })).toThrow(/deterministic verification/);
  });

  it("answers questions and tactical requests without replacing the campaign", async () => {
    const harness = fakeBridge(); const supervisor = new AutonomousSupervisor(harness.bridge, {} as never, {
      key: "chat", workers: 1, memoryRoot: root(), brokerRoot: root(), coordinatorGenerate: sequence(blockedPlan()), workerGenerate: async () => ({ ...completed(), status: "blocked", blocker: "awaiting player" }),
      intentClassifier: async ({ message }) => deterministicIntent(message, true)!,
    });
    await supervisor.start(); await supervisor.instruct({ id: 1, tick: 1, player: "P", text: "launch a rocket" }); await supervisor.whenIdle();
    const objective = supervisor.snapshot().objective; const cancelCount = harness.calls.filter((call) => call.method === "cancel").length;
    await supervisor.handleChat({ id: 2, tick: 2, player: "P", text: "how is it going?" });
    await supervisor.handleChat({ id: 3, tick: 3, player: "P", text: "come here" }); await supervisor.whenIdle();
    expect(supervisor.snapshot().objective).toBe(objective); expect(harness.calls.filter((call) => call.method === "cancel").length).toBe(cancelCount + 1); supervisor.dispose();
  });

  it("binds a come-here check to the leased companion and requesting player", async () => {
    const harness = fakeBridge(); let packetCheck: unknown; let rpcCheck: unknown;
    const supervisor = new AutonomousSupervisor(harness.bridge, {} as never, {
      key: "come-here-binding", workers: 1, memoryRoot: root(), brokerRoot: root(), coordinatorGenerate: sequence(blockedPlan()),
      workerGenerate: async ({ packet }) => { packetCheck = packet.verification[0]; return completed(); },
      verificationReader: { verify: async (checks) => {
        rpcCheck = checks[0];
        return { tick: 12, results: [{ kind: "companion_near_player", ok: true, actual: 3, expected: 5 }] };
      } },
      intentClassifier: async ({ message }) => deterministicIntent(message, true)!,
    });
    await supervisor.start();
    await supervisor.instruct({ id: 1, tick: 1, player: "P", text: "launch a rocket" }); await supervisor.whenIdle();
    await supervisor.handleChat({ id: 2, tick: 2, player: "P", text: "come here" }); await supervisor.whenIdle();
    expect(packetCheck).toMatchObject({ kind: "companion_near_player", companion: "Ada", player: "P", maximumDistance: 5 });
    expect(rpcCheck).toMatchObject({ kind: "companion_near_player", companion: "Ada", player: "P", maximum_distance: 5 });
    expect(supervisor.snapshot().goals.find((value) => value.verification.some((check) => check.kind === "companion_near_player"))?.job?.requestedBy).toBe("P");
    supervisor.dispose();
  });

  it("executes a first tactical command without creating a strategic campaign", async () => {
    const harness = fakeBridge(); let coordinatorCalls = 0; let packetCheck: unknown;
    const supervisor = new AutonomousSupervisor(harness.bridge, {} as never, {
      key: "direct-command", workers: 1, memoryRoot: root(), brokerRoot: root(),
      coordinatorGenerate: async () => { coordinatorCalls++; return blockedPlan(); },
      workerGenerate: async ({ packet }) => { packetCheck = packet.verification[0]; return completed(); },
      verificationReader: { verify: async () => ({ tick: 12, results: [{ kind: "companion_near_player", ok: true, actual: 3, expected: 5 }] }) },
      intentClassifier: async ({ message }) => deterministicIntent(message, false)!,
    });
    await supervisor.start(); await supervisor.handleChat({ id: 1, tick: 1, player: "P", text: "come here" }); await supervisor.whenIdle();
    const state = supervisor.snapshot();
    expect(packetCheck).toMatchObject({ companion: "Ada", player: "P" }); expect(coordinatorCalls).toBe(0);
    expect(state.objective).toBeNull(); expect(state.rootGoalId).toBeUndefined(); expect(state.campaignStatus).toBe("idle");
    expect(state.goals.some((value) => value.kind === "strategic" || value.kind === "campaign")).toBe(false);
    expect(state.goals.find((value) => value.kind === "tactical")?.status).toBe("done"); supervisor.dispose();
  });

  it("never creates a physical tactical goal backed only by worker prose", async () => {
    const harness = fakeBridge(); const supervisor = new AutonomousSupervisor(harness.bridge, {} as never, {
      key: "unsafe-tactical", workers: 1, memoryRoot: root(), brokerRoot: root(), coordinatorGenerate: sequence(blockedPlan()), workerGenerate: async () => completed(),
      intentClassifier: async () => ({ kind: "tactical", summary: "move", target: null }),
      tacticalPlanner: async () => ({ title: "Move", description: "move physically", physical: true, expectedInputs: [], expectedOutput: "moved", definitionOfDone: "moved", verification: [{ kind: "manual", description: "worker says moved" }] }),
    });
    await supervisor.start(); await supervisor.instruct({ id: 1, tick: 1, player: "P", text: "launch" }); await supervisor.whenIdle();
    await supervisor.handleChat({ id: 2, tick: 2, player: "P", text: "move somehow" });
    expect(supervisor.snapshot().goals.filter((value) => value.kind === "tactical")).toEqual([]); expect(harness.calls.some((call) => call.method === "say" && JSON.stringify(call.params).includes("safely verifiable"))).toBe(true); supervisor.dispose();
  });

  it("modifies only a matching subtree, replaces explicitly, resumes, and fails classification safely", async () => {
    const memoryRoot = root(); const brokerRoot = root(); const memory = freshMemory(); memory.objective = "launch rocket"; memory.campaignStatus = "stopped"; memory.paused = true;
    const graph = new GoalGraph(memory); const campaign = graph.create({ kind: "campaign", title: "launch rocket" }); graph.recover(campaign.id, "active"); memory.rootGoalId = campaign.id;
    const oil = graph.create({ kind: "strategic", parentId: campaign.id, title: "Oil" }); graph.recover(oil.id, "active"); graph.create({ parentId: oil.id, title: "Build oil" });
    const power = graph.create({ kind: "strategic", parentId: campaign.id, title: "Power" }); graph.recover(power.id, "active"); new MemoryStore("route", memoryRoot).save(memory);
    const harness = fakeBridge(); let fail = false;
    const supervisor = new AutonomousSupervisor(harness.bridge, {} as never, { key: "route", workers: 1, memoryRoot, brokerRoot, coordinatorGenerate: sequence(blockedPlan()), workerGenerate: async () => completed(), intentClassifier: async ({ message }) => { if (fail) throw new Error("bad classification"); return deterministicIntent(message, true)!; } });
    await supervisor.start(); await supervisor.handleChat({ id: 1, tick: 1, player: "P", text: "stop working on oil" });
    expect(supervisor.snapshot().goals.find((value) => value.title === "Oil")?.status).toBe("cancelled"); expect(supervisor.snapshot().goals.find((value) => value.title === "Power")?.status).toBe("active");
    await supervisor.handleChat({ id: 2, tick: 2, player: "P", text: "continue" }); expect(supervisor.snapshot().campaignStatus).toBe("running");
    fail = true; const before = supervisor.snapshot().objective; await supervisor.handleChat({ id: 3, tick: 3, player: "P", text: "ambiguous words" }); expect(supervisor.snapshot().objective).toBe(before);
    fail = false; await supervisor.handleChat({ id: 4, tick: 4, player: "P", text: "forget the rocket, build defenses instead" }); expect(supervisor.snapshot().objective).toContain("defenses"); supervisor.dispose();
  });

  it("reaffirms normalized duplicate objectives without replacing the campaign", async () => {
    const harness = fakeBridge(); const supervisor = new AutonomousSupervisor(harness.bridge, {} as never, { key: "duplicate-objective", workers: 1, memoryRoot: root(), brokerRoot: root(), coordinatorGenerate: sequence(blockedPlan()), workerGenerate: async () => completed(), intentClassifier: async ({ message }) => ({ kind: "replace", summary: message, target: message }) });
    await supervisor.start(); await supervisor.instruct({ id: 1, tick: 1, player: "P", text: "Automate iron plate production." }); await supervisor.whenIdle();
    const before = supervisor.snapshot(); const cancelCount = harness.calls.filter((call) => call.method === "cancel").length;
    for (const [index, text] of ["Automate iron plate production.", "automate iron plate production", " AUTOMATE IRON PLATE PRODUCTION. "].entries()) {
      await supervisor.handleChat({ id: index + 2, tick: index + 2, player: "P", text }); await supervisor.whenIdle();
      const state = supervisor.snapshot(); expect(state.rootGoalId).toBe(before.rootGoalId); expect(state.goals.map((goal) => goal.id)).toEqual(before.goals.map((goal) => goal.id));
    }
    expect(harness.calls.filter((call) => call.method === "cancel").length).toBe(cancelCount); supervisor.dispose();
  });
});

describe("coordinator semantic plan resolution", () => {
  const strategic = (title: string, parentTitle?: string) => ({ title, description: title, priority: 1, verification: [], parentTitle });
  const campaignMemory = (title = "Automate iron plate production.") => {
    const memory = freshMemory(); memory.objective = title; const graph = new GoalGraph(memory);
    const rootGoal = graph.create({ id: "campaign-id", kind: "campaign", title }); graph.recover(rootGoal.id, "active"); memory.rootGoalId = rootGoal.id; return memory;
  };

  it.each([undefined, "Automate iron plate production", "AUTOMATE IRON PLATE PRODUCTION.", "root", "campaign", "campaign-id"])("resolves top-level root alias %s", (parentTitle) => {
    const resolved = resolveCoordinatorPlan(campaignMemory(), { strategicGoals: [strategic("Smelting", parentTitle)], goals: [] });
    expect(resolved.strategic[0]?.parentId).toBe("campaign-id");
  });

  it("topologically resolves a child before its proposed parent", () => {
    const resolved = resolveCoordinatorPlan(campaignMemory(), { strategicGoals: [strategic("Furnaces", "Smelting"), strategic("Smelting")], goals: [] });
    expect(resolved.strategic.map((value) => value.input.title)).toEqual(["Smelting", "Furnaces"]);
    expect(resolved.strategic[1]?.parentId).toBe(resolved.strategic[0]?.id);
  });

  it.each([
    ["unknown", [strategic("Furnaces", "Completely nonexistent branch")]],
    ["self", [strategic("Smelting", "Smelting")]],
    ["cycle", [strategic("A", "B"), strategic("B", "A")]],
  ])("rejects %s parent graphs without mutation", (_name, strategicGoals) => {
    const memory = campaignMemory(); const before = structuredClone(memory.goals);
    expect(() => resolveCoordinatorPlan(memory, { strategicGoals: strategicGoals as ReturnType<typeof strategic>[], goals: [] })).toThrow();
    expect(memory.goals).toEqual(before);
  });

  it("repairs once, rejects a second unknown parent, and never speaks rejected progress", async () => {
    const harness = fakeBridge(); let calls = 0; const contexts: string[] = [];
    const invalid: CoordinatorPlan = { decision: "start", objectiveComplete: false, campaignVerification: [], completeStrategicGoals: [], goals: [], strategicGoals: [strategic("Smelting", "Completely nonexistent branch")], playerMessage: "Kicking off iron automation..." };
    const supervisor = new AutonomousSupervisor(harness.bridge, {} as never, { key: "semantic-reject", workers: 1, memoryRoot: root(), brokerRoot: root(), coordinatorGenerate: async ({ context }) => { calls++; contexts.push(context); return invalid; }, workerGenerate: async () => completed() });
    await supervisor.start(); await supervisor.instruct({ id: 1, tick: 1, player: "P", text: "Automate iron plate production." }); await supervisor.whenIdle();
    const state = supervisor.snapshot(); expect(calls).toBe(2); expect(contexts[1]).toContain("unknown parent Completely nonexistent branch"); expect(state.campaignStatus).toBe("blocked");
    expect(state.goals.filter((value) => value.kind !== "campaign")).toEqual([]);
    expect(harness.calls.some((call) => call.method === "say" && JSON.stringify(call.params).includes("Kicking off"))).toBe(false);
    expect(harness.calls.some((call) => call.method === "say" && JSON.stringify(call.params).includes("not started any new work"))).toBe(true);
    supervisor.dispose();
  });

  it("records structured-output diagnostics and supplies them to the single repair attempt", async () => {
    const harness = fakeBridge(); const memoryRoot = root(); const contexts: string[] = []; let calls = 0;
    const generated = '{"decision":"start","goals":"not-an-array","playerMessage":"Starting now"}';
    const noObject = new NoObjectGeneratedError({
      message: "No object generated: response did not match schema",
      cause: new Error("goals: expected array, received string"), text: generated,
      finishReason: "stop", response: { id: "test-response", timestamp: new Date(), modelId: "test-model" },
      usage: { inputTokens: 100, outputTokens: 25, totalTokens: 125 } as never,
    });
    const invalidRepair: CoordinatorPlan = { decision: "start", objectiveComplete: false, campaignVerification: [], completeStrategicGoals: [], goals: [], strategicGoals: [{ title: "Smelting", description: "Smelt", priority: 1, verification: [], parentTitle: "Missing" }], playerMessage: "Starting now" };
    const supervisor = new AutonomousSupervisor(harness.bridge, {} as never, { key: "no-object-diagnostics", workers: 1, memoryRoot, brokerRoot: root(), coordinatorGenerate: async ({ context }) => { contexts.push(context); if (calls++ === 0) throw noObject; return invalidRepair; }, workerGenerate: async () => completed() });
    await supervisor.start(); await supervisor.instruct({ id: 1, tick: 1, player: "P", text: "Automate iron." }); await supervisor.whenIdle();
    expect(calls).toBe(2); expect(contexts[1]).toContain("goals: expected array, received string"); expect(contexts[1]).toContain(generated); expect(contexts[1]).toContain("conforms exactly to the required coordinator schema");
    const events = fs.readFileSync(new TrajectoryLog("no-object-diagnostics", memoryRoot).file, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { type: string; data?: Record<string, unknown> });
    const rejection = events.find((event) => event.type === "coordinator_plan_rejected" && event.data?.attempt === 1);
    expect(rejection?.data).toMatchObject({ finishReason: "stop", text: generated, cause: "Error: goals: expected array, received string" });
    expect(rejection?.data?.usage).toMatchObject({ inputTokens: 100, outputTokens: 25 });
    expect(harness.calls.some((call) => call.method === "say" && JSON.stringify(call.params).includes("Starting now"))).toBe(false);
    expect(supervisor.snapshot().campaignStatus).toBe("blocked"); supervisor.dispose();
  });

  it("accepts the observed punctuation-mismatched root parent", async () => {
    const harness = fakeBridge(); const plan: CoordinatorPlan = { decision: "start", objectiveComplete: false, campaignVerification: [], completeStrategicGoals: [], goals: [], strategicGoals: [strategic("Automate iron plate production", "Automate iron plate production")] };
    const supervisor = new AutonomousSupervisor(harness.bridge, {} as never, { key: "punctuation-root", workers: 1, memoryRoot: root(), brokerRoot: root(), coordinatorGenerate: sequence(plan, blockedPlan()), workerGenerate: async () => completed() });
    await supervisor.start(); await supervisor.instruct({ id: 1, tick: 1, player: "P", text: "Automate iron plate production." }); await supervisor.whenIdle();
    const state = supervisor.snapshot(); const child = state.goals.find((value) => value.kind === "strategic"); expect(child?.parentId).toBe(state.rootGoalId); supervisor.dispose();
  });

  it("spawns generic companions only for non-autonomous brains", () => {
    expect(shouldSpawnGenericCompanion("autonomous")).toBe(false); expect(shouldSpawnGenericCompanion("api")).toBe(true); expect(shouldSpawnGenericCompanion("codex")).toBe(true);
  });

  it("rejects unknown and resource-misclassified verification prototypes before execution", async () => {
    for (const [key, verification, expected] of [
      ["unknown-prototype", { kind: "entity_count", entity: "iron-smelter", minimum: 1, area: { x: 0, y: 0, radius: 5 } }, "unknown verification prototype"],
      ["resource-as-entity", { kind: "entity_count", entity: "iron-ore", minimum: 8, area: { x: -34, y: 83.5, radius: 20 } }, "use resource_count"],
    ] as const) {
      const harness = fakeBridge(); let workers = 0; const contexts: string[] = [];
      const plan: CoordinatorPlan = { decision: "survey", objectiveComplete: false, campaignVerification: [], strategicGoals: [], goals: [{ title: "Survey", description: "survey", priority: 1, dependsOnTitles: [], expectedInputs: [], expectedOutput: "site", definitionOfDone: "verified", verification: [verification] }] };
      const supervisor = new AutonomousSupervisor(harness.bridge, {} as never, { key, workers: 1, memoryRoot: root(), brokerRoot: root(), coordinatorGenerate: async ({ context }) => { contexts.push(context); return plan; }, workerGenerate: async () => { workers++; return completed(); } });
      await supervisor.start(); await supervisor.instruct({ id: 1, tick: 1, player: "P", text: "survey" }); await supervisor.whenIdle();
      expect(contexts).toHaveLength(2); expect(contexts[1]).toContain(expected); expect(workers).toBe(0); expect(supervisor.snapshot().goals.filter((goal) => goal.kind === "tactical")).toEqual([]); supervisor.dispose();
    }
  });

  it("accepts a canonical player entity verification prototype", async () => {
    const harness = fakeBridge(); let workers = 0;
    const plan: CoordinatorPlan = { decision: "inspect", objectiveComplete: false, campaignVerification: [], strategicGoals: [], goals: [{ title: "Inspect assembler", description: "inspect assembler", priority: 1, dependsOnTitles: [], expectedInputs: [], expectedOutput: "assembler", definitionOfDone: "assembler exists", verification: [{ kind: "entity_count", entity: "assembling-machine-1", minimum: 1, area: { x: 0, y: 0, radius: 5 } }] }] };
    const supervisor = new AutonomousSupervisor(harness.bridge, {} as never, { key: "canonical-prototype", workers: 1, memoryRoot: root(), brokerRoot: root(), coordinatorGenerate: sequence(plan, blockedPlan()), workerGenerate: async () => { workers++; return completed(); }, verificationReader: { verify: async () => ({ tick: 4, results: [{ kind: "entity_count", ok: true, actual: 1, expected: 1 }] }) } });
    await supervisor.start(); await supervisor.instruct({ id: 1, tick: 1, player: "P", text: "inspect" }); await supervisor.whenIdle(); expect(workers).toBe(1); expect(supervisor.snapshot().goals.find((goal) => goal.title === "Inspect assembler")?.status).toBe("done"); supervisor.dispose();
  });

  it("rejects a staged multi-leaf wave, repairs to survey only, then replans after resource verification", async () => {
    const harness = fakeBridge(); const workerObjectives: string[] = []; let coordinatorCalls = 0;
    const strategicGoals = [strategic("Locate iron"), strategic("Build smelting"), strategic("Verify output")];
    const survey = { title: "Locate ore", parentTitle: "Locate iron", description: "locate iron ore", priority: 10, dependsOnTitles: [], expectedInputs: [], expectedOutput: "iron coordinates", definitionOfDone: "resource patch verified", verification: [{ kind: "resource_count" as const, resource: "iron-ore", minimum: 8, area: { x: -34, y: 83.5, radius: 20 } }] };
    const build = { title: "Build line", parentTitle: "Build smelting", description: "build mining and smelting line", priority: 9, dependsOnTitles: [], area: { x: -34, y: 83.5, radius: 20 }, expectedInputs: ["starter materials"], expectedOutput: "iron plates", definitionOfDone: "line built", verification: [{ kind: "event_count" as const, event: "rocket_launched" as const, minimum: 1 }] };
    const verify = { title: "Verify production", parentTitle: "Verify output", description: "verify iron output", priority: 8, dependsOnTitles: [], expectedInputs: [], expectedOutput: "rate", definitionOfDone: "rate verified", verification: [{ kind: "production" as const, item: "iron-plate", minimumPerMinute: 1 }] };
    const staged: CoordinatorPlan = { decision: "all stages", objectiveComplete: false, campaignVerification: [], strategicGoals, goals: [survey, build, verify], playerMessage: "Building everything now" };
    const surveyOnly: CoordinatorPlan = { decision: "survey first", objectiveComplete: false, campaignVerification: [], strategicGoals, goals: [survey], playerMessage: "Surveying the ore site" };
    const buildOnly: CoordinatorPlan = { decision: "build after survey", objectiveComplete: false, campaignVerification: [], strategicGoals, goals: [build], playerMessage: "The verified site is ready for construction" };
    const plans = [staged, surveyOnly, buildOnly, blockedPlan()];
    const supervisor = new AutonomousSupervisor(harness.bridge, {} as never, { key: "iron-stages", workers: 1, memoryRoot: root(), brokerRoot: root(), coordinatorGenerate: async () => plans[Math.min(coordinatorCalls++, plans.length - 1)]!, workerGenerate: async ({ packet }) => { workerObjectives.push(packet.objective); return completed(); }, verificationReader: { verify: async (checks) => ({ tick: 20, results: checks.map((check) => ({ kind: check.kind, ok: true, actual: check.kind === "resource_count" ? 735 : 1, expected: check.kind === "resource_count" ? 8 : 1 })) }) } });
    await supervisor.start(); await supervisor.instruct({ id: 1, tick: 1, player: "P", text: "Automate iron plate production." }); await supervisor.whenIdle();
    expect(workerObjectives).toEqual(["locate iron ore", "build mining and smelting line"]); expect(coordinatorCalls).toBeGreaterThanOrEqual(4);
    expect(harness.calls.some((call) => call.method === "say" && JSON.stringify(call.params).includes("Building everything now"))).toBe(false);
    expect(supervisor.snapshot().goals.find((goal) => goal.title === "Locate ore")?.evidence.some((item) => item.includes("actual=735"))).toBe(true); supervisor.dispose();
  });

  it("replans after failed resource verification without dispatching downstream construction", async () => {
    const harness = fakeBridge(); let coordinatorCalls = 0; let workers = 0; const contexts: string[] = [];
    const survey: CoordinatorPlan = { decision: "survey", objectiveComplete: false, campaignVerification: [], strategicGoals: [strategic("Locate iron")], goals: [{ title: "Locate ore", parentTitle: "Locate iron", description: "locate iron ore", priority: 10, dependsOnTitles: [], expectedInputs: [], expectedOutput: "iron coordinates", definitionOfDone: "resource patch verified", verification: [{ kind: "resource_count", resource: "iron-ore", minimum: 8, area: { x: -34, y: 83.5, radius: 20 } }] }] };
    const supervisor = new AutonomousSupervisor(harness.bridge, {} as never, { key: "iron-blocked", workers: 1, memoryRoot: root(), brokerRoot: root(), coordinatorGenerate: async ({ context }) => { contexts.push(context); return coordinatorCalls++ === 0 ? survey : blockedPlan(); }, workerGenerate: async () => { workers++; return completed("ore observed in scan"); }, verificationReader: { verify: async () => ({ tick: 20, results: [{ kind: "resource_count", ok: false, actual: 0, expected: 8 }] }) } });
    await supervisor.start(); await supervisor.instruct({ id: 1, tick: 1, player: "P", text: "Automate iron plate production." }); await supervisor.whenIdle();
    expect(workers).toBe(3); expect(supervisor.snapshot().goals.find((goal) => goal.title === "Locate ore")?.status).toBe("blocked");
    expect(contexts.at(-1)).toContain("resource_count: actual=0 expected=8 fail"); expect(supervisor.snapshot().goals.some((goal) => goal.title.includes("Build"))).toBe(false); supervisor.dispose();
  });
});

describe("structured worker lifecycle and campaign completion", () => {
  async function runWorker(result: WorkerResult, verificationOk: boolean) {
    const harness = fakeBridge(); harness.verificationOk.value = verificationOk;
    const supervisor = new AutonomousSupervisor(harness.bridge, {} as never, {
      key: `worker-${Math.random()}`, workers: 1, memoryRoot: root(), brokerRoot: root(),
      coordinatorGenerate: sequence(wave(), blockedPlan()), workerGenerate: async () => result,
      verificationReader: { verify: async () => ({ tick: 12, results: [{ kind: "event_count", ok: verificationOk, actual: verificationOk ? 1 : 0, expected: 1 }] }) },
    });
    await supervisor.start(); await supervisor.instruct({ id: 1, tick: 1, player: "P", text: "launch" }); await supervisor.whenIdle(); return { supervisor, harness };
  }

  it("accepts completed work only when deterministic verification passes", async () => {
    const passed = await runWorker(completed(), true); expect(passed.supervisor.snapshot().goals.find((value) => value.kind === "tactical")?.status).toBe("done"); passed.supervisor.dispose();
  });

  it("retries completed work when verification fails", async () => {
    const failed = await runWorker(completed(), false); const leaf = failed.supervisor.snapshot().goals.find((value) => value.kind === "tactical"); expect(leaf?.status).not.toBe("done"); expect(leaf!.attempts).toBe(3); failed.supervisor.dispose();
  });

  it.each([
    [{ status: "blocked", summary: "no materials", evidence: [], discoveries: [], blocker: "need steel", toolSteps: 3 } as WorkerResult, "blocked"],
    [{ status: "failed", summary: "tool failed", evidence: [], discoveries: [], blocker: "path failed", toolSteps: 18 } as WorkerResult, "blocked"],
  ] as const)("handles worker %s", async (result, expected) => { const run = await runWorker(result, true); expect(run.supervisor.snapshot().goals.find((value) => value.kind === "tactical")?.status).toBe(expected); run.supervisor.dispose(); });

  it("bounds malformed worker output failures and cleans up physical ownership", async () => {
    let calls = 0;
    const harness = fakeBridge(); const supervisor = new AutonomousSupervisor(harness.bridge, {} as never, { key: "malformed", workers: 1, memoryRoot: root(), brokerRoot: root(), coordinatorGenerate: sequence(wave(), blockedPlan()), workerGenerate: async () => { calls++; throw new Error("malformed structured output"); } });
    await supervisor.start(); await supervisor.instruct({ id: 1, tick: 1, player: "P", text: "launch" }); await supervisor.whenIdle();
    expect(calls).toBe(3); expect(harness.calls.some((call) => call.method === "cancel" && call.companion === "Ada")).toBe(true); expect(supervisor.snapshot().activeJobs).toEqual([]); supervisor.dispose();
  });

  it("refuses premature campaign completion without passing physical evidence", async () => {
    const harness = fakeBridge(); harness.verificationOk.value = false;
    const premature: CoordinatorPlan = { decision: "done", goals: [], strategicGoals: [], objectiveComplete: true, blockedReason: "stop after rejection", campaignVerification: [{ kind: "event_count", event: "rocket_launched", minimum: 1 }] };
    const supervisor = new AutonomousSupervisor(harness.bridge, {} as never, { key: "premature", workers: 1, memoryRoot: root(), brokerRoot: root(), coordinatorGenerate: sequence(premature), workerGenerate: async () => completed() });
    await supervisor.start(); await supervisor.instruct({ id: 1, tick: 1, player: "P", text: "launch rocket" }); await supervisor.whenIdle();
    expect(supervisor.snapshot().campaignStatus).not.toBe("completed"); expect(supervisor.snapshot().goals.find((value) => value.kind === "campaign")?.status).toBe("active"); supervisor.dispose();
  });

  it("completes a campaign only after root physical verification passes", async () => {
    const harness = fakeBridge(); harness.verificationOk.value = true;
    const final: CoordinatorPlan = { decision: "verified", goals: [], strategicGoals: [], objectiveComplete: true, campaignVerification: [{ kind: "event_count", event: "rocket_launched", minimum: 1 }] };
    const supervisor = new AutonomousSupervisor(harness.bridge, {} as never, { key: "complete", workers: 1, memoryRoot: root(), brokerRoot: root(), coordinatorGenerate: sequence(final), workerGenerate: async () => completed() });
    await supervisor.start(); await supervisor.instruct({ id: 1, tick: 1, player: "P", text: "launch rocket" }); await supervisor.whenIdle();
    expect(supervisor.snapshot().campaignStatus).toBe("completed"); expect(supervisor.snapshot().goals.find((value) => value.kind === "campaign")?.status).toBe("done"); supervisor.dispose();
  });

  it("keeps strategic goals open across incremental waves until explicitly completed", async () => {
    const memoryRoot = root(); const brokerRoot = root(); const harness = fakeBridge();
    const result: WorkerResult = { ...completed(), discoveries: [{ category: "resourcePatch", summary: "iron near base", position: { x: 4, y: 5 } }, { category: "blueprint", summary: "Power book" }] };
    const red: CoordinatorPlan = { decision: "red wave", objectiveComplete: false, campaignVerification: [], strategicGoals: [{ title: "Science", description: "All required science", priority: 8 }], goals: [{ ...wave("Red science").goals[0]!, title: "Red science", parentTitle: "Science" }] };
    const supervisor = new AutonomousSupervisor(harness.bridge, {} as never, { key: "hierarchy", workers: 1, memoryRoot, brokerRoot, coordinatorGenerate: sequence(red, blockedPlan()), workerGenerate: async () => result });
    await supervisor.start(); await supervisor.instruct({ id: 1, tick: 1, player: "P", text: "launch rocket" }); await supervisor.whenIdle();
    const first = supervisor.snapshot(); const rootGoal = first.goals.find((value) => value.kind === "campaign")!; const science = first.goals.find((value) => value.title === "Science")!; const redGoal = first.goals.find((value) => value.title === "Red science")!;
    expect(science.status).toBe("active"); expect(redGoal.status).toBe("done"); expect(redGoal.parentId).toBe(science.id); supervisor.dispose();
    const green: CoordinatorPlan = { decision: "green wave", objectiveComplete: false, campaignVerification: [], strategicGoals: [{ title: "Science", description: "All required science", priority: 8 }], goals: [{ ...wave("Green science").goals[0]!, title: "Green science", parentTitle: "Science" }] };
    const closeScience: CoordinatorPlan = { decision: "science complete", objectiveComplete: false, campaignVerification: [], strategicGoals: [], goals: [], completeStrategicGoals: ["Science"] };
    const resumed = new AutonomousSupervisor(harness.bridge, {} as never, { key: "hierarchy", workers: 1, memoryRoot, brokerRoot, coordinatorGenerate: sequence(green, closeScience), workerGenerate: async () => result }); await resumed.start(); await resumed.handleChat({ id: 2, tick: 2, player: "P", text: "continue" }); await resumed.whenIdle();
    const second = resumed.snapshot(); const sameScience = second.goals.find((value) => value.title === "Science")!; const greenGoal = second.goals.find((value) => value.title === "Green science")!;
    expect(sameScience.id).toBe(science.id); expect(greenGoal.parentId).toBe(science.id); expect(sameScience.status).toBe("done"); expect(sameScience.parentId).toBe(rootGoal.id); expect(second.resourcePatches.some((value) => value.source === "model" && !value.confirmed)).toBe(true); resumed.dispose();
  });

  it("renews ownership and releases reservation after completion", async () => {
    const harness = fakeBridge(); const brokerRoot = root(); let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    const supervisor = new AutonomousSupervisor(harness.bridge, {} as never, { key: "renew", workers: 1, memoryRoot: root(), brokerRoot, workerRenewalMs: 20, coordinatorGenerate: sequence({ ...wave("Build belts"), goals: [{ ...wave("Build belts").goals[0]!, description: "build belts", area: { x: 0, y: 0, radius: 8 } }] }, blockedPlan()), workerGenerate: async () => { await gate; return completed(); } });
    await supervisor.start(); await supervisor.instruct({ id: 1, tick: 1, player: "P", text: "build" }); await new Promise((resolve) => setTimeout(resolve, 70)); release(); await supervisor.whenIdle();
    const snapshot = await new CoordinationBroker("renew", brokerRoot).snapshot();
    expect(supervisor.snapshot().activeJobs).toEqual([]); expect(snapshot.leases).toEqual([]); expect(snapshot.reservations).toEqual([]); expect(snapshot.agents.find((value) => value.id === "local-worker-1")!.lastSeen).toBeGreaterThan(snapshot.agents.find((value) => value.id === "local-worker-1")!.createdAt); expect(harness.calls.some((call) => call.method === "cancel" && call.companion === "Ada")).toBe(true); supervisor.dispose();
  });

  it("cancels companion work and releases ownership on model timeout", async () => {
    const harness = fakeBridge(); const brokerRoot = root();
    const supervisor = new AutonomousSupervisor(harness.bridge, {} as never, { key: "timeout", workers: 1, memoryRoot: root(), brokerRoot, modelTimeoutMs: 30, coordinatorGenerate: sequence(wave(), blockedPlan()), workerGenerate: async ({ signal }) => new Promise<WorkerResult>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })) });
    await supervisor.start(); await supervisor.instruct({ id: 1, tick: 1, player: "P", text: "launch" }); await supervisor.whenIdle();
    const broker = await new CoordinationBroker("timeout", brokerRoot).snapshot(); expect(broker.leases).toEqual([]); expect(broker.reservations).toEqual([]); expect(harness.calls.some((call) => call.method === "cancel" && call.companion === "Ada")).toBe(true); supervisor.dispose();
  });

  it("supplies deterministic production math to strategic planning", async () => {
    const harness = fakeBridge(); let context = "";
    const supervisor = new AutonomousSupervisor(harness.bridge, {} as never, { key: "math", workers: 1, memoryRoot: root(), brokerRoot: root(), coordinatorGenerate: async (input) => { context = input.context; return blockedPlan(); }, workerGenerate: async () => completed() });
    await supervisor.start(); await supervisor.instruct({ id: 1, tick: 1, player: "P", text: "produce automation-science-pack 60/min" }); await supervisor.whenIdle();
    expect(harness.calls.some((call) => call.method === "get_recipe_graph")).toBe(true); expect(context).toContain("productionPlans"); supervisor.dispose();
  });

  it("hard stop remains deterministic", async () => {
    const harness = fakeBridge(); const supervisor = new AutonomousSupervisor(harness.bridge, {} as never, { key: "stop", workers: 1, memoryRoot: root(), brokerRoot: root(), coordinatorGenerate: sequence(blockedPlan()), workerGenerate: async () => completed() }); await supervisor.start(); await supervisor.stop();
    expect(supervisor.snapshot()).toMatchObject({ paused: true, campaignStatus: "stopped" }); supervisor.dispose();
  });
});
