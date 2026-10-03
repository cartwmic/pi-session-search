import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";

export interface CompletionContext {
	systemPrompt?: string;
	messages: unknown[];
	tools?: unknown[];
}

export interface CompletionOptions {
	signal?: AbortSignal;
}

export type CompleteFn = (
	model: Model<Api>,
	context: CompletionContext,
	options?: CompletionOptions,
) => Promise<AssistantMessage>;

/** Structural subset of Pi's ModelRegistry needed by digest generation. */
export interface HostModelRegistry {
	getProvider: (providerId: string) => unknown | undefined;
	stream: (
		model: Model<Api>,
		context: CompletionContext,
		options?: CompletionOptions,
	) => { result: () => Promise<AssistantMessage> };
}

/**
 * Dispatch through Pi's public registry, not the extension-local pi-ai package
 * or a raw provider stream. The registry normalizes Context.systemPrompt and
 * Context.tools into the provider transcript and resolves host authentication.
 */
export async function resolveHostCompleteFn(
	registry: HostModelRegistry,
	model: Model<Api>,
): Promise<CompleteFn> {
	if (!registry.getProvider(model.provider)) {
		throw new Error(`No host provider available for: ${model.provider}`);
	}

	return (requestModel, context, options) =>
		registry.stream(requestModel, context, options).result();
}
