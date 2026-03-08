import {
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  existsSync,
  mkdirSync,
  lstatSync,
} from "fs";
import { join, resolve, dirname } from "path";
import type { Tool, ToolResult } from "./registry.ts";

const MAX_FILE_SIZE = 1024 * 1024; // 1MB

/** Validate resolved path stays within the workspace (cwd) */
function validatePath(absPath: string): string | null {
  const cwd = process.cwd();
  const realPath = resolve(absPath);
  if (!realPath.startsWith(cwd + "/") && realPath !== cwd) {
    return `Access denied: path escapes workspace directory`;
  }
  return null;
}

function safeRead(filePath: string): ToolResult {
  const abs = resolve(filePath);
  const pathErr = validatePath(abs);
  if (pathErr) {
    return { success: false, output: "", error: pathErr };
  }
  if (!existsSync(abs)) {
    return { success: false, output: "", error: `File not found: ${abs}` };
  }
  const stat = statSync(abs);
  if (stat.size > MAX_FILE_SIZE) {
    return {
      success: false,
      output: "",
      error: `File too large (${stat.size} bytes, max 1MB)`,
    };
  }
  try {
    const content = readFileSync(abs, "utf-8");
    return { success: true, output: content };
  } catch (err) {
    return { success: false, output: "", error: String(err) };
  }
}

export const readFileTool: Tool = {
  name: "read_file",
  description: "Read the contents of a file",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the file to read" },
    },
    required: ["path"],
  },
  async execute(args) {
    const path = args.path as string;
    if (!path) return { success: false, output: "", error: "path is required" };
    return safeRead(path);
  },
};

export const writeFileTool: Tool = {
  name: "write_file",
  description: "Write content to a file (creates directories as needed)",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to write the file" },
      content: { type: "string", description: "Content to write" },
    },
    required: ["path", "content"],
  },
  async execute(args) {
    const path = args.path as string;
    const content = args.content as string;
    if (!path) return { success: false, output: "", error: "path is required" };
    try {
      const abs = resolve(path);
      const pathErr = validatePath(abs);
      if (pathErr) {
        return { success: false, output: "", error: pathErr };
      }
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content, "utf-8");
      return { success: true, output: `Written ${content.length} chars to ${abs}` };
    } catch (err) {
      return { success: false, output: "", error: String(err) };
    }
  },
};

export const listDirTool: Tool = {
  name: "list_dir",
  description: "List files and directories in a path",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Directory path to list (default: current directory)",
      },
    },
  },
  async execute(args) {
    const path = (args.path as string) || ".";
    try {
      const abs = resolve(path);
      const pathErr = validatePath(abs);
      if (pathErr) {
        return { success: false, output: "", error: pathErr };
      }
      if (!existsSync(abs)) {
        return { success: false, output: "", error: `Directory not found: ${abs}` };
      }
      const entries = readdirSync(abs, { withFileTypes: true });
      const lines = entries.map((e) => {
        const indicator = e.isDirectory() ? "/" : e.isSymbolicLink() ? "@" : "";
        const stat = lstatSync(join(abs, e.name));
        const size = e.isFile() ? ` (${stat.size}B)` : "";
        return `${e.name}${indicator}${size}`;
      });
      return { success: true, output: lines.join("\n") || "(empty)" };
    } catch (err) {
      return { success: false, output: "", error: String(err) };
    }
  },
};

export const searchFilesTool: Tool = {
  name: "search_files",
  description: "Search for files matching a pattern or containing text",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory to search in" },
      pattern: {
        type: "string",
        description: "Filename glob pattern (e.g. '*.ts')",
      },
      contains: {
        type: "string",
        description: "Search for files containing this text",
      },
    },
  },
  async execute(args) {
    const basePath = resolve((args.path as string) || ".");
    const basePathErr = validatePath(basePath);
    if (basePathErr) {
      return { success: false, output: "", error: basePathErr };
    }
    const pattern = args.pattern as string | undefined;
    const contains = args.contains as string | undefined;

    const results: string[] = [];

    function walk(dir: string, depth = 0): void {
      if (depth > 10) return;
      if (!existsSync(dir)) return;
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.startsWith(".") && entry !== ".") continue;
        const full = join(dir, entry);
        let stat: ReturnType<typeof statSync>;
        try {
          stat = statSync(full);
        } catch {
          continue;
        }
        if (stat.isDirectory()) {
          walk(full, depth + 1);
        } else if (stat.isFile()) {
          const rel = full.replace(basePath + "/", "");
          if (pattern) {
            const rx = new RegExp(
              "^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*").replace(/\?/g, ".") + "$"
            );
            if (!rx.test(entry)) continue;
          }
          if (contains) {
            try {
              if (stat.size > MAX_FILE_SIZE) continue;
              const content = readFileSync(full, "utf-8");
              if (!content.includes(contains)) continue;
            } catch {
              continue;
            }
          }
          results.push(rel);
        }
      }
    }

    walk(basePath);

    return {
      success: true,
      output: results.length ? results.join("\n") : "No files found",
    };
  },
};
