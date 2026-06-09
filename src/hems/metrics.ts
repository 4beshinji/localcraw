import si from "systeminformation";

export interface CpuMetrics {
  usage_percent: number;
  core_count: number;
  load_1m: number;
  freq_mhz: number;
  temp_c: number;
}

export interface MemoryMetrics {
  used_gb: number;
  total_gb: number;
  percent: number;
}

export interface GpuMetrics {
  usage_percent: number;
  vram_used_gb: number;
  vram_total_gb: number;
  temp_c: number;
}

export interface DiskPartition {
  mount: string;
  used_gb: number;
  total_gb: number;
  percent: number;
}

export interface TempMetrics {
  cpu_temp_c: number | null;
  gpu_temp_c: number | null;
}

export interface ProcessInfo {
  pid: number;
  name: string;
  cpu_percent: number;
  mem_mb: number;
}

export interface PcSnapshot {
  cpu: CpuMetrics;
  memory: MemoryMetrics;
  gpu: GpuMetrics | null;
  disk: DiskPartition[];
  temperature: TempMetrics;
  processes: ProcessInfo[];
  timestamp: string;
}

export async function getCpuMetrics(): Promise<CpuMetrics> {
  const [load, cpuInfo, cpuSpeed, cpuTemp] = await Promise.all([
    si.currentLoad(),
    si.cpu(),
    si.cpuCurrentSpeed(),
    si.cpuTemperature(),
  ]);
  return {
    usage_percent: Math.round(load.currentLoad),
    core_count: cpuInfo.cores,
    load_1m: load.avgLoad ?? 0,
    freq_mhz: Math.round((cpuSpeed.avg ?? 0) * 1000), // GHz → MHz
    temp_c: cpuTemp.main ?? 0,
  };
}

export async function getMemoryMetrics(): Promise<MemoryMetrics> {
  const mem = await si.mem();
  const toGb = (b: number) => Math.round((b / 1024 ** 3) * 100) / 100;
  // Linux: si.mem().used = total - free, which counts buffer/cache as "used"
  // and reads ~90% on any healthy system. Use (total - available) to match
  // `free -h` available column / htop — memory not reclaimable on demand.
  const available = mem.available ?? mem.free;
  const realUsed = Math.max(0, mem.total - available);
  return {
    used_gb: toGb(realUsed),
    total_gb: toGb(mem.total),
    percent: mem.total ? Math.round((realUsed / mem.total) * 100) : 0,
  };
}

export async function getGpuMetrics(): Promise<GpuMetrics | null> {
  try {
    const gpus = await si.graphics();
    const gpu = gpus.controllers.find(
      (g) => g.vram !== undefined && g.vram !== null && g.vram > 0
    );
    if (!gpu) return null;
    const toGb = (mb: number) => Math.round((mb / 1024) * 100) / 100;
    return {
      usage_percent: gpu.utilizationGpu ?? 0,
      vram_used_gb: toGb(gpu.memoryUsed ?? 0),
      vram_total_gb: toGb(gpu.vram ?? 0),
      temp_c: gpu.temperatureGpu ?? 0,
    };
  } catch {
    return null;
  }
}

export async function getDiskMetrics(): Promise<DiskPartition[]> {
  const disks = await si.fsSize();
  const toGb = (b: number) => Math.round((b / 1024 ** 3) * 100) / 100;
  return disks
    .filter((d) => d.size > 0 && d.mount && !d.mount.startsWith("/sys") && !d.mount.startsWith("/proc"))
    .map((d) => ({
      mount: d.mount,
      used_gb: toGb(d.used),
      total_gb: toGb(d.size),
      percent: Math.round(d.use),
    }));
}

export async function getTemperatureMetrics(): Promise<TempMetrics> {
  try {
    const temps = await si.cpuTemperature();
    return {
      cpu_temp_c: temps.main ?? null,
      gpu_temp_c: null, // included in GPU metrics
    };
  } catch {
    return { cpu_temp_c: null, gpu_temp_c: null };
  }
}

export async function getTopProcesses(limit = 15): Promise<ProcessInfo[]> {
  const procs = await si.processes();
  return procs.list
    .sort((a, b) => (b.cpu ?? 0) - (a.cpu ?? 0))
    .slice(0, limit)
    .map((p) => ({
      pid: p.pid,
      name: p.name,
      cpu_percent: Math.round((p.cpu ?? 0) * 10) / 10,
      mem_mb: Math.round((p.memRss ?? 0) / 1024 / 1024),
    }));
}

export async function getPcSnapshot(): Promise<PcSnapshot> {
  const [cpu, memory, gpu, disk, temperature, processes] = await Promise.all([
    getCpuMetrics(),
    getMemoryMetrics(),
    getGpuMetrics(),
    getDiskMetrics(),
    getTemperatureMetrics(),
    getTopProcesses(),
  ]);
  return { cpu, memory, gpu, disk, temperature, processes, timestamp: new Date().toISOString() };
}
