/** Client hints only. These do not authorize or enforce tool behavior. */
export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export const READ_ONLY = Object.freeze({ readOnlyHint: true, idempotentHint: true } as const);
export const IDEMPOTENT_WRITE = Object.freeze({ readOnlyHint: false, idempotentHint: true } as const);
export const WRITE = Object.freeze({ readOnlyHint: false, idempotentHint: false } as const);
export const DESTRUCTIVE = Object.freeze({ readOnlyHint: false, destructiveHint: true, idempotentHint: false } as const);
export const SPENDS_MONEY = Object.freeze({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const);
/** Combine with a read or write preset to describe external interactions. */
export const OPEN_WORLD = Object.freeze({ openWorldHint: true } as const);

/** At least one hint is required even when callers do not use a preset. */
export type BehaviorAnnotations = ToolAnnotations & (
  | { readOnlyHint: boolean }
  | { destructiveHint: boolean }
  | { idempotentHint: boolean }
  | { openWorldHint: boolean }
);

const hintKeys = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const;

/** Require an explicit behavior hint; a display title alone is not an annotation policy. */
export function assertAnnotations(value: unknown): asserts value is BehaviorAnnotations {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Tool annotations must be an object with a behavior hint");
  }
  const annotations = value as Record<string, unknown>;
  if (!hintKeys.some((key) => Object.hasOwn(annotations, key))) {
    throw new TypeError("Tool annotations must include a behavior hint");
  }
  for (const key of Object.keys(annotations)) {
    if (key === "title") {
      if (typeof annotations[key] !== "string") throw new TypeError("Annotation title must be a string");
    } else if (!hintKeys.includes(key as typeof hintKeys[number]) || typeof annotations[key] !== "boolean") {
      throw new TypeError("Tool annotations contain an unknown or invalid hint");
    }
  }
}

export interface AnnotatedToolConfig {
  annotations: BehaviorAnnotations;
}

/** Structural adapter: no SDK version or schema library becomes a runtime dependency. */
export function registerTool<
  Config extends AnnotatedToolConfig,
  Callback extends (...args: never[]) => unknown,
  Registered,
>(
  server: { registerTool(name: string, config: NoInfer<Config>, callback: NoInfer<Callback>): Registered },
  name: string,
  config: Config,
  callback: Callback,
): Registered {
  assertAnnotations(config?.annotations);
  // Calling the method on its owner preserves SDK instance state and its return type.
  return server.registerTool(name, config, callback);
}
