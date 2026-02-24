import { execFile } from "child_process";
import { promisify } from "util";
import { resolve } from "path";
import type { Tool, ToolResult } from "./registry.ts";
import type { Config } from "../config/index.ts";

const execFileAsync = promisify(execFile);

// Fix-5: Dangerous command patterns for direct (non-Docker) execution
const DANGEROUS_PATTERNS_DIRECT = [
  /rm\s+-rf\s+\//i,
  /mkfs/i,
  /dd\s+of=\/dev\//i,
  /shutdown/i,
  /reboot/i,
  /chmod\s+777\s+\//i,
  /:\(\)\{\s*:\|:&\s*\}/, // fork bomb
  />\s*\/dev\/(sd[a-z]|nvme)/i,
];

const MAX_COMMAND_LENGTH = 4096;

export function createShellTool(config: Config, workspaceDir?: string): Tool {
  const workspace = workspaceDir ?? process.cwd();

  return {
    name: "shell",
    description:
      "Execute a shell command. Commands run in a Docker sandbox for safety.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The shell command to execute",
        },
      },
      required: ["command"],
    },
    async execute(args): Promise<ToolResult> {
      const command = args.command as string;
      if (!command) {
        return { success: false, output: "", error: "command is required" };
      }

      if (config.docker.enabled) {
        return runInDocker(command, workspace, config);
      } else {
        return runDirect(command, workspace, config);
      }
    },
  };
}

async function runInDocker(
  command: string,
  workspace: string,
  config: Config
): Promise<ToolResult> {
  const absWorkspace = resolve(workspace);
  const timeoutMs = config.docker.timeoutSec * 1000;

  const dockerArgs = [
    "run",
    "--rm",
    "--network",
    config.docker.network ? "bridge" : "none",
    "--memory",
    config.docker.memoryLimit,
    "--cpus",
    config.docker.cpuLimit,
    "-v",
    `${absWorkspace}:/workspace`,
    "-w",
    "/workspace",
    config.docker.image,
    "sh",
    "-c",
    command,
  ];

  try {
    const { stdout, stderr } = await execFileAsync("docker", dockerArgs, {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
    });
    const output = [stdout, stderr].filter(Boolean).join("\n");
    return { success: true, output: output || "(no output)" };
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err && (err as { code: unknown }).code === "ENOENT") {
      // Fix-6: No silent fallback — Docker missing is a hard error to prevent host execution
      return {
        success: false,
        output: "",
        error: "Docker is not available. Shell tool requires Docker sandbox (docker.enabled=true). " +
               "Install Docker or disable docker.enabled in config.",
      };
    }
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const output = [e.stdout, e.stderr].filter(Boolean).join("\n");
    return {
      success: false,
      output: output || "",
      error: e.message ?? String(err),
    };
  }
}

async function runDirect(
  command: string,
  workspace: string,
  config: Config
): Promise<ToolResult> {
  // Fix-5: Enforce length limit and dangerous command check for host execution
  if (command.length > MAX_COMMAND_LENGTH) {
    return { success: false, output: "", error: `Command too long (max ${MAX_COMMAND_LENGTH} chars)` };
  }
  if (DANGEROUS_PATTERNS_DIRECT.some((p) => p.test(command))) {
    return { success: false, output: "", error: "Command blocked by safety filter" };
  }
  const timeoutMs = config.docker.timeoutSec * 1000;
  try {
    const { stdout, stderr } = await execFileAsync("sh", ["-c", command], {
      cwd: workspace,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
    });
    const output = [stdout, stderr].filter(Boolean).join("\n");
    return { success: true, output: output || "(no output)" };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const output = [e.stdout, e.stderr].filter(Boolean).join("\n");
    return {
      success: false,
      output: output || "",
      error: e.message ?? String(err),
    };
  }
}
