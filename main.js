"use strict";

const { Plugin, PluginSettingTab, Setting, MarkdownView } = require("obsidian");
const { WidgetType, Decoration, ViewPlugin } = require("@codemirror/view");
const { RangeSetBuilder } = require("@codemirror/state");

const DEFAULT_SETTINGS = {
	particleDensity: 10,
	particleSpeed: 0.10,
	revealOnClick: true,
	hideOnMouseLeave: false,
	disableInEditMode: true,
	useAccentColor: false,
	spoilerStyle: "particle",
	blockColorMode: "accent",
	blockCustomColor: "#000000",
	customMarker: "||"
};

const TWO_PI = Math.PI * 2;

function escapeRegExp(string) {
	return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getSpoilerRegex(marker) {
	const escaped = escapeRegExp(marker);
	return new RegExp(`${escaped}([^\\n]+?)${escaped}`, "g");
}

class SharedAnimationScheduler {
	constructor() {
		this.members = new Set();
		this.rafId = null;
	}

	add(instance) {
		this.members.add(instance);
		this.ensureRunning();
	}

	remove(instance) {
		this.members.delete(instance);
	}

	ensureRunning() {
		if (this.rafId !== null) return;
		const loop = () => {
			if (this.members.size === 0) {
				this.rafId = null;
				return;
			}
			for (let instance of this.members) instance.tick();
			this.rafId = requestAnimationFrame(loop);
		};
		this.rafId = requestAnimationFrame(loop);
	}
}
const sharedAnimator = new SharedAnimationScheduler();

const colorResolutionCache = new Map();
let colorProbeEl = null;

function getColorProbeEl() {
	if (!colorProbeEl) {
		colorProbeEl = document.createElement("span");
		colorProbeEl.style.position = "absolute";
		colorProbeEl.style.width = "0";
		colorProbeEl.style.height = "0";
		colorProbeEl.style.overflow = "hidden";
		colorProbeEl.style.pointerEvents = "none";
		colorProbeEl.setAttribute("aria-hidden", "true");
		document.body.appendChild(colorProbeEl);
	}
	return colorProbeEl;
}

function resolveColorToRgb(colorStr) {
	const cached = colorResolutionCache.get(colorStr);
	if (cached !== undefined) return cached;

	const probe = getColorProbeEl();
	probe.style.color = colorStr;
	const computedColor = getComputedStyle(probe).color;
	const match = computedColor.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
	const result = match ? [match[1], match[2], match[3]] : null;

	colorResolutionCache.set(colorStr, result);
	return result;
}

class SpoilerRegistry {
	constructor() {
		this.instances = new Set();
	}
	add(instance) { this.instances.add(instance); }
	remove(instance) { this.instances.delete(instance); }
	
	refreshDensity() {
		for (let instance of this.instances) {
			instance.applyDensity();
		}
	}
	
	refreshColors() {
		for (let instance of this.instances) {
			instance.applyColorFromText();
		}
	}
	
	destroyAll() {
		for (let instance of Array.from(this.instances)) {
			instance.destroy();
		}
		this.instances.clear();
	}
}

class SpoilerInstance {
	constructor(text, settings, registry) {
		this.particles = [];
		this.revealed = false;
		this.destroyed = false;
		this.settings = settings;
		this.registry = registry;
		this.particleColor = "currentColor"; 
		
		this.registry.add(this);
		
		this.el = document.createElement("span");
		this.el.className = "tg-spoiler";
		this.el.setAttribute("tabindex", "0");
		this.el.setAttribute("role", "button");
		this.el.setAttribute("aria-label", "Spoiler, click to reveal");
		
		this.textEl = document.createElement("span");
		this.textEl.className = "tg-spoiler-text";
		this.textEl.textContent = text;
		
		this.canvas = document.createElement("canvas");
		this.canvas.className = "tg-spoiler-canvas";
		
		this.el.appendChild(this.textEl);
		this.el.appendChild(this.canvas);
		
		this.ctx = this.canvas.getContext("2d");
		
		this.el.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.toggle();
		});
		
		this.el.addEventListener("keydown", (e) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				this.toggle();
			}
		});
		
		this.el.addEventListener("mouseleave", () => {
			if (this.revealed && this.settings.hideOnMouseLeave) {
				this.hide();
			}
		});
		
		this.resizeObserver = new ResizeObserver(() => this.setup());
		this.resizeObserver.observe(this.el);
		
		requestAnimationFrame(() => this.setup());
	}

	setup() {
		if (this.destroyed) return;
		
		const rect = this.el.getBoundingClientRect();
		const width = Math.max(rect.width, this.textEl.offsetWidth, 4);
		const height = Math.max(rect.height, this.textEl.offsetHeight, 4);
		const dpr = window.devicePixelRatio || 1;
		
		this.canvas.width = width * dpr;
		this.canvas.height = height * dpr;
		this.canvas.style.width = `${width}px`;
		this.canvas.style.height = `${height}px`;
		
		this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		
		this.applyColorFromText();
		this.regenerateParticles(width, height);
		
		if (!this.revealed) {
			this.start();
		}
	}

	applyColorFromText() {
		let baseColor;
		
		this.textEl.style.color = ''; 
		const originalTextColor = getComputedStyle(this.textEl).color;

		if (this.settings.useAccentColor) {
			baseColor = getComputedStyle(document.body).getPropertyValue('--interactive-accent').trim();
			if (!baseColor) baseColor = originalTextColor;
			
			if (!this.revealed) {
				this.textEl.style.color = baseColor;
			}
		} else {
			baseColor = originalTextColor;
		}

		const rgb = resolveColorToRgb(baseColor);
		if (rgb) {
			this.particleColor = `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
			this.el.style.setProperty("--tg-spoiler-tint-bg", `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.16)`);
			this.el.style.setProperty("--tg-spoiler-tint-ring", `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.4)`);
		} else {
			this.particleColor = baseColor;
			this.el.style.setProperty("--tg-spoiler-tint-bg", baseColor);
			this.el.style.setProperty("--tg-spoiler-tint-ring", baseColor);
		}
	}

	regenerateParticles(width, height) {
		const count = Math.max(6, Math.round((width * height) / (this.settings.particleDensity * 20)));
		this.particles = new Array(count).fill(0).map(() => this.makeParticle(width, height));
	}

	applyDensity() {
		if (this.destroyed) return;
		const dpr = window.devicePixelRatio || 1;
		const width = this.canvas.width / dpr;
		const height = this.canvas.height / dpr;
		
		if (width <= 0 || height <= 0) return;
		this.regenerateParticles(width, height);
	}

	makeParticle(width, height) {
		const angle = Math.random() * TWO_PI;
		return {
			x: Math.random() * width,
			y: Math.random() * height,
			dirX: Math.cos(angle),
			dirY: Math.sin(angle),
			speedFactor: 0.5 + Math.random(),
			r: 0.6 + Math.random() * 1.1,
			alpha: 0.3 + Math.random() * 0.7,
			alphaDir: Math.random() > 0.5 ? 1 : -1
		};
	}

	start() {
		if (this.destroyed) return;
		sharedAnimator.add(this);
	}

	stop() {
		sharedAnimator.remove(this);
	}

	tick() {
		const dpr = window.devicePixelRatio || 1;
		const width = this.canvas.width / dpr;
		const height = this.canvas.height / dpr;
		const ctx = this.ctx;
		
		ctx.clearRect(0, 0, width, height);
		
		const speed = this.settings.particleSpeed;

		ctx.fillStyle = this.particleColor;

		for (let p of this.particles) {
			p.x += p.dirX * p.speedFactor * speed;
			p.y += p.dirY * p.speedFactor * speed;
			
			if (p.x < 0) { p.x = 0; p.dirX *= -1; }
			if (p.x > width) { p.x = width; p.dirX *= -1; }
			if (p.y < 0) { p.y = 0; p.dirY *= -1; }
			if (p.y > height) { p.y = height; p.dirY *= -1; }
			
			p.alpha += p.alphaDir * 0.01;
			if (p.alpha <= 0.2 || p.alpha >= 1) {
				p.alphaDir *= -1;
			}
			
			ctx.beginPath();
			ctx.globalAlpha = p.alpha;
			ctx.arc(p.x, p.y, p.r, 0, TWO_PI);
			ctx.fill();
		}
		
		ctx.globalAlpha = 1;
	}

	toggle() {
		this.revealed ? this.hide() : this.show();
	}

	show() {
		this.revealed = true;
		this.el.classList.add("tg-spoiler-revealed");
		
		if (this.settings.useAccentColor) {
			this.textEl.style.color = '';
		}
		
		this.stop();
	}

	hide() {
		this.revealed = false;
		this.el.classList.remove("tg-spoiler-revealed");
		
		if (this.settings.useAccentColor) {
			this.textEl.style.color = this.particleColor;
		}
		
		this.start();
	}

	destroy() {
		this.destroyed = true;
		this.stop();
		this.resizeObserver.disconnect();
		this.registry.remove(this);
	}
}

class BlockSpoilerInstance {
	constructor(text, settings, registry) {
		this.revealed = false;
		this.destroyed = false;
		this.settings = settings;
		this.registry = registry;

		this.registry.add(this);

		this.el = document.createElement("span");
		this.el.className = "tg-block-spoiler";
		this.el.textContent = text;
		this.el.setAttribute("tabindex", "0");
		this.el.setAttribute("role", "button");
		this.el.setAttribute("aria-label", "Spoiler, click to reveal");

		this.el.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.toggle();
		});

		this.el.addEventListener("keydown", (e) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				this.toggle();
			}
		});

		this.el.addEventListener("mouseleave", () => {
			if (this.revealed && this.settings.hideOnMouseLeave) {
				this.hide();
			}
		});

		this.applyColor();
	}

	applyColor() {
		const raw = this.settings.blockColorMode === "custom" && this.settings.blockCustomColor
			? this.settings.blockCustomColor
			: getComputedStyle(document.body).getPropertyValue("--interactive-accent").trim() || "var(--interactive-accent)";

		const rgb = resolveColorToRgb(raw);
		if (rgb) {
			this.el.style.setProperty("--tg-block-color", `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`);
			this.el.style.setProperty("--tg-block-tint", `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.14)`);
		} else {
			this.el.style.setProperty("--tg-block-color", raw);
			this.el.style.setProperty("--tg-block-tint", raw);
		}
	}

	applyDensity() {}
	applyColorFromText() { this.applyColor(); }

	toggle() {
		this.revealed ? this.hide() : this.show();
	}

	show() {
		this.revealed = true;
		this.el.classList.add("tg-block-spoiler-revealed");
	}

	hide() {
		this.revealed = false;
		this.el.classList.remove("tg-block-spoiler-revealed");
	}

	destroy() {
		this.destroyed = true;
		this.registry.remove(this);
	}
}

function createSpoilerInstance(text, settings, registry) {
	return settings.spoilerStyle === "block"
		? new BlockSpoilerInstance(text, settings, registry)
		: new SpoilerInstance(text, settings, registry);
}

function renderMarkdownSpoilers(el, settings, registry) {
	const marker = settings.customMarker;
	const regex = getSpoilerRegex(marker);

	const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
		acceptNode: (node) => {
			const parent = node.parentElement;
			if (!parent || parent.closest("code, pre, .tg-spoiler")) {
				return NodeFilter.FILTER_REJECT;
			}
			if (!node.textContent || !node.textContent.includes(marker)) {
				return NodeFilter.FILTER_SKIP;
			}
			return NodeFilter.FILTER_ACCEPT;
		}
	});

	const nodesToReplace = [];
	let currentNode;
	while ((currentNode = walker.nextNode())) {
		nodesToReplace.push(currentNode);
	}

	for (let node of nodesToReplace) {
		const text = node.textContent || "";
		regex.lastIndex = 0;
		if (!regex.test(text)) continue;
		
		regex.lastIndex = 0;
		const fragment = document.createDocumentFragment();
		let lastIndex = 0;
		let match;
		
		while ((match = regex.exec(text))) {
			const [fullMatch, innerText] = match;
			
			if (match.index > lastIndex) {
				fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
			}
			
			const spoiler = createSpoilerInstance(innerText, settings, registry);
			fragment.appendChild(spoiler.el);
			lastIndex = match.index + fullMatch.length;
		}
		
		if (lastIndex < text.length) {
			fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
		}
		
		node.parentNode?.replaceChild(fragment, node);
	}
}

class SpoilerWidget extends WidgetType {
	constructor(text, settings, registry) {
		super();
		this.text = text;
		this.settings = settings;
		this.registry = registry;
		this.style = settings.spoilerStyle;
		this.instance = null;
	}

	eq(other) {
		return other.text === this.text && other.style === this.style;
	}

	toDOM() {
		this.instance = createSpoilerInstance(this.text, this.settings, this.registry);
		return this.instance.el;
	}

	destroy() {
		if (this.instance) {
			this.instance.destroy();
			this.instance = null;
		}
	}

	ignoreEvent() {
		return false;
	}
}

function buildSpoilerDecorations(view, settings, registry) {
	if (settings.disableInEditMode) {
		return Decoration.none;
	}
	
	const builder = new RangeSetBuilder();
	const selection = view.state.selection;
	const regex = getSpoilerRegex(settings.customMarker);
	
	for (let { from, to } of view.visibleRanges) {
		const text = view.state.doc.sliceString(from, to);
		regex.lastIndex = 0;
		let match;
		
		while ((match = regex.exec(text))) {
			const matchStart = from + match.index;
			const matchEnd = matchStart + match[0].length;
			
			const isCursorInside = selection.ranges.some(
				(range) => range.from <= matchEnd && range.to >= matchStart
			);
			
			if (!isCursorInside) {
				builder.add(
					matchStart,
					matchEnd,
					Decoration.replace({
						widget: new SpoilerWidget(match[1], settings, registry)
					})
				);
			}
		}
	}
	return builder.finish();
}

function createSpoilerViewPlugin(settings, registry, editorViews) {
	return ViewPlugin.fromClass(class {
		constructor(view) {
			this.view = view;
			this.decorations = buildSpoilerDecorations(view, settings, registry);
			editorViews.add(view);
		}
		update(update) {
			this.decorations = buildSpoilerDecorations(update.view, settings, registry);
		}
		destroy() {
			editorViews.delete(this.view);
		}
	}, {
		decorations: v => v.decorations
	});
}

class ParticleSpoilerPlugin extends Plugin {
	constructor() {
		super(...arguments);
		this.registry = new SpoilerRegistry();
		this.editorViews = new Set();
	}

	async onload() {
		await this.loadSettings();
		
		this.registerMarkdownPostProcessor((el, ctx) => {
			renderMarkdownSpoilers(el, this.settings, this.registry);
		});
		
		this.registerEditorExtension(
			createSpoilerViewPlugin(this.settings, this.registry, this.editorViews)
		);
		
		this.addSettingTab(new ParticleSpoilerSettingTab(this.app, this));

		this.addRibbonIcon("eye-off", "Insert spoiler", () => {
			const view = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (view) this.insertSpoilerAtSelection(view.editor);
		});

		this.addCommand({
			id: "insert-spoiler",
			name: "Insert spoiler",
			editorCallback: (editor) => this.insertSpoilerAtSelection(editor)
		});

		this.themeObserver = new MutationObserver((mutations) => {
			let shouldRefresh = false;
			for (let mutation of mutations) {
				if (mutation.type === 'attributes' && (mutation.attributeName === 'style' || mutation.attributeName === 'class')) {
					shouldRefresh = true;
					break;
				}
			}
			
			if (shouldRefresh) {
				setTimeout(() => {
					this.registry.refreshColors();
				}, 20);
			}
		});

		this.themeObserver.observe(document.body, {
			attributes: true,
			attributeFilter: ['style', 'class']
		});
	}

	onunload() {
		if (this.themeObserver) {
			this.themeObserver.disconnect();
		}
		this.registry.destroyAll();
	}

	refreshEditors() {
		for (let view of this.editorViews) {
			view.dispatch({});
		}
	}

	refreshReadingViews() {
		for (let leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (view && view.getMode && view.getMode() === "preview" && view.previewMode && typeof view.previewMode.rerender === "function") {
				view.previewMode.rerender(true);
			}
		}
	}

	insertSpoilerAtSelection(editor) {
		if (!editor) return;
		const selection = editor.getSelection();
		const marker = this.settings.customMarker;
		editor.replaceSelection(`${marker}${selection}${marker}`);
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class ParticleSpoilerSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();
		
		containerEl.createEl("h2", { text: "Spoiler settings" });

		new Setting(containerEl)
			.setName("Custom marker")
			.setDesc("Set a custom marker for spoilers to avoid conflicts (e.g. !!, %%, etc.).")
			.addText(text => text
				.setValue(this.plugin.settings.customMarker)
				.onChange(async (value) => {
					const trimmed = value.trim();
					if (trimmed.length < 2) return;
					this.plugin.settings.customMarker = trimmed;
					await this.plugin.saveSettings();
					this.plugin.refreshEditors();
					this.plugin.refreshReadingViews();
					if (this.syntaxDesc) {
						this.syntaxDesc.setText(`Syntax: ${trimmed}hidden text${trimmed} — turns the text into a spoiler. Works in both Reading mode and Live Preview.`);
					}
				})
			);

		new Setting(containerEl)
			.setName("Spoiler style")
			.setDesc("Particle: animated dust like Telegram. Block: a solid color rectangle like Discord/Steam.")
			.addDropdown(dropdown => dropdown
				.addOption("particle", "Particle")
				.addOption("block", "Block (Discord/Steam-style)")
				.setValue(this.plugin.settings.spoilerStyle)
				.onChange(async (value) => {
					this.plugin.settings.spoilerStyle = value;
					await this.plugin.saveSettings();
					this.plugin.refreshEditors();
					this.plugin.refreshReadingViews();
					this.display();
				})
			);

		if (this.plugin.settings.spoilerStyle === "block") {
			new Setting(containerEl)
				.setName("Block spoiler color")
				.setDesc("The Block style always uses a color — either the app's accent color, or a custom one you pick below.")
				.addDropdown(dropdown => dropdown
					.addOption("accent", "App accent color")
					.addOption("custom", "Custom color")
					.setValue(this.plugin.settings.blockColorMode)
					.onChange(async (value) => {
						this.plugin.settings.blockColorMode = value;
						await this.plugin.saveSettings();
						this.plugin.registry.refreshColors();
						this.display();
					})
				);

			if (this.plugin.settings.blockColorMode === "custom") {
				new Setting(containerEl)
					.setName("Custom block color")
					.setDesc("Only affects the Block style — the Particle style is unaffected.")
					.addColorPicker(picker => picker
						.setValue(this.plugin.settings.blockCustomColor)
						.onChange(async (value) => {
							this.plugin.settings.blockCustomColor = value;
							await this.plugin.saveSettings();
							this.plugin.registry.refreshColors();
						})
					);
			}
		}

		if (this.plugin.settings.spoilerStyle === "particle") {
			new Setting(containerEl)
				.setName("Particle density")
				.setDesc("Lower value means more particles (dust) in the spoiler.")
				.addSlider(slider => slider
					.setLimits(4, 40, 1)
					.setValue(this.plugin.settings.particleDensity)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.particleDensity = value;
						await this.plugin.saveSettings();
						this.plugin.registry.refreshDensity();
					})
				);

			new Setting(containerEl)
				.setName("Particle speed")
				.setDesc("How fast the particles move.")
				.addSlider(slider => slider
					.setLimits(0.1, 1.5, 0.05)
					.setValue(this.plugin.settings.particleSpeed)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.particleSpeed = value;
						await this.plugin.saveSettings();
					})
				);

			new Setting(containerEl)
				.setName("Use accent color")
				.setDesc("If enabled, the glow and particles will use the theme's accent color. Otherwise, the hidden text's color is used.")
				.addToggle(toggle => toggle
					.setValue(this.plugin.settings.useAccentColor)
					.onChange(async (value) => {
						this.plugin.settings.useAccentColor = value;
						await this.plugin.saveSettings();
						this.plugin.registry.refreshColors();
						this.plugin.refreshEditors();
					})
				);
		}

		new Setting(containerEl)
			.setName("Hide on mouse leave")
			.setDesc("If enabled, the spoiler will close again when you move the mouse away after clicking.")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.hideOnMouseLeave)
				.onChange(async (value) => {
					this.plugin.settings.hideOnMouseLeave = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Disable effect in Edit mode")
			.setDesc("If enabled, spoilers won't be hidden in Live Preview, the effect applies only in Reading mode.")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.disableInEditMode)
				.onChange(async (value) => {
					this.plugin.settings.disableInEditMode = value;
					await this.plugin.saveSettings();
					this.plugin.refreshEditors();
				})
			);

		this.syntaxDesc = containerEl.createEl("p", {
			text: `Syntax: ${this.plugin.settings.customMarker}hidden text${this.plugin.settings.customMarker} — turns the text into a spoiler. Works in both Reading mode and Live Preview.`,
			cls: "setting-item-description"
		});
	}
}

module.exports = ParticleSpoilerPlugin;
