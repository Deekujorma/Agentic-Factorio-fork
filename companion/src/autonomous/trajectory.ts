import fs from "node:fs";
import path from "node:path";
import { configDir } from "../config.js";

export interface TrajectoryEvent { type: string; data?: Record<string, unknown>; tick?: number; agentId?: string; goalId?: string; jobId?: string }
export class TrajectoryLog {
  readonly file: string;
  constructor(key: string, root = path.join(configDir(), "autonomous")) { this.file = path.join(root, `${key.replace(/[^\w.-]/g, "_")}.jsonl`); }
  append(event: TrajectoryEvent): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const line = JSON.stringify({ timestamp: new Date().toISOString(), ...event });
    const fd = fs.openSync(this.file, "a", 0o600);
    try { fs.writeSync(fd, `${line}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
}
