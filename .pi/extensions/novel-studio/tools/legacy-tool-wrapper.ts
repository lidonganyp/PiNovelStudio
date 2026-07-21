/**
 * Adapter for legacy PiNovelStudio tool definitions.
 */

import { Type, type TSchema } from "@sinclair/typebox";
import { getProjectRoot, resolveProjectRoot, setProjectRoot } from "../utils/config.js";

/**
 * Convert the extension's legacy JSON schema objects into TypeBox schemas.
 */
export function toTypeBoxSchema(raw: any): TSchema {
  if (!raw || raw.type !== "object" || !raw.properties) {
    return Type.Any();
  }

  const props: Record<string, TSchema> = {};
  const stringSchema = (value: any): TSchema => {
    const options: Record<string, unknown> = {};
    if (value.description) options.description = value.description;
    if (value.default !== undefined) options.default = value.default;
    if (Array.isArray(value.enum) && value.enum.every((item: unknown) => typeof item === "string")) {
      return Type.String({ ...options, enum: [...value.enum] });
    }
    return Type.String(options);
  };
  for (const [key, val] of Object.entries(raw.properties as Record<string, any>)) {
    if (val.type === "string") {
      props[key] = Type.Optional(stringSchema(val));
    } else if (val.type === "number") {
      props[key] = Type.Optional(Type.Number(val.description ? { description: val.description } : {}));
    } else if (val.type === "boolean") {
      props[key] = Type.Optional(Type.Boolean(val.description ? { description: val.description } : {}));
    } else {
      props[key] = Type.Optional(Type.Any());
    }
  }

  const required: string[] = raw.required || [];
  for (const key of required) {
    if (!props[key]) {
      continue;
    }
    const desc = (raw.properties[key] as any)?.description;
    if ((raw.properties[key] as any)?.type === "string") {
      props[key] = stringSchema(raw.properties[key]);
    } else if ((raw.properties[key] as any)?.type === "number") {
      props[key] = Type.Number(desc ? { description: desc } : {});
    } else if ((raw.properties[key] as any)?.type === "boolean") {
      props[key] = Type.Boolean(desc ? { description: desc } : {});
    }
  }

  return Type.Object(props);
}

/**
 * Wrap a legacy `{ inputSchema, invoke }` tool definition in the PI execute shape.
 */
export function wrapLegacyTool(raw: any): any {
  const parameters = toTypeBoxSchema(raw.inputSchema);
  return {
    name: raw.name,
    description: raw.description,
    parameters,
    async execute(toolCallId: string, params: any, _signal: AbortSignal | undefined, _onUpdate: any, ctx: any) {
      try {
        const projectRoot = resolveProjectRoot(ctx?.cwd || getProjectRoot());
        setProjectRoot(projectRoot);
        const paramsWithRoot: Record<string, unknown> = { ...params, _projectRoot: projectRoot };
        if (typeof _onUpdate === "function") {
          paramsWithRoot.__onUpdate = (update: unknown) => {
            try {
              _onUpdate(update);
            } catch {
              // Progress reporting must not change tool behavior.
            }
          };
        }
        const result = await raw.invoke(paramsWithRoot);
        return {
          content: [{ type: "text" as const, text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }],
          details: result,
        };
      } catch (error: any) {
        return {
          content: [{ type: "text" as const, text: error?.message || String(error) }],
          isError: true,
          details: { error: error?.message || String(error) },
        };
      }
    },
  };
}
