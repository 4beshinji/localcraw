import { execFile } from "child_process";
import { promisify } from "util";
import { resolve } from "path";
import type { Tool, ToolResult } from "./registry.ts";
import type { Config } from "../config/index.ts";

const execFileAsync = promisify(execFile);

// Dangerous commands that should be blocked in direct (non-Docker) execution
const BLOCKED_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*)?.*\s+\//,  // rm with absolute paths
  /\bmkfs\b/,
  /\bdd\b.*\bof=/,
  />\s*\/dev\//,
  /\bchmod\s+[0-7]*777\b/,
  /\bcurl\b.*\|\s*(ba)?sh/,        // curl pipe to shell
  /\bwget\b.*\|\s*(ba)?sh/,
];

function isBlockedCommand(command: string): boolean {
  return BLOCKED_PATTERNS.some((rx) => rx.test(command));
}

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
        // Block dangerous commands when running without Docker sandbox
        if (isBlockedCommand(command)) {
          return {
            success: false,
            output: "",
            error: "Command blocked: potentially destructive operation not allowed without Docker sandbox",
          };
        }
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
    "--read-only",
    "--no-new-privileges",
    "--cap-drop=ALL",
    "--tmpfs", "/tmp:rw,noexec,size=64m",
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
      // Docker not available - warn and block dangerous commands before fallback
      console.warn("[shell] WARNING: Docker not found, falling back to unsandboxed direct execution");
      if (isBlockedCommand(command)) {
        return {
          success: false,
          output: "",
          error: "Command blocked: Docker unavailable and command is potentially destructive",
        };
      }
      return runDirect(command, workspace, config);
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
