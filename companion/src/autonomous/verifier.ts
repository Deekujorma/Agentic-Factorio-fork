import type { Bridge } from "../bridge.js";
import type { Goal, Verification } from "./memory.js";

interface RpcCheck { kind: string; [key: string]: unknown }
interface RpcResult { tick: number; results: Array<{ kind: string; ok: boolean; actual: unknown; expected: unknown }> }
export interface VerificationOutcome { ok: boolean; tick?: number; evidence: string[]; retryable: boolean }
export interface VerificationReader { verify(checks: RpcCheck[]): Promise<RpcResult> }

export class BridgeVerificationReader implements VerificationReader {
  constructor(private readonly bridge: Bridge) {}
  verify(checks: RpcCheck[]): Promise<RpcResult> { return this.bridge.call<RpcResult>("verify_autonomous", { checks }); }
}

function toRpcCheck(value: Verification): RpcCheck | null {
  switch (value.kind) {
    case "goal_dependencies": case "manual": return null;
    case "entity_count": return { kind: value.kind, entity: value.entity, minimum: value.minimum, area: value.area };
    case "inventory": return { kind: value.kind, item: value.item, minimum: value.minimum, unit_number: value.unitNumber, position: value.position };
    case "research": return { kind: value.kind, technology: value.technology };
    case "production": return { kind: value.kind, item: value.item, minimum_per_minute: value.minimumPerMinute };
    case "operational": return { kind: value.kind, entity: value.entity, minimum: value.minimum, area: value.area };
    case "no_factory_blocker": return { kind: value.kind, entity: value.entity, area: value.area };
    case "event_count": return { kind: value.kind, event: value.event, minimum: value.minimum, after_tick: value.afterTick };
    case "companion_near_player": return { kind: value.kind, player: value.player, maximum_distance: value.maximumDistance };
  }
}

export async function verifyGoal(goal: Goal, reader: VerificationReader, goals: Goal[]): Promise<VerificationOutcome> {
  if (goal.verification.length === 0) return { ok: false, evidence: ["no verification criteria configured"], retryable: false };
  const evidence: string[] = []; let ok = true;
  const rpcChecks: RpcCheck[] = []; const rpcIndexes: number[] = [];
  for (const [index, check] of goal.verification.entries()) {
    if (check.kind === "goal_dependencies") {
      const missing = check.goalIds.filter((id) => goals.find((candidate) => candidate.id === id)?.status !== "done");
      const passed = missing.length === 0; ok &&= passed; evidence.push(`goal_dependencies: ${passed ? "pass" : `missing ${missing.join(", ")}`}`);
    } else if (check.kind === "manual") {
      evidence.push(`manual: ${check.description}`);
    } else { rpcChecks.push(toRpcCheck(check)!); rpcIndexes.push(index); }
  }
  let tick: number | undefined;
  if (rpcChecks.length > 0) {
    const response = await reader.verify(rpcChecks); tick = response.tick;
    for (const result of response.results) { ok &&= result.ok; evidence.push(`${result.kind}: actual=${JSON.stringify(result.actual)} expected=${JSON.stringify(result.expected)} ${result.ok ? "pass" : "fail"}`); }
    if (response.results.length !== rpcIndexes.length) return { ok: false, tick, evidence: [...evidence, "verification RPC returned incomplete results"], retryable: true };
  }
  return { ok, tick, evidence, retryable: true };
}
