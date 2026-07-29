"use strict";

const { Plugin, PluginSettingTab, Setting } = require("obsidian");
const { WidgetType, Decoration, ViewPlugin } = require("@codemirror/view");
const { RangeSetBuilder } = require("@codemirror/state");

// --- CONSTANTS AND SETTINGS ---
const DEFAULT_SETTINGS = {
	particleDensity: 14,
	particleSpeed: 0.35,
	revealOnClick: true,
	hideOnMouseLeave: false,
	disableInEditMode: false,
	useAccentColor: false
};

const SPOILER_REGEX = /\|\|([^|\n]+)\|\|/g;
const TWO_PI = Math.PI * 2;

// --- SPOILER REGISTRY ---
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

// --- MAIN ANIMATION CLASS (CANVAS & PARTICLES) ---
class SpoilerInstance {
	constructor(text, settings, registry) {
		this.particles = [];
		this.rafId = null;
		this.revealed = false;
		this.destroyed = false;
		this.settings = settings;
		this.registry = registry;
		this.particleColor = "currentColor"; // Color cache for performance
		
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

	normalizeColorToRgb(colorStr) {
		const tempEl = document.createElement("div");
		tempEl.style.color = colorStr;
		tempEl.style.display = "none";
		document.body.appendChild(tempEl);
		
		const computedColor = getComputedStyle(tempEl).color;
		document.body.removeChild(tempEl);
		
		const match = computedColor.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
		return match ? [match[1], match[2], match[3]] : null;
	}

	applyColorFromText() {
		let baseColor;
		
		this.textEl.style.color = ''; 
		const originalTextColor = getComputedStyle(this.textEl).color;

		if (this.settings.useAccentColor) {
			baseColor = getComputedStyle(document.body).getPropertyValue('--interactive-accent').trim();
			// Fallback: if the variable is empty, use the text color
			if (!baseColor) baseColor = originalTextColor;
			
			if (!this.revealed) {
				this.textEl.style.color = baseColor;
			}
		} else {
			baseColor = originalTextColor;
		}

		// Calculate RGB once and cache it to avoid overloading the animation loop (requestAnimationFrame)
		const rgb = this.normalizeColorToRgb(baseColor);
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
		if (this.rafId !== null || this.destroyed) return;
		
		const loop = () => {
			if (this.destroyed || this.revealed) {
				this.rafId = null;
				return;
			}
			this.tick();
			this.rafId = requestAnimationFrame(loop);
		};
		this.rafId = requestAnimationFrame(loop);
	}

	stop() {
		if (this.rafId !== null) {
			cancelAnimationFrame(this.rafId);
			this.rafId = null;
		}
	}

	tick() {
		const dpr = window.devicePixelRatio || 1;
		const width = this.canvas.width / dpr;
		const height = this.canvas.height / dpr;
		const ctx = this.ctx;
		
		ctx.clearRect(0, 0, width, height);
		
		const speed = this.settings.particleSpeed;

		// Use the cached color — this speeds up canvas rendering significantly
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

// --- READING MODE PARSER ---
function renderMarkdownSpoilers(el, settings, registry) {
	const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
		acceptNode: (node) => {
			const parent = node.parentElement;
			if (!parent || parent.closest("code, pre, .tg-spoiler")) {
				return NodeFilter.FILTER_REJECT;
			}
			if (!node.textContent || !node.textContent.includes("||")) {
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
		SPOILER_REGEX.lastIndex = 0;
		if (!SPOILER_REGEX.test(text)) continue;
		
		SPOILER_REGEX.lastIndex = 0;
		const fragment = document.createDocumentFragment();
		let lastIndex = 0;
		let match;
		
		while ((match = SPOILER_REGEX.exec(text))) {
			const [fullMatch, innerText] = match;
			
			if (match.index > lastIndex) {
				fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
			}
			
			const spoiler = new SpoilerInstance(innerText, settings, registry);
			fragment.appendChild(spoiler.el);
			lastIndex = match.index + fullMatch.length;
		}
		
		if (lastIndex < text.length) {
			fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
		}
		
		node.parentNode?.replaceChild(fragment, node);
	}
}

// --- LIVE PREVIEW COMPONENT ---
class SpoilerWidget extends WidgetType {
	constructor(text, settings, registry) {
		super();
		this.text = text;
		this.settings = settings;
		this.registry = registry;
		this.instance = null;
	}

	eq(other) {
		return other.text === this.text && other.settings.useAccentColor === this.settings.useAccentColor;
	}

	toDOM() {
		this.instance = new SpoilerInstance(this.text, this.settings, this.registry);
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
	
	for (let { from, to } of view.visibleRanges) {
		const text = view.state.doc.sliceString(from, to);
		SPOILER_REGEX.lastIndex = 0;
		let match;
		
		while ((match = SPOILER_REGEX.exec(text))) {
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

// --- MAIN PLUGIN CLASS ---
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

		// Observe changes to <body> attributes (accent color or theme changes)
		this.themeObserver = new MutationObserver((mutations) => {
			let shouldRefresh = false;
			for (let mutation of mutations) {
				// If classes changed (light/dark theme toggle) or styles changed (accent color change)
				if (mutation.type === 'attributes' && (mutation.attributeName === 'style' || mutation.attributeName === 'class')) {
					shouldRefresh = true;
					break;
				}
			}
			
			if (shouldRefresh) {
				// Give the browser 20ms to apply new styles, then refresh all open spoilers
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

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

// --- UI SETTINGS ---
class ParticleSpoilerSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();
		
		containerEl.createEl("h2", { text: "Particle Style Spoiler" });

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
			.setDesc("If enabled, spoilers won't be hidden in Live Preview (visible as normal text ||...||), the effect applies only in Reading mode.")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.disableInEditMode)
				.onChange(async (value) => {
					this.plugin.settings.disableInEditMode = value;
					await this.plugin.saveSettings();
					this.plugin.refreshEditors();
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

		containerEl.createEl("p", {
			text: "Syntax: ||hidden text|| — turns the text into a spoiler with particle animation. Works in both Reading mode and Live Preview.",
			cls: "setting-item-description"
		});
	}
}

module.exports = ParticleSpoilerPlugin;
