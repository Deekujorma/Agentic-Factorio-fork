import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { configDir } from "../config.js";
import { atomicWriteFile } from "../setup/atomic.js";

export const observedFactSchema = z.object({
  id: z.string().min(1),
  summary: z.string().min(1),
  observedAt: z.string().datetime(),
  tick: z.number().int().nonnegative().optional(),
  position: z.object({ x: z.number(), y: z.number() }).optional(),
  staleAfterTick: z.number().int().nonnegative().optional(),
  source: z.enum(["game", "model"]).default("game"),
  confirmed: z.boolean().default(true),
});
export type ObservedFact = z.infer<typeof observedFactSchema>;

const areaSchema = z.object({ x: z.number(), y: z.number(), radius: z.number().positive().max(256) });
export const verificationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("goal_dependencies"), goalIds: z.array(z.string()).min(1) }),
  z.object({ kind: z.literal("entity_count"), entity: z.string(), minimum: z.number().int().nonnegative(), area: areaSchema }),
  z.object({ kind: z.literal("resource_count"), resource: z.string(), minimum: z.number().int().nonnegative(), area: areaSchema }),
  z.object({ kind: z.literal("inventory"), item: z.string(), minimum: z.number().nonnegative(), unitNumber: z.number().int().positive().optional(), position: z.object({ x: z.number(), y: z.number() }).optional() }),
  z.object({ kind: z.literal("research"), technology: z.string() }),
  z.object({ kind: z.literal("production"), item: z.string(), minimumPerMinute: z.number().nonnegative() }),
  z.object({ kind: z.literal("operational"), entity: z.string(), minimum: z.number().int().positive().default(1), area: areaSchema }),
  z.object({ kind: z.literal("no_factory_blocker"), area: areaSchema, entity: z.string().optional() }),
  z.object({ kind: z.literal("event_count"), event: z.enum(["rocket_launched"]), minimum: z.number().int().positive(), afterTick: z.number().int().nonnegative().optional() }),
  z.object({ kind: z.literal("companion_near_player"), companion: z.string().optional(), player: z.string().optional(), maximumDistance: z.number().positive().max(32) }),
  z.object({ kind: z.literal("manual"), description: z.string().min(1) }),
]);
export type Verification = z.infer<typeof verificationSchema>;

export const goalStatusSchema = z.enum(["pending", "ready", "active", "verifying", "blocked", "done", "failed", "cancelled"]);
export type GoalStatus = z.infer<typeof goalStatusSchema>;
export const goalSchema = z.object({
  id: z.string().min(1),
  parentId: z.string().optional(),
  kind: z.enum(["campaign", "strategic", "tactical"]).default("tactical"),
  title: z.string().min(1),
  description: z.string().min(1),
  status: goalStatusSchema,
  priority: z.number().int().min(-100).max(100),
  dependencies: z.array(z.string()),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  attempts: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive().default(3),
  blockers: z.array(z.string()),
  verification: z.array(verificationSchema),
  evidence: z.array(z.string()),
  result: z.string().optional(),
  nextReviewAt: z.string().datetime().optional(),
  job: z.object({
    area: areaSchema.optional(), expectedInputs: z.array(z.string()), expectedOutput: z.string(), definitionOfDone: z.string(), requestedBy: z.string().optional(), waveId: z.string().optional(),
  }).optional(),
});
export type Goal = z.infer<typeof goalSchema>;

export const activeJobSchema = z.object({
  jobId: z.string(), goalId: z.string(), workerId: z.string(), companion: z.string(),
  startedAt: z.string().datetime(), areaReservationId: z.string().optional(),
});
export type ActiveJob = z.infer<typeof activeJobSchema>;

export const autonomousMemorySchema = z.object({
  schemaVersion: z.literal(3),
  rootGoalId: z.string().optional(),
  campaignStartedTick: z.number().int().nonnegative().optional(),
  objective: z.string().nullable(),
  objectiveHistory: z.array(z.object({ objective: z.string(), at: z.string().datetime(), player: z.string().optional() })),
  goals: z.array(goalSchema),
  knownAreas: z.array(observedFactSchema),
  productionLines: z.array(observedFactSchema),
  resourcePatches: z.array(observedFactSchema),
  importantEntities: z.array(observedFactSchema),
  infrastructure: z.array(observedFactSchema),
  research: z.array(observedFactSchema),
  knownBlueprints: z.array(observedFactSchema),
  blockers: z.array(z.string()),
  decisions: z.array(z.string()),
  failedApproaches: z.array(z.string()),
  recentAchievements: z.array(z.string()),
  nextStrategicActions: z.array(z.string()),
  activeJobs: z.array(activeJobSchema),
  paused: z.boolean(),
  campaignStatus: z.enum(["idle", "running", "blocked", "completed", "stopped"]),
  stopReason: z.string().optional(),
  timestamps: z.object({ createdAt: z.string().datetime(), updatedAt: z.string().datetime(), lastCheckpointAt: z.string().datetime() }),
});
export type AutonomousMemory = z.infer<typeof autonomousMemorySchema>;

export function freshMemory(): AutonomousMemory {
  const now = new Date().toISOString();
  return {
    schemaVersion: 3, objective: null, objectiveHistory: [], goals: [], knownAreas: [], productionLines: [],
    resourcePatches: [], importantEntities: [], infrastructure: [], research: [], knownBlueprints: [], blockers: [],
    decisions: [], failedApproaches: [], recentAchievements: [], nextStrategicActions: [], activeJobs: [], paused: false,
    campaignStatus: "idle", timestamps: { createdAt: now, updatedAt: now, lastCheckpointAt: now },
  };
}

function migrate(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const old = value as Record<string, unknown>;
  if (old.schemaVersion === 2) {
    return {
      ...old, schemaVersion: 3, campaignStatus: old.campaignStatus ?? (old.paused ? "stopped" : "running"),
      goals: Array.isArray(old.goals) ? old.goals.map((goal) => ({ ...(goal as object), kind: "tactical" })) : [],
    };
  }
  if (old.schemaVersion !== 1) return value;
  const now = new Date().toISOString();
  return { ...old, schemaVersion: 3, activeJobs: [], campaignStatus: old.paused ? "stopped" : "running", stopReason: undefined, goals: Array.isArray(old.goals) ? old.goals.map((goal) => ({ ...(goal as object), kind: "tactical" })) : [], timestamps: { ...(old.timestamps as object), lastCheckpointAt: now } };
}

function normalizeCampaign(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const memory = value as Record<string, unknown>; const objective = memory.objective;
  if (typeof objective !== "string" || objective.length === 0) return value;
  const goals = Array.isArray(memory.goals) ? memory.goals as Array<Record<string, unknown>> : [];
  const currentRoot = typeof memory.rootGoalId === "string" ? goals.find((goal) => goal.id === memory.rootGoalId && goal.kind === "campaign") : undefined;
  if (currentRoot) return value;
  let id = "campaign-root-migrated"; let suffix = 1;
  while (goals.some((goal) => goal.id === id)) id = `campaign-root-migrated-${suffix++}`;
  const timestamps = memory.timestamps as { createdAt?: string; updatedAt?: string } | undefined; const now = new Date().toISOString();
  const campaignStatus = memory.campaignStatus;
  goals.push({
    id, kind: "campaign", title: objective, description: objective,
    status: campaignStatus === "completed" ? "done" : "active", priority: 100, dependencies: [],
    createdAt: timestamps?.createdAt ?? now, updatedAt: timestamps?.updatedAt ?? now,
    attempts: 0, maxAttempts: 3, blockers: [], verification: [], evidence: ["campaign root repaired during memory migration"],
  });
  for (const goal of goals) if (goal.id !== id && goal.parentId === undefined) goal.parentId = id;
  const activeGoalIds = new Set(Array.isArray(memory.activeJobs) ? (memory.activeJobs as Array<Record<string, unknown>>).map((job) => job.goalId) : []);
  for (const goal of goals) if (goal.id !== id && goal.kind === "tactical" && goal.status === "active" && !activeGoalIds.has(goal.id)) {
    goal.status = "ready"; goal.updatedAt = now; goal.evidence = [...(Array.isArray(goal.evidence) ? goal.evidence : []), "orphaned active goal recovered during memory migration"];
  }
  memory.goals = goals; memory.rootGoalId = id;
  return memory;
}

export class MemoryStore {
  readonly file: string;
  constructor(readonly key: string, root = path.join(configDir(), "autonomous")) {
    this.file = path.join(root, `${key.replace(/[^\w.-]/g, "_")}.json`);
  }
  load(): AutonomousMemory {
    try {
      return autonomousMemorySchema.parse(normalizeCampaign(migrate(JSON.parse(fs.readFileSync(this.file, "utf8")))));
    } catch (error) {
      if (fs.existsSync(this.file)) {
        const backup = `${this.file}.corrupt-${Date.now()}`;
        try { fs.renameSync(this.file, backup); } catch { /* retain original if backup fails */ }
        console.warn(`autonomous memory was invalid; starting fresh (${error instanceof Error ? error.message : error})`);
      }
      return freshMemory();
    }
  }
  save(value: AutonomousMemory): void {
    const now = new Date().toISOString();
    value.timestamps.updatedAt = now; value.timestamps.lastCheckpointAt = now;
    const parsed = autonomousMemorySchema.parse(value);
    atomicWriteFile(this.file, `${JSON.stringify(parsed, null, 2)}\n`, 0o600);
  }
  reset(): void {
    fs.rmSync(this.file, { force: true });
    fs.rmSync(this.file.replace(/\.json$/, ".jsonl"), { force: true });
    const dir = path.dirname(this.file); const prefix = `${path.basename(this.file)}.corrupt-`;
    if (fs.existsSync(dir)) for (const name of fs.readdirSync(dir)) if (name.startsWith(prefix)) fs.rmSync(path.join(dir, name), { force: true });
  }
}
