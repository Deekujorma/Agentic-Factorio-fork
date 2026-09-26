import { generateText, Output, stepCountIs, tool, type LanguageModel, type ToolSet } from "ai";
import { z } from "zod";
import type { Bridge } from "../bridge.js";
import type { CoordinationBroker, CoordinationJob } from "../coordination/broker.js";
import { toModelOutput } from "../tools/adapter.js";
import { toolSpecs } from "../tools/definitions.js";
import { AUTONOMOUS_WORKER_PROMPT } from "./prompts.js";

const READ_ONLY = new Set(["look_around", "view_area", "check_inventory", "inspect_entity", "scan_area", "describe_prototype", "analyze_factory", "can_place", "find_buildable_area", "list_blueprints", "read_blueprint", "list_trains", "plan_production"]);
const FORBIDDEN = new Set(["say", "respawn", "stop", "follow_player", "keep_fueled", "defend_area", "run_plan"]);
const SPATIAL_MUTATIONS = new Set(["place_entity", "build_plan", "build_blueprint", "deconstruct"]);
const RESERVATION_SCOPED_MUTATIONS = new Set(["set_recipe", "rotate_entity", "insert_items", "extract_items", "mine"]);

export const workerDiscoverySchema = z.object({
  category: z.enum(["knownArea", "resourcePatch", "productionLine", "importantEntity", "infrastructure", "research", "blueprint"]),
  summary: z.string().min(1), position: z.object({ x: z.number(), y: z.number() }).optional(),
});
export const workerResultSchema = z.object({
  status: z.enum(["completed", "blocked", "failed"]), summary: z.string().min(1),
  evidence: z.array(z.string()).max(20), discoveries: z.array(workerDiscoverySchema).max(20),
  blocker: z.string().nullable(),
});
export type WorkerResult = z.infer<typeof workerResultSchema> & { toolSteps: number };

export interface WorkerPacket {
  goalId: string; objective: string; companion: string; agentId: string;
  relevantArea?: { x: number; y: number; radius: number };
  expectedInputs: string[]; expectedOutput: string; definitionOfDone: string;
  verification: unknown[]; priorFailures: string[];
}
export type WorkerGenerate = (input: { model: LanguageModel; tools: ToolSet; packet: WorkerPacket; signal: AbortSignal }) => Promise<WorkerResult>;

export const defaultWorkerGenerate: WorkerGenerate = async ({ model, tools, packet, signal }) => {
  const result = await generateText({
    model, system: AUTONOMOUS_WORKER_PROMPT, prompt: JSON.stringify(packet), tools,
    stopWhen: stepCountIs(18), abortSignal: signal, maxRetries: 1,
    output: Output.object({ schema: workerResultSchema, name: "factorio_worker_result" }),
  });
  const output = workerResultSchema.parse(result.output);
  return { ...output, toolSteps: result.steps.length };
};

function spatialTargets(name: string, input: Record<string, unknown>): Array<{ x: number; y: number; radius?: number }> {
  if (name === "place_entity") return [{ x: Number(input.x), y: Number(input.y) }];
  if (name === "build_plan") return Array.isArray(input.steps) ? input.steps.map((step) => ({ x: Number((step as Record<string, unknown>).x), y: Number((step as Record<string, unknown>).y) })) : [];
  if (name === "build_blueprint") return [{ x: Number(input.anchor_x), y: Number(input.anchor_y) }];
  if (name === "deconstruct") return [{ x: Number(input.x), y: Number(input.y), radius: typeof input.area_radius === "number" ? input.area_radius : 0 }];
  if (["set_recipe", "rotate_entity", "insert_items", "extract_items"].includes(name)) return [{ x: Number(input.x), y: Number(input.y) }];
  if (name === "mine" && typeof input.x === "number" && typeof input.y === "number") return [{ x: input.x, y: input.y }];
  return [];
}

export function buildWorkerTools(bridge: Bridge, broker: CoordinationBroker, agentId: string, companion: string): ToolSet {
  const result: ToolSet = {};
  for (const spec of toolSpecs()) {
    if (FORBIDDEN.has(spec.name)) continue;
    const workerSchema = spec.schema.omit({ companion: true, background: true, agent_id: true }).strict();
    result[spec.name] = tool<Record<string, unknown>, Awaited<ReturnType<typeof spec.execute>>, {}>({
      description: spec.description.replace(/Prefer background:true[^.]*\.?/g, "Autonomous workers always wait for completion."),
      inputSchema: workerSchema,
      execute: async (input) => {
        if (!READ_ONLY.has(spec.name)) await broker.assertMayAct(agentId, companion);
        if (SPATIAL_MUTATIONS.has(spec.name)) {
          const targets = spatialTargets(spec.name, input);
          if (spec.name === "build_blueprint") {
            const blueprint = await bridge.call<{ size: { w: number; h: number } }>("read_blueprint", { label: input.label, book: input.book, limit: 1 });
            const x = Number(input.anchor_x); const y = Number(input.anchor_y);
            targets.push({ x: x + blueprint.size.w, y }, { x, y: y + blueprint.size.h }, { x: x + blueprint.size.w, y: y + blueprint.size.h });
          }
          await broker.assertWithinReservation(agentId, targets);
        } else if (RESERVATION_SCOPED_MUTATIONS.has(spec.name)) {
          const targets = spatialTargets(spec.name, input);
          if (targets.length > 0) await broker.assertWithinActiveReservation(agentId, targets);
        }
        return spec.execute(bridge, { ...input, agent_id: agentId, companion, background: false });
      },
      toModelOutput: ({ output }) => toModelOutput(output),
    });
  }
  return result;
}

export class AutonomousWorker {
  constructor(
    readonly id: string,
    private readonly model: LanguageModel,
    private readonly bridge: Bridge,
    private readonly broker: CoordinationBroker,
    private readonly generate: WorkerGenerate = defaultWorkerGenerate,
  ) {}

  async execute(job: CoordinationJob, packet: WorkerPacket, signal: AbortSignal): Promise<WorkerResult> {
    const tools = buildWorkerTools(this.bridge, this.broker, this.id, packet.companion);
    return this.generate({ model: this.model, tools, packet, signal });
  }
}
