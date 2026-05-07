/**
 * mock-pi.ts — test harness for pi-coding-agent ExtensionAPI
 *
 * Exposes inspection methods so tests can assert registration counts,
 * simulate invocations, and trigger events without running a real pi.
 *
 * Usage:
 *   const pi = createMockPi()
 *   ext(pi)                    // module-load registration
 *   assert.equal(pi.handlerCount("session_start"), 2)
 *   assert(pi.toolNames().includes("session_search"))
 *   await pi.fireSessionStart(ctx)
 *   await pi.invokeCommand("find-session", "", ctx)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"

// ─── Internal types ────────────────────────────────────────────────

interface MockCommandDef {
  description: string
  handler: (args: string, ctx: any) => void | Promise<void>
}

interface MockToolDef {
  name: string
  label: string
  execute: (callId: string, params: any, signal?: AbortSignal) => any
}

interface MockEventHandler {
  event: string
  handler: (event: any, ctx: any) => void | Promise<void>
}

// ─── Mock pi object ───────────────────────────────────────────────

export interface MockPi extends ExtensionAPI {
  /** Count of registered handlers for a given event name. */
  handlerCount(event: string): number
  /** All registered tool names (deduplicated). */
  toolNames(): string[]
  /** All registered command names. */
  commandNames(): string[]
  /** Invoke a command handler by name. Returns the handler's result, or throws if not found. */
  invokeCommand(name: string, args: string, ctx: any): Promise<void>
  /** Invoke a tool handler by name. Returns the execute result, or throws if not found. */
  invokeTool(name: string, params: any, ctx?: any, signal?: AbortSignal): Promise<any>
  /** Fire all registered session_start handlers in registration order. */
  fireSessionStart(ctx: any): Promise<void>
  /** Fire all registered session_shutdown handlers. */
  fireSessionShutdown(ctx: any): Promise<void>
  /** Fire all registered before_agent_start handlers. */
  fireBeforeAgentStart(event: any, ctx: any): Promise<void>
  /** Internal registries (for deep inspection). */
  _commands: Map<string, MockCommandDef>
  _tools: MockToolDef[]
  _eventHandlers: MockEventHandler[]
}

/** Create a fresh mock ExtensionAPI for testing. */
export function createMockPi(): MockPi {
  const commands = new Map<string, MockCommandDef>()
  const tools: MockToolDef[] = []
  const eventHandlers: MockEventHandler[] = []
  let lifecycleInstallCount = 0

  const pi: MockPi = {
    // ── Registries (exposed for inspection) ──────────────────────
    _commands: commands,
    _tools: tools,
    _eventHandlers: eventHandlers,

    get commands() { return commands as any },
    get tools() { return tools as any },
    get eventHandlers() { return eventHandlers as any },
    get lifecycleInstallCount() { return lifecycleInstallCount },

    // ── ExtensionAPI implementation ───────────────────────────────
    registerCommand: (name: string, def: MockCommandDef) => {
      commands.set(name, def)
    },

    registerTool: (def: MockToolDef) => {
      // Avoid duplicates (module-load may be called once)
      if (!tools.find(t => t.name === def.name)) {
        tools.push(def)
      }
    },

    on: (event: string, handler: (event: any, ctx: any) => void | Promise<void>) => {
      eventHandlers.push({ event, handler })
    },

    setSessionName: (_name: string) => {},

    // ── Inspection helpers ──────────────────────────────────────
    handlerCount(event: string): number {
      return eventHandlers.filter(h => h.event === event).length
    },

    toolNames(): string[] {
      return [...new Set(tools.map(t => t.name))]
    },

    commandNames(): string[] {
      return [...commands.keys()]
    },

    async invokeCommand(name: string, args: string, ctx: any): Promise<void> {
      const cmd = commands.get(name)
      if (!cmd) throw new Error(`command not found: ${name}`)
      await cmd.handler(args, ctx)
    },

    async invokeTool(name: string, params: any, _ctx?: any, _signal?: AbortSignal): Promise<any> {
      const tool = tools.find(t => t.name === name)
      if (!tool) throw new Error(`tool not found: ${name}`)
      return tool.execute("mock-call-id", params, _signal)
    },

    async fireSessionStart(ctx: any): Promise<void> {
      for (const h of eventHandlers.filter(h => h.event === "session_start")) {
        await h.handler("event", ctx)
      }
    },

    async fireSessionShutdown(ctx: any): Promise<void> {
      for (const h of eventHandlers.filter(h => h.event === "session_shutdown")) {
        await h.handler("event", ctx)
      }
    },

    async fireBeforeAgentStart(event: any, ctx: any): Promise<void> {
      for (const h of eventHandlers.filter(h => h.event === "before_agent_start")) {
        await h.handler(event, ctx)
      }
    },
  }

  return pi
}

/** Create a basic mock ExtensionContext (ctx) for tests. */
export function createMockCtx(overrides: any = {}): any {
  return {
    cwd: "/tmp/test-cwd",
    sessionManager: {
      getSessionId: () => "test-session-id",
      getBranch: () => [],
    },
    modelRegistry: {
      getAvailable: () => [
        { provider: "test", id: "gpt-4", cost: { input: 0.01, output: 0.03 } },
        { provider: "test", id: "gpt-4-mini", cost: { input: 0.00015, output: 0.0006 } },
      ],
    },
    ui: {
      notify: (_msg: string, _level?: string) => {},
      setStatus: (_key: string, _msg: string) => {},
      input: async (_prompt: string, _default?: string) => "",
    },
    ...overrides,
  }
}
