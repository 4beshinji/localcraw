/**
 * Tool call parser supporting both native OpenAI tool_calls and ReAct XML format.
 *
 * ReAct format expected from LLM:
 *   <tool>shell</tool>
 *   <params>{"command": "ls -la"}</params>
 */

export interface ParsedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export function parseReActToolCalls(text: string): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];
  // Match all tool/params pairs
  const toolPattern = /<tool>([\s\S]*?)<\/tool>\s*<params>([\s\S]*?)<\/params>/g;
  let match: RegExpExecArray | null;
  let idx = 0;

  while ((match = toolPattern.exec(text)) !== null) {
    const name = match[1].trim();
    const paramsStr = match[2].trim();
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(paramsStr);
    } catch {
      // If JSON parse fails, treat as raw string input
      args = { input: paramsStr };
    }
    calls.push({ id: `react_${idx++}`, name, arguments: args });
  }

  return calls;
}

export function hasReActToolCall(text: string): boolean {
  return /<tool>[\s\S]*?<\/tool>/.test(text);
}

/**
 * Strip ReAct tool call markup from text so only the thinking/prose is shown.
 */
export function stripReActMarkup(text: string): string {
  return text
    .replace(/<tool>[\s\S]*?<\/tool>\s*<params>[\s\S]*?<\/params>/g, "")
    .trim();
}

/**
 * Build a system prompt addition for ReAct mode that instructs the LLM
 * how to call tools using XML tags.
 */
export function buildReActToolInstructions(
  tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
): string {
  if (!tools.length) return "";

  const toolDocs = tools
    .map((t) => {
      const props = (t.parameters as { properties?: Record<string, { description?: string; type?: string }> }).properties ?? {};
      const paramLines = Object.entries(props).map(([k, v]) => `  - ${k} (${v.type ?? "string"}): ${v.description ?? ""}`).join("\n");
      return `### ${t.name}\n${t.description}\nParameters:\n${paramLines}`;
    })
    .join("\n\n");

  return `
## Tool Calling Instructions

You can call tools using the following XML format:

<tool>tool_name</tool>
<params>{"param1": "value1", "param2": "value2"}</params>

Place the tool call on its own line. You may call tools multiple times. Wait for the result before continuing.

Available tools:

${toolDocs}
`.trim();
}
