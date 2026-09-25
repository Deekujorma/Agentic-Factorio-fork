import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { configDir } from "../config.js";
import { atomicWriteFile } from "../setup/atomic.js";

const observation = z.object({ id: z.string(), summary: z.string(), observedAt: z.string(), tick: z.number().optional() });
export const verificationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("goal_dependencies"), goalIds: z.array(z.string()) }),
  z.object({ kind: z.literal("entity_count"), entity: z.string(), minimum: z.number().int().nonnegative(), area: z.object({ x: z.number(), y: z.number(), radius: z.number().positive() }) }),
  z.object({ kind: z.literal("research"), technology: z.string() }),
  z.object({ kind: z.literal("inventory"), item: z.string(), minimum: z.number().nonnegative(), entityId: z.number().optional() }),
  z.object({ kind: z.literal("production"), item: z.string(), minimumPerMinute: z.number().nonnegative(), area: z.object({ x: z.number(), y: z.number(), radius: z.number().positive() }).optional() }),
]);
export type Verification = z.infer<typeof verificationSchema>;
export const goalSchema = z.object({
  id: z.string(), parentId: z.string().optional(), title: z.string(), description: z.string(),
  status: z.enum(["pending", "ready", "active", "blocked", "done", "failed"]), priority: z.number(),
  dependencies: z.array(z.string()), createdAt: z.string(), updatedAt: z.string(), attempts: z.number().int().nonnegative(),
  blockers: z.array(z.string()), verification: z.array(verificationSchema), evidence: z.array(z.string()), result: z.string().optional(), nextReviewAt: z.string().optional(),
});
export type Goal = z.infer<typeof goalSchema>;
export const autonomousMemorySchema = z.object({
  schemaVersion: z.literal(1), objective: z.string().nullable(), objectiveHistory: z.array(z.object({ objective: z.string(), at: z.string() })),
  goals: z.array(goalSchema), knownAreas: z.array(observation), productionLines: z.array(observation), resourcePatches: z.array(observation),
  importantEntities: z.array(observation), infrastructure: z.array(observation), research: z.array(observation), knownBlueprints: z.array(observation),
  blockers: z.array(z.string()), decisions: z.array(z.string()), failedApproaches: z.array(z.string()), recentAchievements: z.array(z.string()),
  nextStrategicActions: z.array(z.string()), paused: z.boolean(), timestamps: z.object({ createdAt: z.string(), updatedAt: z.string() }),
});
export type AutonomousMemory = z.infer<typeof autonomousMemorySchema>;

export function freshMemory(): AutonomousMemory { const now = new Date().toISOString(); return { schemaVersion: 1, objective: null, objectiveHistory: [], goals: [], knownAreas: [], productionLines: [], resourcePatches: [], importantEntities: [], infrastructure: [], research: [], knownBlueprints: [], blockers: [], decisions: [], failedApproaches: [], recentAchievements: [], nextStrategicActions: [], paused: false, timestamps: { createdAt: now, updatedAt: now } }; }
export class MemoryStore {
  readonly file: string;
  constructor(readonly key: string, root = path.join(configDir(), "autonomous")) { this.file = path.join(root, `${key.replace(/[^\w.-]/g, "_")}.json`); }
  load(): AutonomousMemory { try { return autonomousMemorySchema.parse(JSON.parse(fs.readFileSync(this.file, "utf8"))); } catch (error) { if (fs.existsSync(this.file)) { const backup = `${this.file}.corrupt-${Date.now()}`; try { fs.renameSync(this.file, backup); } catch {} console.warn(`autonomous memory was corrupt; moved aside and starting fresh: ${error instanceof Error ? error.message : error}`); } return freshMemory(); } }
  save(value: AutonomousMemory): void { const parsed = autonomousMemorySchema.parse({ ...value, timestamps: { ...value.timestamps, updatedAt: new Date().toISOString() } }); atomicWriteFile(this.file, `${JSON.stringify(parsed, null, 2)}\n`, 0o600); }
  reset(): void { if (fs.existsSync(this.file)) fs.rmSync(this.file); }
}
