"use strict";

const { Plugin, PluginSettingTab, Setting, SettingGroup, MarkdownView, Modal, Platform, setIcon } = require("obsidian");
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
	blurAmount: 5,
	blurRevealOnHover: false,
	scrambleUseAccentColor: false,
	scrambleSpeed: 0.20,
	scrambleStaticMode: false,
	matrixSpeed: 0.10,
	customMarker: "||",
	showWhatsNewOnUpdate: true,
	lastSeenVersion: ""
};

const TWO_PI = Math.PI * 2;
const OTHER_PLUGIN_URL = "obsidian://show-plugin?id=embed-file-menu";

const BLOCK_TAGS = new Set([
	"P", "DIV", "LI", "UL", "OL", "BLOCKQUOTE", "PRE", "TABLE",
	"THEAD", "TBODY", "TFOOT", "TR", "TD", "TH", "H1", "H2",
	"H3", "H4", "H5", "H6", "HR", "SECTION", "ARTICLE", "HEADER",
	"FOOTER", "ASIDE", "DETAILS", "SUMMARY", "FIGURE", "FIGCAPTION",
	"DL", "DT", "DD"
]);

const SKIP_TAGS = new Set([
	"PRE", "SCRIPT", "STYLE", "TEXTAREA", "SVG", "CANVAS", "BUTTON"
]);

const SPOILER_SELECTOR = ".tg-spoiler, .tg-block-spoiler, .tg-blur-spoiler, .tg-scramble-spoiler, .tg-matrix-spoiler";

function escapeRegExp(string) {
	return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getSpoilerRegex(marker) {
	const escaped = escapeRegExp(marker);
	return new RegExp(`${escaped}([^\\n]+?)${escaped}`, "g");
}

function isSafeUrl(url) {
	return /^https?:\/\//i.test(url);
}

function renderInlineMarkdownToFragment(text) {
	const fragment = document.createDocumentFragment();
	const appendParsed = (str, target) => {
		const tokenRe = /`([^`\n]+)`|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|==([\s\S]+?)==|~~([\s\S]+?)~~|\*([^\s*](?:[\s\S]*?[^\s*])?)\*|_([^\s_](?:[\s\S]*?[^\s_])?)_|\[\[([^\]\n]+)\]\]|\[([^\]\n]+)\]\(([^)\s]+)\)/g;
		let lastIndex = 0;
		let match;
		while ((match = tokenRe.exec(str)) !== null) {
			if (match.index > lastIndex) {
				target.appendChild(document.createTextNode(str.slice(lastIndex, match.index)));
			}
			if (match[1] !== undefined) {
				const codeEl = document.createElement("code");
				codeEl.textContent = match[1];
				target.appendChild(codeEl);
			} else if (match[2] !== undefined || match[3] !== undefined) {
				const strongEl = document.createElement("strong");
				appendParsed(match[2] ?? match[3], strongEl);
				target.appendChild(strongEl);
			} else if (match[4] !== undefined) {
				const markEl = document.createElement("mark");
				appendParsed(match[4], markEl);
				target.appendChild(markEl);
			} else if (match[5] !== undefined) {
				const delEl = document.createElement("del");
				appendParsed(match[5], delEl);
				target.appendChild(delEl);
			} else if (match[6] !== undefined || match[7] !== undefined) {
				const emEl = document.createElement("em");
				appendParsed(match[6] ?? match[7], emEl);
				target.appendChild(emEl);
			} else if (match[8] !== undefined) {
				const rawLink = match[8];
				const pipeIdx = rawLink.indexOf("|");
				const display = pipeIdx !== -1 ? rawLink.slice(pipeIdx + 1) : rawLink;
				const linkEl = document.createElement("a");
				linkEl.className = "internal-link";
				linkEl.textContent = display;
				target.appendChild(linkEl);
			} else if (match[9] !== undefined && match[10] !== undefined) {
				const aEl = document.createElement("a");
				aEl.className = "external-link";
				aEl.textContent = match[9];
				if (isSafeUrl(match[10])) {
					aEl.setAttribute("href", match[10]);
					aEl.setAttribute("rel", "noopener noreferrer");
					aEl.setAttribute("target", "_blank");
				}
				target.appendChild(aEl);
			}
			lastIndex = tokenRe.lastIndex;
		}
		if (lastIndex < str.length) {
			target.appendChild(document.createTextNode(str.slice(lastIndex)));
		}
	};
	appendParsed(text, fragment);
	return fragment;
}

function populateSpoilerContent(containerEl, content) {
	if (content instanceof Node) {
		containerEl.appendChild(content.cloneNode(true));
	} else {
		containerEl.appendChild(renderInlineMarkdownToFragment(String(content ?? "")));
	}
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

	reshuffleScramble() {
		for (let instance of this.instances) {
			if (!instance.destroyed && !instance.revealed && typeof instance.shuffle === "function") {
				instance.shuffle();
			}
		}
	}

	updateScrambleMode() {
		for (let instance of this.instances) {
			if (typeof instance.updateStaticMode === "function") {
				instance.updateStaticMode();
			}
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
	constructor(content, settings, registry) {
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
		populateSpoilerContent(this.textEl, content);

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

		this.textEl.style.color = "";
		const originalTextColor = getComputedStyle(this.textEl).color;

		if (this.settings.useAccentColor) {
			baseColor = getComputedStyle(document.body).getPropertyValue("--interactive-accent").trim();
			if (!baseColor) baseColor = originalTextColor;

			if (!this.revealed) {
				this.textEl.style.color = baseColor;
			}
		} else {
			baseColor = originalTextColor;
		}

		const rgb = resolveColorToRgb(baseColor);
		if (rgb) {
			this.particleColor = `rgb(${rgb[0]}, ${rgb[1]},${rgb[2]})`;
			this.el.style.setProperty("--tg-spoiler-tint-bg", `rgba(${rgb[0]}, ${rgb[1]},${rgb[2]}, 0.16)`);
			this.el.style.setProperty("--tg-spoiler-tint-ring", `rgba(${rgb[0]}, ${rgb[1]},${rgb[2]}, 0.4)`);
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
			this.textEl.style.color = "";
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
	constructor(content, settings, registry) {
		this.revealed = false;
		this.destroyed = false;
		this.settings = settings;
		this.registry = registry;

		this.registry.add(this);

		this.el = document.createElement("span");
		this.el.className = "tg-block-spoiler";
		populateSpoilerContent(this.el, content);
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
			this.el.style.setProperty("--tg-block-color", `rgb(${rgb[0]}, ${rgb[1]},${rgb[2]})`);
			this.el.style.setProperty("--tg-block-tint", `rgba(${rgb[0]}, ${rgb[1]},${rgb[2]}, 0.14)`);
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

class BlurSpoilerInstance {
	constructor(content, settings, registry) {
		this.revealed = false;
		this.destroyed = false;
		this.settings = settings;
		this.registry = registry;

		this.registry.add(this);

		this.el = document.createElement("span");
		this.el.className = "tg-blur-spoiler";
		populateSpoilerContent(this.el, content);
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

		this.applyBlurAmount();
	}

	applyBlurAmount() {
		const amount = this.settings.blurAmount ?? 5;
		this.el.style.setProperty("--tg-blur-amount", `${amount}px`);
	}

	applyDensity() { this.applyBlurAmount(); }
	applyColorFromText() {}

	toggle() {
		this.revealed ? this.hide() : this.show();
	}

	show() {
		this.revealed = true;
		this.el.classList.add("tg-blur-spoiler-revealed");
	}

	hide() {
		this.revealed = false;
		this.el.classList.remove("tg-blur-spoiler-revealed");
	}

	destroy() {
		this.destroyed = true;
		this.registry.remove(this);
	}
}

function bindSpoilerInteractions(instance) {
	const el = instance.el;
	instance.hoverRevealed = false;

	el.addEventListener("click", (e) => {
		e.preventDefault();
		e.stopPropagation();
		if (instance.hoverRevealed) {
			instance.hoverRevealed = false;
			return;
		}
		instance.toggle();
	});

	el.addEventListener("keydown", (e) => {
		if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			instance.hoverRevealed = false;
			instance.toggle();
		}
	});

	el.addEventListener("mouseenter", () => {
		if (instance.settings.blurRevealOnHover && !instance.revealed) {
			instance.hoverRevealed = true;
			instance.show();
		}
	});

	el.addEventListener("mouseleave", () => {
		if (!instance.revealed) return;
		if (instance.hoverRevealed) {
			instance.hoverRevealed = false;
			instance.hide();
		} else if (instance.settings.hideOnMouseLeave) {
			instance.hide();
		}
	});
}

const SCRAMBLE_BASE_INTERVAL_MS = 120;
const SCRAMBLE_VERTICAL_CHANCE = 0.5;
const TRANSFORM_90 = "rotate(90deg) scale(0.85)";
const TRANSFORM_MINUS_90 = "rotate(-90deg) scale(0.85)";

class ScrambleSpoilerInstance {
	constructor(content, settings, registry) {
		this.revealed = false;
		this.destroyed = false;
		this.measured = false;
		this.isVisible = true;
		this.settings = settings;
		this.registry = registry;
		this.cells = [];
		this.lastShuffle = performance.now() - Math.random() * SCRAMBLE_BASE_INTERVAL_MS;

		this.registry.add(this);

		this.el = document.createElement("span");
		this.el.className = "tg-scramble-spoiler";
		this.el.setAttribute("tabindex", "0");
		this.el.setAttribute("role", "button");
		this.el.setAttribute("aria-label", "Spoiler, click to reveal");

		populateSpoilerContent(this.el, content);
		this.buildScrambleCells();

		this.order = Array.from({ length: this.cells.length }, (_, i) => i);
		this.allSame = this.cells.length > 0 && this.cells.every((c) => c.original === this.cells[0].original);

		bindSpoilerInteractions(this);
		this.applyColor();

		this.resizeObserver = new ResizeObserver(() => {
			if (!this.measured) this.measure();
		});
		this.resizeObserver.observe(this.el);
		requestAnimationFrame(() => this.measure());

		this.intersectionObserver = new IntersectionObserver((entries) => {
			for (let entry of entries) {
				this.isVisible = entry.isIntersecting;
				if (!this.isVisible) {
					this.stop();
				} else if (!this.revealed && !this.settings.scrambleStaticMode) {
					this.lastShuffle = performance.now();
					this.start();
				}
			}
		});
		this.intersectionObserver.observe(this.el);
	}

	buildScrambleCells() {
		const walker = document.createTreeWalker(this.el, NodeFilter.SHOW_TEXT);
		const textNodes = [];
		let node;
		while ((node = walker.nextNode())) {
			textNodes.push(node);
		}

		for (const textNode of textNodes) {
			const raw = textNode.nodeValue || "";
			if (!raw) continue;
			const frag = document.createDocumentFragment();
			let word = null;
			for (const ch of Array.from(raw)) {
				if (/\s/.test(ch)) {
					word = null;
					frag.appendChild(document.createTextNode(ch));
					continue;
				}
				if (!word) {
					word = document.createElement("span");
					word.className = "tg-scramble-word";
					frag.appendChild(word);
				}
				const span = document.createElement("span");
				span.className = "tg-scramble-char";
				span.textContent = ch;
				word.appendChild(span);
				this.cells.push({
					span,
					original: ch,
					lastChar: ch,
					lastTransform: ""
				});
			}
			textNode.parentNode?.replaceChild(frag, textNode);
		}
	}

	measure() {
		if (this.destroyed || this.cells.length === 0 || this.measured) return;

		const widths = this.cells.map((cell) => cell.span.getBoundingClientRect().width);
		const total = widths.reduce((sum, w) => sum + w, 0);

		if (total > 0) {
			this.cells.forEach((cell, i) => {
				cell.span.style.width = `${widths[i]}px`;
			});
			this.measured = true;

			if (this.resizeObserver) {
				this.resizeObserver.disconnect();
				this.resizeObserver = null;
			}
		}

		if (!this.revealed) {
			this.shuffle();
			if (this.isVisible && !this.settings.scrambleStaticMode) this.start();
		}
	}

	updateStaticMode() {
		if (this.destroyed) return;
		if (this.settings.scrambleStaticMode) {
			this.stop();
		} else if (!this.revealed && this.isVisible) {
			this.lastShuffle = performance.now();
			this.start();
		}
	}

	applyColor() {
		this.el.style.color = this.settings.scrambleUseAccentColor && !this.revealed
			? "var(--interactive-accent)"
			: "";
	}

	shuffle() {
		const n = this.cells.length;
		if (n === 0) return;

		for (let attempt = 0; attempt < 5; attempt++) {
			for (let i = n - 1; i > 0; i--) {
				const j = Math.floor(Math.random() * (i + 1));
				const tmp = this.order[i];
				this.order[i] = this.order[j];
				this.order[j] = tmp;
			}
			if (this.allSame || n < 2 || this.order.some((src, i) => this.cells[src].original !== this.cells[i].original)) {
				break;
			}
		}

		for (let i = 0; i < n; i++) {
			const cell = this.cells[i];
			const ch = this.cells[this.order[i]].original;

			if (cell.lastChar !== ch) {
				cell.span.textContent = ch;
				cell.lastChar = ch;
			}

			let transform = "";
			if (Math.random() < SCRAMBLE_VERTICAL_CHANCE) {
				transform = Math.random() < 0.5 ? TRANSFORM_90 : TRANSFORM_MINUS_90;
			}

			if (cell.lastTransform !== transform) {
				cell.span.style.transform = transform;
				cell.lastTransform = transform;
			}
		}
	}

	restoreOriginal() {
		for (const cell of this.cells) {
			cell.span.textContent = cell.original;
			cell.span.style.transform = "";
			cell.lastChar = cell.original;
			cell.lastTransform = "";
		}
	}

	start() {
		if (this.destroyed || !this.isVisible || this.settings.scrambleStaticMode) return;
		sharedAnimator.add(this);
	}

	stop() {
		sharedAnimator.remove(this);
	}

	tick() {
		if (this.settings.scrambleStaticMode) {
			this.stop();
			return;
		}
		const now = performance.now();
		const speed = Math.max(0.05, this.settings.scrambleSpeed ?? 1);
		if (now - this.lastShuffle < SCRAMBLE_BASE_INTERVAL_MS / speed) return;
		this.lastShuffle = now;
		this.shuffle();
	}

	applyDensity() {}
	applyColorFromText() { this.applyColor(); }

	toggle() {
		this.revealed ? this.hide() : this.show();
	}

	show() {
		this.revealed = true;
		this.el.classList.add("tg-scramble-spoiler-revealed");
		this.applyColor();
		this.stop();
		this.restoreOriginal();
	}

	hide() {
		this.revealed = false;
		this.el.classList.remove("tg-scramble-spoiler-revealed");
		this.applyColor();
		this.shuffle();
		if (this.isVisible && !this.settings.scrambleStaticMode) this.start();
	}

	destroy() {
		this.destroyed = true;
		this.stop();
		if (this.resizeObserver) this.resizeObserver.disconnect();
		if (this.intersectionObserver) this.intersectionObserver.disconnect();
		this.registry.remove(this);
	}
}

const MATRIX_CHARS = Array.from("ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789:.=*+-<>");
const MATRIX_TAIL_COLOR = "#00d433";
const MATRIX_HEAD_COLOR = "#a8ffbe";
const MATRIX_TRAIL_LENGTH = 5;
const MATRIX_ROWS_PER_SECOND = 4;
const MATRIX_FPS = 30;
const MATRIX_FRAME_INTERVAL = 1000 / MATRIX_FPS;

function randomMatrixChar() {
	return MATRIX_CHARS[Math.floor(Math.random() * MATRIX_CHARS.length)];
}

class MatrixSpoilerInstance {
	constructor(content, settings, registry) {
		this.revealed = false;
		this.destroyed = false;
		this.isVisible = true;
		this.settings = settings;
		this.registry = registry;
		this.drops = [];
		this.glyphs = [];
		this.width = 0;
		this.height = 0;
		this.cols = 0;
		this.rows = 0;
		this.cellW = 0;
		this.cellH = 0;
		this.offsetX = 0;
		this.lastTime = performance.now();
		this.lastDrawTime = 0;

		this.registry.add(this);

		this.el = document.createElement("span");
		this.el.className = "tg-matrix-spoiler";
		this.el.setAttribute("tabindex", "0");
		this.el.setAttribute("role", "button");
		this.el.setAttribute("aria-label", "Spoiler, click to reveal");

		this.textEl = document.createElement("span");
		this.textEl.className = "tg-matrix-text";
		populateSpoilerContent(this.textEl, content);

		this.canvas = document.createElement("canvas");
		this.canvas.className = "tg-matrix-canvas";

		this.el.appendChild(this.textEl);
		this.el.appendChild(this.canvas);

		this.ctx = this.canvas.getContext("2d");

		bindSpoilerInteractions(this);

		this.resizeObserver = new ResizeObserver(() => this.setup());
		this.resizeObserver.observe(this.el);

		this.intersectionObserver = new IntersectionObserver((entries) => {
			for (let entry of entries) {
				this.isVisible = entry.isIntersecting;
				if (!this.isVisible) {
					this.stop();
				} else if (!this.revealed) {
					this.lastTime = performance.now();
					this.start();
				}
			}
		});
		this.intersectionObserver.observe(this.el);

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

		const fontSize = parseFloat(getComputedStyle(this.textEl).fontSize) || 16;
		this.cellH = Math.min(14, Math.max(9, Math.round(fontSize * 0.7)));
		this.cellW = Math.round(this.cellH * 0.8);
		this.width = width;
		this.height = height;
		this.cols = Math.max(1, Math.floor(width / this.cellW));
		this.rows = Math.max(1, Math.ceil(height / this.cellH));
		this.offsetX = (width - this.cols * this.cellW) / 2;

		this.ctx.font = `${this.cellH}px monospace`;
		this.ctx.textAlign = "center";
		this.ctx.textBaseline = "middle";

		this.resetRain();

		if (!this.revealed && this.isVisible) this.start();
	}

	resetRain() {
		this.drops = Array.from({ length: this.cols }, () => ({
			y: (Math.random() * 2 - 1) * this.rows,
			factor: 0.5 + Math.random()
		}));
		this.glyphs = Array.from({ length: this.cols * this.rows }, randomMatrixChar);
	}

	start() {
		if (this.destroyed || !this.isVisible) return;
		this.lastTime = performance.now();
		sharedAnimator.add(this);
	}

	stop() {
		sharedAnimator.remove(this);
	}

	tick() {
		if (this.cols === 0) return;

		const now = performance.now();
		if (now - this.lastDrawTime < MATRIX_FRAME_INTERVAL) return;

		const dt = Math.min(0.1, (now - this.lastTime) / 1000);
		this.lastTime = now;
		this.lastDrawTime = now;

		const speed = this.settings.matrixSpeed ?? 1;
		const mutateChance = Math.min(1, 3 * speed * dt);

		const ctx = this.ctx;
		ctx.clearRect(0, 0, this.width, this.height);

		for (let i = 0; i < this.cols; i++) {
			const drop = this.drops[i];
			drop.y += MATRIX_ROWS_PER_SECOND * speed * drop.factor * dt;

			const headRow = Math.floor(drop.y);
			const x = this.offsetX + i * this.cellW + this.cellW / 2;

			for (let t = 0; t < MATRIX_TRAIL_LENGTH; t++) {
				const row = headRow - t;
				if (row < 0 || row >= this.rows) continue;

				const idx = i * this.rows + row;
				if (Math.random() < mutateChance) this.glyphs[idx] = randomMatrixChar();

				ctx.globalAlpha = 1 - t / MATRIX_TRAIL_LENGTH;
				ctx.fillStyle = t === 0 ? MATRIX_HEAD_COLOR : MATRIX_TAIL_COLOR;
				ctx.fillText(this.glyphs[idx], x, row * this.cellH + this.cellH / 2);
			}

			if (drop.y - MATRIX_TRAIL_LENGTH > this.rows) {
				drop.y = -Math.random() * Math.max(this.rows, 6) * 1.2;
				drop.factor = 0.5 + Math.random();
			}
		}

		ctx.globalAlpha = 1;
	}

	applyDensity() {}
	applyColorFromText() {}

	toggle() {
		this.revealed ? this.hide() : this.show();
	}

	show() {
		this.revealed = true;
		this.el.classList.add("tg-matrix-spoiler-revealed");
		this.stop();
	}

	hide() {
		this.revealed = false;
		this.el.classList.remove("tg-matrix-spoiler-revealed");
		this.resetRain();
		this.start();
	}

	destroy() {
		this.destroyed = true;
		this.stop();
		if (this.resizeObserver) this.resizeObserver.disconnect();
		if (this.intersectionObserver) this.intersectionObserver.disconnect();
		this.registry.remove(this);
	}
}

function createSpoilerInstance(content, settings, registry) {
	if (settings.spoilerStyle === "block") {
		return new BlockSpoilerInstance(content, settings, registry);
	} else if (settings.spoilerStyle === "blur") {
		return new BlurSpoilerInstance(content, settings, registry);
	} else if (settings.spoilerStyle === "scramble") {
		return new ScrambleSpoilerInstance(content, settings, registry);
	} else if (settings.spoilerStyle === "matrix") {
		return new MatrixSpoilerInstance(content, settings, registry);
	}
	return new SpoilerInstance(content, settings, registry);
}

function collectLineRuns(rootEl) {
	const lines = [];
	let currentLine = [];
	let currentOffset = 0;

	const flushLine = () => {
		if (currentLine.length > 0) {
			lines.push(currentLine);
			currentLine = [];
			currentOffset = 0;
		}
	};

	const walk = (node, inCode) => {
		if (node.nodeType === Node.TEXT_NODE) {
			const val = node.nodeValue || "";
			if (val.length > 0) {
				currentLine.push({
					node,
					start: currentOffset,
					end: currentOffset + val.length,
					isCode: inCode
				});
				currentOffset += val.length;
			}
			return;
		}

		if (node.nodeType !== Node.ELEMENT_NODE) return;

		const tag = node.tagName.toUpperCase();
		if (SKIP_TAGS.has(tag)) return;
		if (node.matches && node.matches(SPOILER_SELECTOR)) return;

		if (tag === "BR") {
			flushLine();
			return;
		}

		const isBlock = BLOCK_TAGS.has(tag);
		if (isBlock) flushLine();

		const nextInCode = inCode || tag === "CODE";
		for (let child = node.firstChild; child; child = child.nextSibling) {
			walk(child, nextInCode);
		}

		if (isBlock) flushLine();
	};

	walk(rootEl, false);
	flushLine();
	return lines;
}

function resolveDomPosition(segments, offset, preferEnd) {
	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i];
		if (preferEnd) {
			if (offset >= seg.start && offset <= seg.end) {
				return { node: seg.node, offset: offset - seg.start };
			}
		} else {
			if (offset >= seg.start && offset < seg.end) {
				return { node: seg.node, offset: offset - seg.start };
			}
		}
	}
	const last = segments[segments.length - 1];
	return { node: last.node, offset: last.end - last.start };
}

function cleanupEmptyLeadingInlineAncestor(range, startNode, endNode, rootEl) {
	let curr = startNode.nodeType === Node.TEXT_NODE ? startNode.parentElement : startNode;
	let topEmpty = null;
	while (curr && curr !== rootEl && !BLOCK_TAGS.has(curr.tagName.toUpperCase())) {
		if (curr.contains(endNode)) break;
		if ((curr.textContent || "").length === 0) {
			topEmpty = curr;
			curr = curr.parentElement;
		} else {
			break;
		}
	}
	if (topEmpty && topEmpty.parentNode) {
		range.setStartBefore(topEmpty);
		range.collapse(true);
		topEmpty.remove();
	}
}

function renderMarkdownSpoilers(el, settings, registry) {
	const marker = settings.customMarker;
	if (!marker || marker.length < 2) return;
	const regex = getSpoilerRegex(marker);
	const lines = collectLineRuns(el);

	for (const segments of lines) {
		let searchText = "";
		for (const seg of segments) {
			const len = seg.end - seg.start;
			if (seg.isCode) {
				searchText += "\uFFFC".repeat(len);
			} else {
				searchText += (seg.node.nodeValue || "").replace(/[\r\n]/g, " ");
			}
		}

		if (!searchText.includes(marker)) continue;

		regex.lastIndex = 0;
		const matches = [];
		let match;
		while ((match = regex.exec(searchText)) !== null) {
			matches.push({
				matchStart: match.index,
				matchEnd: match.index + match[0].length,
				contentStart: match.index + marker.length,
				contentEnd: match.index + match[0].length - marker.length
			});
		}

		if (matches.length === 0) continue;

		for (let i = matches.length - 1; i >= 0; i--) {
			const m = matches[i];
			const startPos = resolveDomPosition(segments, m.matchStart, false);
			const contentStartPos = resolveDomPosition(segments, m.contentStart, true);
			const contentEndPos = resolveDomPosition(segments, m.contentEnd, false);
			const endPos = resolveDomPosition(segments, m.matchEnd, true);

			const innerRange = document.createRange();
			innerRange.setStart(contentStartPos.node, contentStartPos.offset);
			innerRange.setEnd(contentEndPos.node, contentEndPos.offset);
			const contentFragment = innerRange.cloneContents();

			const fullRange = document.createRange();
			fullRange.setStart(startPos.node, startPos.offset);
			fullRange.setEnd(endPos.node, endPos.offset);
			fullRange.deleteContents();

			cleanupEmptyLeadingInlineAncestor(fullRange, startPos.node, endPos.node, el);

			const spoiler = createSpoilerInstance(contentFragment, settings, registry);
			fullRange.insertNode(spoiler.el);
		}
	}
}

class SpoilerWidget extends WidgetType {
	constructor(text, settings, registry) {
		super();
		this.text = text;
		this.settings = settings;
		this.registry = registry;
		this.style = settings.spoilerStyle;
		this.staticMode = settings.scrambleStaticMode;
		this.instance = null;
	}

	eq(other) {
		return (
			other.text === this.text &&
			other.style === this.style &&
			other.staticMode === this.staticMode
		);
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

const RELEASE_NOTES = [
	{
		version: "1.7.1",
		date: "2026-10-14",
		showOnUpdate: true,
		new: [
			"**Static Scramble mode**: an option to keep scrambled characters static, with a `⟳` button in the plugin settings to randomly reshuffle characters on demand.",
			"**New settings & About section**: added `Matrix speed` and `Scramble speed` sliders, `Use accent color` theme toggles"
		],
		changed: [
			"Lowered the minimum `Scramble speed` limit from `0.2` to `0.1` to match `Matrix speed`.",
			"**Spoiler styling & bleed-through effect**: restored the original visual behavior for nested elements inside spoilers to match previous versions.",
			"Reduced base line-height of the Matrix block (`line-height: 1.2`) in CSS for a compact and clean inline appearance."
		],
		fixed: [
			"**Full-line spoilers with nested syntax**: fixed an issue where spoilers wrapping an entire line or containing nested formatting (bold, italic, highlights, strikethrough, links, or inline code) failed to hide the text in Reading mode and Live Preview.",
			"**CSS & theme compatibility**: removed `!important` overrides in `styles.css` to follow Obsidian guidelines and prevent style conflicts with custom themes and snippets."
		]
	}
];

const WHATS_NEW_CATEGORIES = [
	{ key: "new", label: "New" },
	{ key: "improved", label: "Improved" },
	{ key: "changed", label: "Changed" },
	{ key: "fixed", label: "Fixed" },
	{ key: "upcoming", label: "Upcoming" }
];

function compareVersions(a, b) {
	const x = String(a).split(".").map(Number);
	const y = String(b).split(".").map(Number);
	for (let i = 0; i < Math.max(x.length, y.length); i++) {
		const p = x[i] || 0, q = y[i] || 0;
		if (p > q) return 1;
		if (p < q) return -1;
	}
	return 0;
}

function getLatestReleaseNotes(count = 5) {
	return RELEASE_NOTES.slice(0, count);
}

function getReleaseNotesSince(lastSeen, current) {
	if (!lastSeen) return getLatestReleaseNotes(1);
	return RELEASE_NOTES.filter(n =>
		compareVersions(n.version, lastSeen) > 0 && compareVersions(n.version, current) <= 0
	);
}

class WhatsNewModal extends Modal {
	constructor(app, releaseNotes, onCloseCallback) {
		super(app);
		this.releaseNotes = releaseNotes;
		this.onCloseCallback = onCloseCallback;
		this.doneButton = null;
		this.disposers = [];
	}

	listen(el, type, handler) {
		el.addEventListener(type, handler);
		this.disposers.push(() => el.removeEventListener(type, handler));
	}

	normalizeTextBreaks(text) {
		return text.replace(/\r\n?/g, "\n").replace(/<br\s*\/?>/gi, "\n");
	}

	renderFormattedText(parent, text) {
		const append = (str, target) => {
			const re = /<img\s+[^>]*src=["']([^"']+)["'][^>]*\/?>|!\[([^\]]*)\]\(([^\s)]+)\)|==([\s\S]*?)==|\[([^\]]+)\]\(([^\s)]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|(https?:\/\/[^\s]+)/gi;
			let last = 0, m;
			const plain = s => { if (s.length > 0) target.appendText(s); };
			while ((m = re.exec(str)) !== null) {
				plain(str.slice(last, m.index));
				if (m[1] && isSafeUrl(m[1])) {
					const img = target.createEl("img", { cls: "tg-whats-new-image" });
					img.setAttr("src", m[1]);
					img.setAttr("loading", "lazy");
				} else if (m[2] !== undefined && m[3] && isSafeUrl(m[3])) {
					const img = target.createEl("img", { cls: "tg-whats-new-image" });
					img.setAttr("src", m[3]);
					if (m[2]) img.setAttr("alt", m[2]);
					img.setAttr("loading", "lazy");
				} else if (m[4]) {
					const span = target.createSpan({ cls: "tg-highlight" });
					append(m[4], span);
				} else if (m[5] && m[6] && isSafeUrl(m[6])) {
					const a = target.createEl("a", { text: m[5] });
					a.setAttr("href", m[6]);
					a.setAttr("rel", "noopener noreferrer");
					a.setAttr("target", "_blank");
				} else if (m[5] && m[6]) {
					plain(m[0]);
				} else if (m[7]) {
					target.createEl("code", { text: m[7] });
				} else if (m[8]) {
					target.createEl("strong", { text: m[8] });
				} else if (m[9]) {
					let url = m[9], tail = "";
					const t = url.match(/[.,;:!?)]+$/);
					if (t) { tail = t[0]; url = url.slice(0, -tail.length); }
					const a = target.createEl("a", { text: url });
					a.setAttr("href", url);
					a.setAttr("rel", "noopener noreferrer");
					a.setAttr("target", "_blank");
					plain(tail);
				}
				last = re.lastIndex;
			}
			plain(str.slice(last));
		};
		const lines = this.normalizeTextBreaks(text).split("\n");
		lines.forEach((line, i) => {
			append(line, parent);
			if (i < lines.length - 1) parent.createEl("br");
		});
	}

	renderInfoText(parent, text) {
		const t = this.normalizeTextBreaks(text).trim();
		if (!t) return;
		t.split(/\n[ \t]*\n+/).map(s => s.trim()).filter(Boolean).forEach(par => {
			const p = parent.createEl("p", { cls: "tg-whats-new-info" });
			this.renderFormattedText(p, par);
		});
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		this.modalEl.addClass("tg-whats-new-modal");
		this.titleEl.setText("Particle Spoilers — What's new");
		this.attachCloseButtonHandler();

		const scroll = contentEl.createDiv("tg-whats-new-scroll");
		this.releaseNotes.forEach(note => {
			const box = scroll.createDiv("tg-whats-new-version");
			const header = note.date ? `Version ${note.version} (${note.date})` : `Version ${note.version}`;
			box.createEl("h3", { text: header });
			if (note.info) this.renderInfoText(box, note.info);
			WHATS_NEW_CATEGORIES.forEach(cat => {
				const items = note[cat.key];
				if (!items || items.length === 0) return;
				box.createEl("h4", { text: cat.label, cls: `tg-whats-new-category tg-whats-new-category--${cat.key}` });
				const ul = box.createEl("ul", { cls: "tg-whats-new-features" });
				items.forEach(item => this.renderFormattedText(ul.createEl("li"), item));
			});
		});

		contentEl.createDiv("tg-whats-new-divider");
		const buttons = contentEl.createDiv("tg-whats-new-buttons");
		const done = buttons.createEl("button", { text: "Got it", cls: "mod-cta" });
		this.listen(done, "click", () => this.close());
		this.doneButton = done;
	}

	open() {
		super.open();
		if (this.doneButton && !Platform.isMobile) {
			window.requestAnimationFrame(() => this.doneButton && this.doneButton.focus());
		}
	}

	onClose() {
		this.contentEl.empty();
		this.modalEl.removeClass("tg-whats-new-modal");
		this.disposers.forEach(d => { try { d(); } catch (e) { console.error("Error disposing What's new listener:", e); } });
		this.disposers = [];
		if (this.onCloseCallback) this.onCloseCallback();
	}

	attachCloseButtonHandler() {
		const btn = this.modalEl.querySelector(".modal-close-button");
		if (!btn) return;
		const handler = e => { e.preventDefault(); this.close(); };
		this.listen(btn, "click", handler);
		this.listen(btn, "pointerdown", handler);
	}
}

class ParticleSpoilerPlugin extends Plugin {
	constructor() {
		super(...arguments);
		this.registry = new SpoilerRegistry();
		this.editorViews = new Set();
	}

	async onload() {
		await this.loadSettings();
		this.applyBlurHoverClass();

		this.registerMarkdownPostProcessor((el) => {
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
			id: "show-whats-new",
			name: "Show what's new",
			callback: () => this.showWhatsNew(getLatestReleaseNotes())
		});

		this.app.workspace.onLayoutReady(() => this.maybeShowWhatsNew());

		this.addCommand({
			id: "insert-spoiler",
			name: "Insert spoiler",
			editorCallback: (editor) => this.insertSpoilerAtSelection(editor)
		});

		this.themeObserver = new MutationObserver((mutations) => {
			let shouldRefresh = false;
			for (let mutation of mutations) {
				if (mutation.type === "attributes" && (mutation.attributeName === "style" || mutation.attributeName === "class")) {
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
			attributeFilter: ["style", "class"]
		});
	}

	onunload() {
		if (this.themeObserver) {
			this.themeObserver.disconnect();
		}
		document.body.removeClass("obsidian-blur-hover");
		this.registry.destroyAll();
	}

	showWhatsNew(notes, onClose) {
		if (!notes || notes.length === 0) return;
		new WhatsNewModal(this.app, notes, onClose).open();
	}

	maybeShowWhatsNew() {
		const current = this.manifest.version;
		if (this.settings.lastSeenVersion === current) return;
		const markSeen = async () => {
			this.settings.lastSeenVersion = current;
			await this.saveSettings();
		};
		if (!this.settings.showWhatsNewOnUpdate) { markSeen(); return; }
		const notes = getReleaseNotesSince(this.settings.lastSeenVersion, current)
			.filter(n => n.showOnUpdate !== false);
		if (notes.length === 0) { markSeen(); return; }
		this.showWhatsNew(notes, markSeen);
	}

	applyBlurHoverClass() {
		const body = document.body;
		if (this.settings.blurRevealOnHover) {
			body.addClass("obsidian-blur-hover");
		} else {
			body.removeClass("obsidian-blur-hover");
		}
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

function createSettingGroupContainer(containerEl, heading) {
	if (typeof SettingGroup === "function") {
		const groupEl = containerEl.createDiv({ cls: "setting-group" });
		const group = new SettingGroup(groupEl);
		if (heading) group.setHeading(heading);
		return {
			addSetting: (cb) => {
				let s = null;
				group.addSetting((setting) => {
					s = setting;
					cb(setting);
				});
				return s;
			}
		};
	}
	if (heading) {
		new Setting(containerEl).setName(heading).setHeading();
	}
	return {
		addSetting: (cb) => {
			const setting = new Setting(containerEl);
			cb(setting);
			return setting;
		}
	};
}

function renderOtherPluginCards(setting) {
	setting.settingEl.addClass("tg-plugin-cards");
	const listEl = setting.settingEl.createDiv({ cls: "tg-plugin-card-list" });
	const plugins = [
		{
			name: "Embed File Menu",
			icon: "lucide-file-symlink",
			description: "Context menu actions for embedded files and notes",
			url: OTHER_PLUGIN_URL
		}
	];
	for (const item of plugins) {
		const cardEl = listEl.createEl("button", {
			cls: "tg-plugin-card",
			attr: { type: "button" }
		});
		setIcon(cardEl.createDiv({ cls: "tg-plugin-card-icon" }), item.icon);
		const detailsEl = cardEl.createDiv({ cls: "tg-plugin-card-details" });
		detailsEl.createDiv({ cls: "tg-plugin-card-name", text: item.name });
		detailsEl.createDiv({ cls: "tg-plugin-card-description", text: item.description });
		setIcon(cardEl.createDiv({ cls: "tg-plugin-card-arrow" }), "lucide-chevron-right");
		cardEl.addEventListener("click", () => {
			window.open(item.url);
		});
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
			.setDesc("Particle: animated dust like Telegram. Block: a solid color rectangle like Discord/Steam. Blur: a soft blur filter over the text. Scramble: shuffled letters in random orientations. Matrix: digital rain over the text.")
			.addDropdown(dropdown => dropdown
				.addOption("particle", "Particle")
				.addOption("block", "Block (Discord/Steam-style)")
				.addOption("blur", "Blur")
				.addOption("scramble", "Scramble")
				.addOption("matrix", "Matrix")
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

		if (this.plugin.settings.spoilerStyle === "blur") {
			new Setting(containerEl)
				.setName("Blur amount")
				.setDesc("How strong the blur effect is, in pixels.")
				.addSlider(slider => slider
					.setLimits(1, 15, 1)
					.setValue(this.plugin.settings.blurAmount)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.blurAmount = value;
						await this.plugin.saveSettings();
						this.plugin.registry.refreshDensity();
					})
				);
		}

		if (this.plugin.settings.spoilerStyle === "scramble") {
			const staticScrambleSetting = new Setting(containerEl)
				.setName("Static scramble mode")
				.setDesc("Make the Scramble effect static, with the ability to randomly reshuffle characters on demand using a ⟳ button.");

			if (this.plugin.settings.scrambleStaticMode) {
				staticScrambleSetting.addButton(btn => {
					btn
						.setButtonText("⟳")
						.setTooltip("Reshuffle characters")
						.onClick(() => {
							this.plugin.registry.reshuffleScramble();
						});
					btn.buttonEl.addClass("tg-scramble-reshuffle-setting-btn");
				});
			}

			staticScrambleSetting.addToggle(toggle => toggle
				.setValue(this.plugin.settings.scrambleStaticMode)
				.onChange(async (value) => {
					this.plugin.settings.scrambleStaticMode = value;
					await this.plugin.saveSettings();
					this.plugin.registry.updateScrambleMode();
					this.plugin.refreshEditors();
					this.plugin.refreshReadingViews();
					this.display();
				})
			);

			if (!this.plugin.settings.scrambleStaticMode) {
				new Setting(containerEl)
					.setName("Scramble speed")
					.setDesc("How fast the letters are shuffled.")
					.addSlider(slider => slider
						.setLimits(0.1, 3, 0.1)
						.setValue(this.plugin.settings.scrambleSpeed)
						.setDynamicTooltip()
						.onChange(async (value) => {
							this.plugin.settings.scrambleSpeed = value;
							await this.plugin.saveSettings();
						})
					);
			}

			new Setting(containerEl)
				.setName("Use accent color")
				.setDesc("If enabled, the scrambled letters will use the theme's accent color. Otherwise, the hidden text's color is used.")
				.addToggle(toggle => toggle
					.setValue(this.plugin.settings.scrambleUseAccentColor)
					.onChange(async (value) => {
						this.plugin.settings.scrambleUseAccentColor = value;
						await this.plugin.saveSettings();
						this.plugin.registry.refreshColors();
						this.plugin.refreshEditors();
					})
				);
		}

		if (this.plugin.settings.spoilerStyle === "matrix") {
			new Setting(containerEl)
				.setName("Matrix speed")
				.setDesc("How fast the digital rain falls.")
				.addSlider(slider => slider
					.setLimits(0.1, 3, 0.1)
					.setValue(this.plugin.settings.matrixSpeed)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.matrixSpeed = value;
						await this.plugin.saveSettings();
					})
				);
		}

		if (["blur", "scramble", "matrix"].includes(this.plugin.settings.spoilerStyle)) {
			new Setting(containerEl)
				.setName("Reveal on hover")
				.setDesc("If enabled, hovering the mouse over a spoiler reveals it without clicking. Clicking while hovering keeps it revealed.")
				.addToggle(toggle => toggle
					.setValue(this.plugin.settings.blurRevealOnHover)
					.onChange(async (value) => {
						this.plugin.settings.blurRevealOnHover = value;
						await this.plugin.saveSettings();
						this.plugin.applyBlurHoverClass();
					})
				);
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

		const version = this.plugin.manifest.version;
		const aboutGroup = createSettingGroupContainer(containerEl, "About");

		aboutGroup.addSetting(setting => {
			setting
				.setName(`What's new in Particle Spoilers ${version}`)
				.setDesc("See recent updates and improvements")
				.addButton(btn => btn
					.setButtonText("View recent updates")
					.onClick(() => this.plugin.showWhatsNew(getLatestReleaseNotes()))
				);
		});

		aboutGroup.addSetting(setting => {
			setting
				.setName("Show release notes after updating")
				.setDesc("Disable to stop the What's new dialog from opening automatically after updates.")
				.addToggle(toggle => toggle
					.setValue(this.plugin.settings.showWhatsNewOnUpdate)
					.onChange(async (value) => {
						this.plugin.settings.showWhatsNewOnUpdate = value;
						await this.plugin.saveSettings();
					})
				);
		});

		aboutGroup.addSetting(setting => {
			setting.setName("Check out my other plugins");
			renderOtherPluginCards(setting);
		});
	}
}

module.exports = ParticleSpoilerPlugin;
