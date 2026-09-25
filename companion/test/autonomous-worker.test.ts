import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Bridge } from "../src/bridge.js";
import { CoordinationBroker } from "../src/coordination/broker.js";
import { buildWorkerTools } from "../src/autonomous/worker.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((value) => fs.rmSync(value, { recursive: true, force: true })));

async function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-worker-tools-")); roots.push(root);
  const broker = new CoordinationBroker("tools", root); const worker = await broker.registerAgent({ name: "worker", role: "worker", agentId: "worker-12345678" });
  await broker.leaseCompanion(worker.id, "Ada"); await broker.reserveArea({ agentId: worker.id, label: "site", center: { x: 0, y: 0 }, radius: 10 });
  const calls: Array<{ method: string; companion?: string; value?: unknown }> = [];
  const make = (companion?: string): Bridge => ({
    call: async (method: string, value?: unknown) => { calls.push({ method, companion, value }); if (method === "read_blueprint") return { size: { w: 8, h: 8 } }; return { cancelled: 0 }; },
    enqueueAndWait: async (value: unknown) => { calls.push({ method: "enqueueAndWait", companion, value }); return "done"; },
    scoped: (name: string) => make(name),
  } as unknown as Bridge);
  return { broker, worker, calls, tools: buildWorkerTools(make(), broker, worker.id, "Ada") as Record<string, any> };
}

describe("autonomous worker tool safety", () => {
  it("hides player chat and background/companion controls", async () => {
    const { tools } = await setup(); expect(tools.say).toBeUndefined(); expect(tools.stop).toBeUndefined(); expect(tools.respawn).toBeUndefined();
    expect(await tools.place_entity.inputSchema.safeParseAsync({ item: "belt", x: 0, y: 0, background: true })).toMatchObject({ success: false });
    expect(await tools.place_entity.inputSchema.safeParseAsync({ item: "belt", x: 0, y: 0, companion: "Other" })).toMatchObject({ success: false });
  });

  it("forces foreground execution and the leased companion", async () => {
    const { tools, calls } = await setup(); await tools.place_entity.execute({ item: "transport-belt", x: 1, y: 1 });
    expect(calls).toContainEqual(expect.objectContaining({ method: "enqueueAndWait", companion: "Ada" }));
    expect(calls.some((call) => call.method === "enqueue")).toBe(false);
  });

  it("allows spatial mutations inside and rejects outside the reservation", async () => {
    const { tools } = await setup(); await expect(tools.place_entity.execute({ item: "transport-belt", x: 2, y: 2 })).resolves.toBe("done");
    await expect(tools.place_entity.execute({ item: "transport-belt", x: 20, y: 20 })).rejects.toThrow(/outside/);
    await expect(tools.build_plan.execute({ steps: [{ item: "transport-belt", x: 1, y: 1 }, { item: "transport-belt", x: 30, y: 30 }] })).rejects.toThrow(/outside/);
    await expect(tools.build_blueprint.execute({ label: "large", anchor_x: 8, anchor_y: 8 })).rejects.toThrow(/outside/);
  });

  it("does not require an area reservation for non-spatial crafting", async () => {
    const { broker, worker, tools } = await setup(); const reservation = (await broker.snapshot()).reservations[0]!; await broker.releaseArea(worker.id, reservation.id);
    await expect(tools.craft_items.execute({ recipe: "iron-gear-wheel", count: 1 })).resolves.toBe("done");
    await expect(tools.place_entity.execute({ item: "transport-belt", x: 0, y: 0 })).rejects.toThrow(/requires an active area reservation/);
  });
});
