import { generateText, stepCountIs, tool, type LanguageModel, type ToolSet } from "ai";
import type { Bridge } from "../bridge.js";
import type { CoordinationBroker, CoordinationJob } from "../coordination/broker.js";
import { toModelOutput } from "../tools/adapter.js";
import { toolSpecs } from "../tools/definitions.js";
import { AUTONOMOUS_WORKER_PROMPT } from "./prompts.js";

const READ_ONLY = new Set(["look_around", "view_area", "check_inventory", "inspect_entity", "scan_area", "describe_prototype", "analyze_factory", "can_place", "find_buildable_area", "list_blueprints", "read_blueprint", "list_trains", "plan_production"]);
const FORBIDDEN = new Set(["say", "respawn", "stop"]);

export interface WorkerPacket {
  goalId: string; objective: string; companion: string; agentId: string;
  relevantArea?: { x: number; y: number; radius: number };
  expectedInputs: string[]; expectedOutput: string; definitionOfDone: string;
  verification: unknown[]; priorFailures: string[];
}
export interface WorkerResult { success: boolean; report: string; toolSteps: number }
export type WorkerGenerate = (input: { model: LanguageModel; tools: ToolSet; packet: WorkerPacket; signal: AbortSignal }) => Promise<WorkerResult>;

export const defaultWorkerGenerate: WorkerGenerate = async ({ model, tools, packet, signal }) => {
  const result = await generateText({
    model, system: AUTONOMOUS_WORKER_PROMPT, prompt: JSON.stringify(packet), tools,
    stopWhen: stepCountIs(18), abortSignal: signal,
  });
  return { success: true, report: result.text || "worker tool loop ended without a report", toolSteps: result.steps.length };
};

export function buildWorkerTools(bridge: Bridge, broker: CoordinationBroker, agentId: string, companion: string): ToolSet {
  const result: ToolSet = {};
  for (const spec of toolSpecs()) {
    if (FORBIDDEN.has(spec.name)) continue;
    result[spec.name] = tool<Record<string, unknown>, Awaited<ReturnType<typeof spec.execute>>, {}>({
      description: spec.description,
      inputSchema: spec.schema,
      execute: async (input) => {
        if (!READ_ONLY.has(spec.name)) await broker.assertMayAct(agentId, companion);
        return spec.execute(bridge, { ...input, agent_id: agentId, companion });
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
