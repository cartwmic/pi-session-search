import type {
	Api,
	AssistantMessage,
	Model,
} from "@mariozechner/pi-ai";

export interface CompletionContext {
	systemPrompt?: string;
	messages: unknown[];
	tools?: unknown[];
}

export interface CompletionOptions {
	signal?: AbortSignal;
	apiKey?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
}

export type CompleteFn = (
	model: Model<Api>,
	context: CompletionContext,
	options?: CompletionOptions,
) => Promise<AssistantMessage>;

interface ResolvedRequestAuth {
	ok: boolean;
	apiKey?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
	error?: string;
}

interface ProviderAuthResult {
	auth: {
		baseUrl?: string;
	};
	env?: Record<string, string>;
}

interface HostProvider {
	stream: (
		model: Model<Api>,
		context: CompletionContext,
		options?: CompletionOptions,
	) => { result: () => Promise<AssistantMessage> };
}

/** Structural subset of Pi's ModelRegistry needed by digest generation. */
export interface HostModelRegistry {
	getProvider: (providerId: string) => HostProvider | undefined;
	getApiKeyAndHeaders: (model: Model<Api>) => Promise<ResolvedRequestAuth>;
	getProviderAuth?: (providerId: string) => Promise<ProviderAuthResult | undefined>;
}

function mergeRecords(
	base: Record<string, string> | undefined,
	override: Record<string, string> | undefined,
): Record<string, string> | undefined {
	if (!base && !override) return undefined;
	return { ...base, ...override };
}

/**
 * Resolve a completion function against Pi's effective host provider.
 *
 * Since Pi 0.80.10, extension providers belong to the session ModelRuntime and
 * are not registered in pi-ai's legacy global compatibility registry. Calling
 * pi-ai `complete()` directly therefore cannot dispatch custom APIs such as
 * `claude-bridge`. `modelRegistry.getProvider()` returns the effective composed
 * provider, including extension-owned stream behavior, so completion must flow
 * through that provider.
 */
export async function resolveHostCompleteFn(
	registry: HostModelRegistry,
	model: Model<Api>,
): Promise<CompleteFn> {
	const provider = registry.getProvider(model.provider);
	if (!provider) {
		throw new Error(`No host provider available for: ${model.provider}`);
	}

	const requestAuth = await registry.getApiKeyAndHeaders(model);
	if (!requestAuth.ok) {
		throw new Error(
			requestAuth.error ?? `Could not resolve auth for provider: ${model.provider}`,
		);
	}

	// Provider auth can supply a request-specific endpoint (for example an OAuth
	// proxy). getApiKeyAndHeaders() intentionally exposes only key/header/env, so
	// resolve provider auth too when the current Pi runtime supports it.
	const providerAuth = await registry.getProviderAuth?.(model.provider);

	return async (requestModel, context, options = {}) => {
		const effectiveModel = providerAuth?.auth.baseUrl
			? { ...requestModel, baseUrl: providerAuth.auth.baseUrl }
			: requestModel;
		const headers = mergeRecords(requestAuth.headers, options.headers);
		const env = mergeRecords(
			mergeRecords(providerAuth?.env, requestAuth.env),
			options.env,
		);

		return provider
			.stream(effectiveModel, context, {
				...options,
				apiKey: options.apiKey ?? requestAuth.apiKey,
				headers,
				env,
			})
			.result();
	};
}
