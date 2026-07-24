/**
 * atcli Browser Bridge — VS Code Extension Host
 *
 * Connects the AtcliBrowserProvider (in the @cline/llms SDK package) to atcli's
 * existing Playwright browser automation infrastructure in the VS Code extension.
 *
 * The bridge implements the BrowserSessionBridge interface so the SDK provider
 * can control the browser without depending on VS Code APIs directly.
 *
 * Lifecycle:
 *   - Created once per extension activation
 *   - Shared across sessions (same browser instance)
 *   - Disposed when the extension deactivates
 */

import { Logger } from "@/shared/services/Logger";

// ---------------------------------------------------------------------------
// BrowserSessionBridge — local copy of the interface from @cline/llms
// We define it here rather than importing to avoid a build-order dependency
// on the SDK dist. TypeScript structural typing ensures compatibility.
// ---------------------------------------------------------------------------

/**
 * Minimal browser control surface that the AtcliBrowserProvider needs.
 * MUST be kept in sync with BrowserSessionBridge in:
 * sdk/packages/llms/src/providers/vendors/atcli-browser.ts
 */
export interface BrowserSessionBridge {
	goto(url: string): Promise<void>;
	type(selector: string, text: string): Promise<void>;
	click(selector: string): Promise<void>;
	press(selector: string, key: string): Promise<void>;
	waitForSelector(selector: string, timeoutMs?: number): Promise<boolean>;
	evaluate<T, A extends unknown[] = []>(
		fn: (...args: A) => T,
		...args: A
	): Promise<T>;
	pollText(
		getTextFn: () => string,
		onDelta: (delta: string) => void,
		signal: AbortSignal,
	): Promise<string>;
	isAtUrl(urlPattern: string): Promise<boolean>;
	screenshot?(): Promise<string>;
}

// ---------------------------------------------------------------------------
// Types for the existing browser tool in atcli
// ---------------------------------------------------------------------------

/**
 * Minimal interface from atcli's existing browser session.
 * We use duck-typing here to avoid tight coupling to internal browser APIs.
 */
interface AtcliBrowserPage {
	goto(url: string, options?: { waitUntil?: string }): Promise<void>;
	type(
		selector: string,
		text: string,
		options?: { delay?: number },
	): Promise<void>;
	click(selector: string): Promise<void>;
	keyboard: {
		press(key: string): Promise<void>;
	};
	waitForSelector(
		selector: string,
		options?: { timeout?: number },
	): Promise<{ isVisible: () => Promise<boolean> } | null>;
	evaluate<T>(fn: () => T): Promise<T>;
	url(): string;
}

interface AtcliBrowserSession {
	getActivePage(): AtcliBrowserPage | null;
	launchBrowser(): Promise<AtcliBrowserPage>;
	closeBrowser(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Bridge implementation
// ---------------------------------------------------------------------------

export class AtcliBrowserBridge implements BrowserSessionBridge {
	private session: AtcliBrowserSession | null = null;
	private page: AtcliBrowserPage | null = null;

	constructor(private readonly getBrowserSession: () => AtcliBrowserSession | null) {}

	/**
	 * Ensure we have an active browser page.
	 */
	private async ensurePage(): Promise<AtcliBrowserPage> {
		if (this.page) {
			return this.page;
		}

		this.session = this.getBrowserSession();
		if (this.session) {
			const existing = this.session.getActivePage();
			if (existing) {
				this.page = existing;
				return this.page;
			}
			this.page = await this.session.launchBrowser();
			return this.page;
		}

		throw new Error(
			"atcli browser: No browser session available. " +
				"Please ensure the browser tool is enabled in your atcli settings.",
		);
	}

	async goto(url: string): Promise<void> {
		try {
			const page = await this.ensurePage();
			await page.goto(url, { waitUntil: "domcontentloaded" });
			// Wait a moment for the page to settle
			await new Promise((r) => setTimeout(r, 800));
		} catch (err) {
			Logger.error("[AtcliBrowserBridge] goto failed:", err);
			throw err;
		}
	}

	async type(selector: string, text: string): Promise<void> {
		const page = await this.ensurePage();
		await page.click(selector);
		// biome-ignore lint/suspicious/noExplicitAny: Puppeteer evaluate duck typing
		await (page as any).evaluate(
			(sel: string, txt: string) => {
				const doc = (globalThis as unknown as { document: Document }).document;
				const el = doc.querySelector(sel) as HTMLTextAreaElement | HTMLInputElement | null;
				if (el) {
					el.value = txt;
					el.dispatchEvent(new Event("input", { bubbles: true }));
					el.dispatchEvent(new Event("change", { bubbles: true }));
				}
			},
			selector,
			text,
		);
		await page.type(selector, " ", { delay: 0 });
		await page.keyboard.press("Backspace");
	}

	async click(selector: string): Promise<void> {
		const page = await this.ensurePage();
		await page.click(selector);
	}

	async press(selector: string, key: string): Promise<void> {
		const page = await this.ensurePage();
		await page.click(selector);
		await page.keyboard.press(key);
	}

	async waitForSelector(selector: string, timeoutMs = 5000): Promise<boolean> {
		try {
			const page = await this.ensurePage();
			const element = await page.waitForSelector(selector, {
				timeout: timeoutMs,
			});
			return element !== null;
		} catch {
			return false;
		}
	}

	async evaluate<T, A extends unknown[] = []>(
		fn: (...args: A) => T,
		...args: A
	): Promise<T> {
		const page = await this.ensurePage();
		// biome-ignore lint/suspicious/noExplicitAny: Puppeteer evaluate duck typing
		return (page as any).evaluate(fn, ...args);
	}

	async pollText(
		getTextFn: () => string,
		onDelta: (delta: string) => void,
		signal: AbortSignal,
	): Promise<string> {
		const page = await this.ensurePage();
		let prevText = "";
		const pollInterval = 250; // ms

		while (!signal.aborted) {
			const currentText = await page.evaluate(getTextFn);
			if (currentText.length > prevText.length) {
				const delta = currentText.slice(prevText.length);
				onDelta(delta);
				prevText = currentText;
			}
			await new Promise((r) => setTimeout(r, pollInterval));
		}

		return prevText;
	}

	async isAtUrl(urlPattern: string): Promise<boolean> {
		try {
			if (!this.page) return false;
			const page = await this.ensurePage();
			const currentUrl = page.url();
			return currentUrl.startsWith(urlPattern) || currentUrl.includes(new URL(urlPattern).hostname);
		} catch {
			return false;
		}
	}

	/**
	 * Dispose the bridge — does NOT close the browser (shared with other tools).
	 */
	dispose(): void {
		this.page = null;
		this.session = null;
	}
}

// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------

let bridgeInstance: AtcliBrowserBridge | null = null;

/**
 * Get or create the singleton bridge instance.
 * Called from the VS Code extension's session factory to inject the bridge
 * into the atcli provider's GatewayProviderConfig.options.
 */
export function getAtcliBrowserBridge(
	getBrowserSession: () => AtcliBrowserSession | null,
): AtcliBrowserBridge {
	if (!bridgeInstance) {
		bridgeInstance = new AtcliBrowserBridge(getBrowserSession);
		Logger.log("[AtcliBrowserBridge] Created new bridge instance");
	}
	return bridgeInstance;
}

/**
 * Dispose the bridge on extension deactivation.
 */
export function disposeAtcliBrowserBridge(): void {
	bridgeInstance?.dispose();
	bridgeInstance = null;
	Logger.log("[AtcliBrowserBridge] Disposed bridge instance");
}
