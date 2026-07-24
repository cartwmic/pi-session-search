import type { AssistantMessage } from "@mariozechner/pi-ai";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CostRollup {
	calls: number;
	tokensIn: number;
	tokensOut: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Create an empty (zero) rollup. */
export function emptyRollup(): CostRollup {
	return {
		calls: 0,
		tokensIn: 0,
		tokensOut: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/**
 * Pure accumulator: add one LLM response's usage to an existing rollup.
 * Returns a new rollup (does not mutate `rollup`).
 */
export function record(
	rollup: CostRollup,
	response: AssistantMessage,
): CostRollup {
	const u = response.usage;
	return {
		calls: rollup.calls + 1,
		tokensIn: rollup.tokensIn + u.input,
		tokensOut: rollup.tokensOut + u.output,
		cost: {
			input: rollup.cost.input + u.cost.input,
			output: rollup.cost.output + u.cost.output,
			cacheRead: rollup.cost.cacheRead + u.cost.cacheRead,
			cacheWrite: rollup.cost.cacheWrite + u.cost.cacheWrite,
			total: rollup.cost.total + u.cost.total,
		},
	};
}

/**
 * Format a rollup as a one-line string for /session:cost display.
 * Includes "this process" wording to clarify the scope.
 */
export function format(rollup: CostRollup, modelName: string): string {
	const total = rollup.cost.total.toFixed(4);
	return (
		`[session:cost] this process — model: ${modelName} | ` +
		`calls: ${rollup.calls} | ` +
		`tokens in: ${rollup.tokensIn} / out: ${rollup.tokensOut} | ` +
		`cost: $${total}`
	);
}
