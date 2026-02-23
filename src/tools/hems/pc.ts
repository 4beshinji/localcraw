import type { Tool, ToolResult } from "../registry.ts";
import { getPcSnapshot, getTopProcesses } from "../../hems/metrics.ts";

export const pcStatusTool: Tool = {
  name: "get_pc_status",
  description:
    "Get current PC metrics: CPU usage, memory, GPU (if available), disk partitions, temperatures",
  parameters: {
    type: "object",
    properties: {},
  },
  async execute(): Promise<ToolResult> {
    try {
      const snapshot = await getPcSnapshot();
      const summary = {
        cpu_percent: snapshot.cpu.usage_percent,
        memory_percent: snapshot.memory.percent,
        memory_used_gb: snapshot.memory.used_gb,
        memory_total_gb: snapshot.memory.total_gb,
        gpu_percent: snapshot.gpu?.usage_percent ?? null,
        gpu_vram_used_gb: snapshot.gpu?.vram_used_gb ?? null,
        gpu_temp_c: snapshot.gpu?.temp_c ?? null,
        cpu_temp_c: snapshot.temperature.cpu_temp_c,
        disk: snapshot.disk,
        timestamp: snapshot.timestamp,
      };
      return { success: true, output: JSON.stringify(summary, null, 2) };
    } catch (err) {
      return { success: false, output: "", error: String(err) };
    }
  },
};

export const pcProcessesTool: Tool = {
  name: "get_pc_processes",
  description: "Get the top processes by CPU usage on this PC",
  parameters: {
    type: "object",
    properties: {
      limit: { type: "string", description: "Number of processes to return (default: 15)" },
    },
  },
  async execute(args): Promise<ToolResult> {
    const limit = parseInt((args.limit as string) ?? "15", 10) || 15;
    try {
      const procs = await getTopProcesses(limit);
      const lines = procs.map(
        (p) => `[${p.pid}] ${p.name.padEnd(20)} CPU: ${p.cpu_percent}%  MEM: ${p.mem_mb}MB`
      );
      return { success: true, output: lines.join("\n") };
    } catch (err) {
      return { success: false, output: "", error: String(err) };
    }
  },
};
