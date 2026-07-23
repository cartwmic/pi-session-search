/**
 * Flat searchable model picker for digest configuration.
 * Emulates pi's built-in /model command UX.
 */
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	Input,
	SelectList,
	fuzzyFilter,
	type Component,
	type Focusable,
	type SelectItem,
	type Theme,
	type TUI,
} from "@mariozechner/pi-tui";

/** SelectList with standard fuzzy filtering on label + description. */
class FuzzySelectList extends SelectList {
	override setFilter(filter: string): void {
		const self = this as unknown as {
			items: SelectItem[];
			filteredItems: SelectItem[];
			selectedIndex: number;
		};
		const trimmed = filter.trim();
		if (!trimmed) {
			self.filteredItems = self.items.slice();
			self.selectedIndex = 0;
			return;
		}
		self.filteredItems = fuzzyFilter(
			self.items,
			trimmed,
			(item) => `${item.label} ${item.description ?? ""}`,
		);
		self.selectedIndex = 0;
	}
}

interface ModelPickerOptions {
	prompt: string;
	currentModel?: string;
}

class ModelPickerComponent implements Component, Focusable {
	focused = true;
	private input: Input;
	private list: SelectList;
	private prompt: string;
	private theme: Theme;
	private tui: TUI;

	constructor(
		tui: TUI,
		theme: Theme,
		private done: (result: string | undefined) => void,
		items: SelectItem[],
		prompt: string,
		currentModel?: string,
	) {
		this.tui = tui;
		this.theme = theme;
		this.prompt = prompt;
		this.list = new FuzzySelectList(
			items,
			Math.min(items.length, 12),
			{
				selectedPrefix: (t: string) => theme.fg("accent", t),
				selectedText: (t: string) => theme.fg("accent", t),
				description: (t: string) => theme.fg("muted", t),
				scrollInfo: (t: string) => theme.fg("dim", t),
				noMatch: (t: string) => theme.fg("warning", t),
			},
		);

		if (currentModel) {
			const idx = items.findIndex((i) => i.value === currentModel);
			if (idx >= 0) this.list.setSelectedIndex(idx);
		}

		this.list.onSelect = (item) => this.done(item.value);
		this.list.onCancel = () => this.done(undefined);

		this.input = new Input();
		this.input.focused = true;
	}

	invalidate(): void {
		this.input.invalidate();
		this.list.invalidate();
	}

	render(width: number): string[] {
		const lines: string[] = [];
		lines.push(this.theme.fg("accent", this.prompt));
		lines.push(
			this.theme.fg("dim", "filter: ") +
				(this.input.getValue() || this.theme.fg("dim", "(type to filter)")),
		);
		lines.push(...this.list.render(width));
		return lines;
	}

	handleInput(data: string): void {
		const before = this.input.getValue();
		this.input.handleInput(data);
		const after = this.input.getValue();
		if (before !== after) {
			this.list.setFilter(after);
			this.tui.requestRender();
			return;
		}
		this.list.handleInput(data);
		this.tui.requestRender();
	}
}

export async function pickDigestModel(
	ctx: ExtensionContext,
	options: ModelPickerOptions,
): Promise<string | undefined> {
	if (!ctx.ui?.custom) return undefined;

	const models = ctx.modelRegistry.getAvailable();
	const items: SelectItem[] = models.map((m) => ({
		value: `${m.provider}/${m.id}`,
		label: m.id,
		description: m.provider,
	}));

	return ctx.ui.custom<string | undefined>(
		(tui, theme, _kb, done) =>
			new ModelPickerComponent(
				tui,
				theme,
				done,
				items,
				options.prompt,
				options.currentModel,
			),
		{
			overlay: true,
			overlayOptions: { anchor: "center", width: 72, maxHeight: "70%" },
		},
	);
}
