declare module "@earendil-works/pi-coding-agent" {
  export interface ToolDefinition {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    invoke(input: Record<string, unknown>): Promise<unknown>;
  }

  export interface CommandDefinition {
    name: string;
    description: string;
    execute(ctx: any, args: any): Promise<unknown>;
  }

  export interface ExtensionAPI {
    on(event: string, handler: (...args: any[]) => Promise<void>): void;
    registerTool(tool: ToolDefinition): void;
    registerCommand(command: CommandDefinition): void;
  }
}
