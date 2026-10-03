/**
 * Initial session title from the first user prompt.
 *
 * The digest renames a session only after agent_end. This gives the session a
 * name as soon as the first prompt is submitted. The first successful digest
 * replaces it with the digest headline.
 */

import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { CompleteFn } from "./completion";
import { log } from "../log";

const MAX_TITLE_CHARS = 80;
const MAX_PROMPT_CHARS = 4000;

const SYSTEM_PROMPT =
	"You name coding-agent sessions. Reply with only a short title (at most 80 characters) " +
	"that summarizes the user's request. No quotes, no trailing punctuation, no preamble.";

/** Normalize model output into a single-line title, or null when unusable. */
export function cleanTitle(raw: string): string | null {
	const line = raw
		.split("\n")
		.map((l) => l.trim())
		.find((l) => l.length > 0);
	if (!line) return null;
	const unquote = (s: string) => s.replace(/^["'`*]+|["'`*]+$/g, "").trim();
	let title = unquote(unquote(line).replace(/^(session )?title\s*:\s*/i, ""))
		.replace(/[.\s]+$/, "")
		.trim();
	if (title.length === 0) return null;
	if (title.length > MAX_TITLE_CHARS) title = `${title.slice(0, MAX_TITLE_CHARS - 1).trimEnd()}…`;
	return title;
}

/** Ask the digest model for a title. Returns null on any failure. */
export async function generateTitle(
	model: Model<Api>,
	prompt: string,
	completeFn: CompleteFn,
	opts: { signal?: AbortSignal } = {},
): Promise<string | null> {
	const text = prompt.trim();
	if (text.length === 0) return null;
	const clipped = text.length > MAX_PROMPT_CHARS ? `${text.slice(0, MAX_PROMPT_CHARS)}…` : text;

	let response: AssistantMessage;
	try {
		response = await completeFn(
			model,
			{
				systemPrompt: SYSTEM_PROMPT,
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: `Title this request:\n\n${clipped}` }],
						timestamp: Date.now(),
					},
				],
			},
			{ signal: opts.signal },
		);
	} catch (err: unknown) {
		const emsg = err instanceof Error ? err.message : String(err);
		log.warn({ comp: "digest", provider: model.provider, model: model.id, err: emsg }, "initial title: completion threw");
		return null;
	}

	if ((response as { stopReason?: string }).stopReason === "error") {
		log.warn(
			{ comp: "digest", provider: model.provider, model: model.id, errorMessage: (response as { errorMessage?: string }).errorMessage },
			"initial title: completion returned an error response",
		);
		return null;
	}

	const raw = response.content
		.filter((c): c is { type: "text"; text: string } => (c as { type?: string }).type === "text")
		.map((c) => c.text)
		.join("\n");
	return cleanTitle(raw);
}
