import type { Goal } from "./memory.js";

export interface WorkerSlot { id: string; companion: string; busy: boolean }
export class WorkerScheduler {
  private readonly slots: WorkerSlot[];
  constructor(count: number, companions = ["Ada", "Babbage", "Curie", "Dijkstra"]) {
    if (!Number.isInteger(count) || count < 1 || count > 4) throw new Error("worker count must be 1-4");
    this.slots = Array.from({ length: count }, (_, index) => ({ id: `local-worker-${index + 1}`, companion: companions[index]!, busy: false }));
  }
  available(): WorkerSlot[] { return this.slots.filter((slot) => !slot.busy); }
  allocate(goals: Goal[], positions: ReadonlyMap<string, { x: number; y: number }> = new Map()): Array<{ slot: WorkerSlot; goal: Goal }> {
    const available = this.available(); const result: Array<{ slot: WorkerSlot; goal: Goal }> = [];
    for (const goal of goals) {
      if (available.length === 0) break;
      const center = goal.job?.area;
      available.sort((a, b) => distance(positions.get(a.companion), center) - distance(positions.get(b.companion), center));
      const slot = available.shift()!;
      if (center && positions.has(slot.companion) && distance(positions.get(slot.companion), center) >= 128) continue;
      slot.busy = true; result.push({ slot, goal });
    }
    return result;
  }
  release(workerId: string): void { const slot = this.slots.find((candidate) => candidate.id === workerId); if (slot) slot.busy = false; }
  countBusy(): number { return this.slots.filter((slot) => slot.busy).length; }
  all(): readonly WorkerSlot[] { return this.slots; }
}

function distance(position: { x: number; y: number } | undefined, target: { x: number; y: number } | undefined): number {
  if (!position || !target) return 0; return Math.hypot(position.x - target.x, position.y - target.y);
}
