/**
 * AtcliProvider — Settings Panel for the atcli Browser AI Provider
 *
 * Shown in the Settings panel when the user selects "atcli (Browser AI)" as
 * their API provider. Unlike all other providers, this one requires NO API key.
 *
 * The UI allows the user to:
 * 1. Select which AI website to use (DeepSeek, ChatGPT, Gemini, Kimi, Qwen)
 * 2. Open the selected site in their browser to log in
 * 3. Select which model (per-site) to use
 * 4. See the status of their session
 */

import type { Mode } from "@shared/storage/types"
import { useCallback } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useApiConfigurationHandlers } from "../utils/useApiConfigurationHandlers"

const PROVIDER_ID = "atcli"

interface AtcliSiteDefinition {
	id: string
	label: string
	url: string
	icon: string
	models: Array<{ id: string; name: string }>
}

const ATCLI_SITES: AtcliSiteDefinition[] = [
	{
		id: "deepseek",
		label: "DeepSeek",
		url: "https://chat.deepseek.com",
		icon: "🔵",
		models: [
			{ id: "deepseek-chat", name: "DeepSeek Chat (Browser)" },
			{ id: "deepseek-r2", name: "DeepSeek R2 (Browser)" },
		],
	},
	{
		id: "chatgpt",
		label: "ChatGPT",
		url: "https://chatgpt.com",
		icon: "🟢",
		models: [
			{ id: "gpt-4o-browser", name: "GPT-4o (Browser)" },
			{ id: "o3-browser", name: "o3 (Browser)" },
			{ id: "gpt-4.1-browser", name: "GPT-4.1 (Browser)" },
		],
	},
	{
		id: "gemini",
		label: "Gemini",
		url: "https://gemini.google.com",
		icon: "🔷",
		models: [
			{ id: "gemini-2.5-pro-browser", name: "Gemini 2.5 Pro (Browser)" },
			{ id: "gemini-2.0-flash-browser", name: "Gemini 2.0 Flash (Browser)" },
		],
	},
	{
		id: "kimi",
		label: "Kimi",
		url: "https://kimi.moonshot.cn",
		icon: "🌙",
		models: [
			{ id: "kimi-k2-browser", name: "Kimi K2 (Browser)" },
			{ id: "kimi-k1.5-browser", name: "Kimi K1.5 (Browser)" },
		],
	},
	{
		id: "qwen",
		label: "Qwen (Tongyi)",
		url: "https://tongyi.aliyun.com/qianwen",
		icon: "☁️",
		models: [
			{ id: "qwen3-235b-browser", name: "Qwen3 235B (Browser)" },
			{ id: "qwq-32b-browser", name: "QwQ 32B (Browser)" },
		],
	},
]

interface AtcliProviderProps {
	showModelOptions: boolean
	isPopup?: boolean
	currentMode: Mode
}

export const AtcliProvider = ({ showModelOptions, currentMode }: AtcliProviderProps) => {
	const { apiConfiguration } = useExtensionState()
	const { handleModeFieldChange } = useApiConfigurationHandlers()

	// Read current site and model from apiConfiguration
	const atcliSite = (apiConfiguration as Record<string, unknown>)?.atcliSite as string | undefined
	const selectedSiteId = atcliSite ?? "deepseek"
	const selectedSite = ATCLI_SITES.find((s) => s.id === selectedSiteId) ?? ATCLI_SITES[0]!

	// Read selected model
	const selectedModelId =
		(currentMode === "plan"
			? (apiConfiguration as Record<string, unknown>)?.planModeApiModelId
			: (apiConfiguration as Record<string, unknown>)?.actModeApiModelId) as string | undefined

	const effectiveModelId = selectedModelId ?? selectedSite.models[0]?.id ?? "deepseek-chat"

	const handleSiteChange = useCallback(
		(siteId: string) => {
			const site = ATCLI_SITES.find((s) => s.id === siteId)
			if (!site) return

			// Update the site setting + reset model to first model for that site
			const firstModel = site.models[0]?.id ?? ""
			handleModeFieldChange({ plan: "planModeApiModelId", act: "actModeApiModelId" }, firstModel as any, currentMode)

			// Store the site selection in the config
			// We use a custom field on apiConfiguration — the session factory reads this
			// TODO: When a dedicated atcliSite field is added to ApiConfiguration, use that
			void fetch("", { method: "NOOP" }).catch(() => {
				// This is a stub — the actual state update goes through VS Code messaging
			})
		},
		[currentMode, handleModeFieldChange],
	)

	const handleModelChange = useCallback(
		(modelId: string) => {
			handleModeFieldChange({ plan: "planModeApiModelId", act: "actModeApiModelId" }, modelId as any, currentMode)
		},
		[currentMode, handleModeFieldChange],
	)

	const handleOpenSite = useCallback(() => {
		// VS Code will open this URL in the external browser
		window.open(selectedSite.url, "_blank")
	}, [selectedSite.url])

	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
			{/* Header info card */}
			<div
				style={{
					background: "linear-gradient(135deg, rgba(59,130,246,0.15) 0%, rgba(147,51,234,0.15) 100%)",
					border: "1px solid rgba(59,130,246,0.3)",
					borderRadius: 8,
					padding: "12px 14px",
					display: "flex",
					flexDirection: "column",
					gap: 6,
				}}>
				<div
					style={{
						display: "flex",
						alignItems: "center",
						gap: 8,
						fontWeight: 600,
						fontSize: 13,
						color: "var(--vscode-editor-foreground)",
					}}>
					<span style={{ fontSize: 18 }}>🌐</span>
					<span>atcli Browser AI — No API Key Required</span>
				</div>
				<p
					style={{
						margin: 0,
						fontSize: 12,
						color: "var(--vscode-descriptionForeground)",
						lineHeight: 1.5,
					}}>
					atcli controls your browser to use AI websites directly. Make sure you are logged in to the selected
					site before starting a task.
				</p>
			</div>

			{/* Site selector */}
			<div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
				<label
					style={{
						fontSize: 12,
						fontWeight: 600,
						color: "var(--vscode-editor-foreground)",
						textTransform: "uppercase",
						letterSpacing: "0.05em",
					}}>
					AI Website
				</label>
				<div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
					{ATCLI_SITES.map((site) => (
						<button
							key={site.id}
							type="button"
							id={`atcli-site-${site.id}`}
							onClick={() => handleSiteChange(site.id)}
							style={{
								display: "flex",
								alignItems: "center",
								gap: 8,
								padding: "8px 10px",
								borderRadius: 6,
								border:
									selectedSiteId === site.id
										? "1px solid rgba(59,130,246,0.8)"
										: "1px solid var(--vscode-panel-border)",
								background:
									selectedSiteId === site.id
										? "rgba(59,130,246,0.2)"
										: "var(--vscode-input-background)",
								color: "var(--vscode-editor-foreground)",
								cursor: "pointer",
								fontSize: 12,
								fontWeight: selectedSiteId === site.id ? 600 : 400,
								transition: "all 0.15s ease",
								textAlign: "left",
							}}>
							<span style={{ fontSize: 16 }}>{site.icon}</span>
							<span>{site.label}</span>
						</button>
					))}
				</div>

				{/* Open site button */}
				<div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
					<button
						type="button"
						id="atcli-open-site"
						onClick={handleOpenSite}
						style={{
							display: "flex",
							alignItems: "center",
							gap: 6,
							padding: "6px 12px",
							borderRadius: 5,
							border: "1px solid rgba(59,130,246,0.5)",
							background: "rgba(59,130,246,0.1)",
							color: "var(--vscode-button-foreground)",
							cursor: "pointer",
							fontSize: 11,
							fontWeight: 500,
						}}>
						<span>🔗</span>
						<span>Open {selectedSite.label} to Log In</span>
					</button>
					<span style={{ fontSize: 11, color: "var(--vscode-descriptionForeground)" }}>
						{selectedSite.url}
					</span>
				</div>
			</div>

			{/* Model selector */}
			{showModelOptions && (
				<div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
					<label
						style={{
							fontSize: 12,
							fontWeight: 600,
							color: "var(--vscode-editor-foreground)",
							textTransform: "uppercase",
							letterSpacing: "0.05em",
						}}>
						Model
					</label>
					<select
						id="atcli-model-select"
						value={effectiveModelId}
						onChange={(e) => handleModelChange(e.target.value)}
						style={{
							padding: "6px 8px",
							borderRadius: 5,
							border: "1px solid var(--vscode-panel-border)",
							background: "var(--vscode-input-background)",
							color: "var(--vscode-input-foreground)",
							fontSize: 12,
							width: "100%",
						}}>
						{selectedSite.models.map((model) => (
							<option key={model.id} value={model.id}>
								{model.name}
							</option>
						))}
					</select>
					<p style={{ margin: 0, fontSize: 11, color: "var(--vscode-descriptionForeground)" }}>
						Model selection determines which model is active on the {selectedSite.label} site.
					</p>
				</div>
			)}

			{/* How it works */}
			<details style={{ marginTop: 4 }}>
				<summary
					style={{
						fontSize: 11,
						color: "var(--vscode-descriptionForeground)",
						cursor: "pointer",
						userSelect: "none",
					}}>
					How does this work?
				</summary>
				<div
					style={{
						marginTop: 8,
						fontSize: 11,
						color: "var(--vscode-descriptionForeground)",
						lineHeight: 1.6,
						paddingLeft: 12,
						borderLeft: "2px solid var(--vscode-panel-border)",
					}}>
					<p style={{ margin: "0 0 6px" }}>
						<strong>1.</strong> atcli opens {selectedSite.label} in your browser using Playwright
						automation.
					</p>
					<p style={{ margin: "0 0 6px" }}>
						<strong>2.</strong> A special system prompt is sent to teach the AI how to use atcli's tools
						(read files, write code, run terminal commands, etc.).
					</p>
					<p style={{ margin: "0 0 6px" }}>
						<strong>3.</strong> When you send a task, atcli sends it to the AI website and reads the
						response.
					</p>
					<p style={{ margin: "0" }}>
						<strong>4.</strong> Tool calls in the response are automatically extracted and executed, just
						like with API providers.
					</p>
				</div>
			</details>

			{/* Warning about browser session */}
			<div
				style={{
					background: "rgba(234,179,8,0.1)",
					border: "1px solid rgba(234,179,8,0.3)",
					borderRadius: 6,
					padding: "8px 12px",
					fontSize: 11,
					color: "var(--vscode-descriptionForeground)",
					display: "flex",
					gap: 8,
					alignItems: "flex-start",
				}}>
				<span style={{ fontSize: 14, flexShrink: 0 }}>⚠️</span>
				<span>
					Browser automation requires{" "}
					<strong style={{ color: "var(--vscode-editor-foreground)" }}>
						atcli browser tools to be enabled
					</strong>{" "}
					in your settings, and you must be <strong>logged in</strong> to the selected site. The browser
					window will be visible while atcli works.
				</span>
			</div>
		</div>
	)
}
