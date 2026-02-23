import type { Tool, ToolResult } from "../registry.ts";
import type { HemsConfig } from "../../hems/config.ts";

export function createHaTools(cfg: HemsConfig["homeAssistant"]): Tool[] {
  if (!cfg.enabled) return [];

  const haFetch = async (
    path: string,
    method = "GET",
    body?: unknown
  ): Promise<{ ok: boolean; data: unknown; error?: string }> => {
    try {
      const res = await fetch(`${cfg.url}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${cfg.token}`,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        return { ok: false, data: null, error: `HTTP ${res.status}: ${res.statusText}` };
      }
      const data = await res.json();
      return { ok: true, data };
    } catch (err) {
      return { ok: false, data: null, error: String(err) };
    }
  };

  return [
    {
      name: "ha_get_state",
      description: "Get the current state of a Home Assistant entity",
      parameters: {
        type: "object",
        properties: {
          entity_id: {
            type: "string",
            description: "Entity ID (e.g. light.living_room, sensor.temperature)",
          },
        },
        required: ["entity_id"],
      },
      async execute(args): Promise<ToolResult> {
        const entity_id = args.entity_id as string;
        const result = await haFetch(`/api/states/${entity_id}`);
        if (!result.ok) {
          return { success: false, output: "", error: result.error };
        }
        const state = result.data as { state: string; attributes: Record<string, unknown> };
        return {
          success: true,
          output: `${entity_id}: ${state.state}\n${JSON.stringify(state.attributes, null, 2)}`,
        };
      },
    },

    {
      name: "ha_call_service",
      description:
        "Call a Home Assistant service (e.g. light.turn_on, switch.toggle, climate.set_temperature)",
      parameters: {
        type: "object",
        properties: {
          domain: {
            type: "string",
            description: "Service domain (e.g. light, switch, climate, cover)",
          },
          service: {
            type: "string",
            description: "Service name (e.g. turn_on, turn_off, toggle, set_temperature)",
          },
          entity_id: {
            type: "string",
            description: "Target entity ID",
          },
          data: {
            type: "string",
            description: "Optional JSON string with additional service data",
          },
        },
        required: ["domain", "service", "entity_id"],
      },
      async execute(args): Promise<ToolResult> {
        const domain = args.domain as string;
        const service = args.service as string;
        const entity_id = args.entity_id as string;
        let extraData: Record<string, unknown> = {};
        if (args.data) {
          try {
            extraData = JSON.parse(args.data as string);
          } catch {
            return { success: false, output: "", error: "data must be valid JSON" };
          }
        }

        const result = await haFetch(`/api/services/${domain}/${service}`, "POST", {
          entity_id,
          ...extraData,
        });

        if (!result.ok) {
          return { success: false, output: "", error: result.error };
        }
        return {
          success: true,
          output: `Called ${domain}.${service} on ${entity_id}`,
        };
      },
    },

    {
      name: "ha_list_entities",
      description: "List Home Assistant entities, optionally filtered by domain",
      parameters: {
        type: "object",
        properties: {
          domain: {
            type: "string",
            description: "Filter by domain (e.g. light, sensor, switch). Leave empty for all.",
          },
        },
      },
      async execute(args): Promise<ToolResult> {
        const domain = args.domain as string | undefined;
        const result = await haFetch("/api/states");
        if (!result.ok) {
          return { success: false, output: "", error: result.error };
        }
        const states = result.data as Array<{ entity_id: string; state: string }>;
        const filtered = domain
          ? states.filter((s) => s.entity_id.startsWith(`${domain}.`))
          : states;
        const lines = filtered.map((s) => `${s.entity_id}: ${s.state}`);
        return {
          success: true,
          output: lines.join("\n") || "No entities found",
        };
      },
    },
  ];
}
