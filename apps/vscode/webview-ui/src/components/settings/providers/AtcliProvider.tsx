/**
 * AtcliProvider — Settings Panel for the atcli Smart Router
 *
 * Shown in the Settings panel when the user selects "atcli Smart Router".
 * Allows configuring multiple provider slots with API keys, base URLs, models,
 * priorities, and the routing strategy.
 *
 * Architecture inspired by OmniRoute — built natively in atcli.
 */

import type { Mode } from "@shared/storage/types"
import { useCallback, useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useApiConfigurationHandlers } from "../utils/useApiConfigurationHandlers"

const PROVIDER_ID = "atcli"

export type RouterStrategy = "priority" | "round-robin" | "cost-optimized" | "random"

export interface RouterSlot {
	label: string
	baseUrl: string
	apiKey: string
	modelId: string
	priority?: number
	costPerMToken?: number
}

/** Well-known OpenAI-compatible providers with their base URLs */
const KNOWN_PROVIDERS: Array<{ label: string; baseUrl: string; exampleModel: string }> = [
	{ label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", exampleModel: "deepseek-chat" },
	{ label: "Groq (free tier)", baseUrl: "https://api.groq.com/openai/v1", exampleModel: "llama-3.3-70b-versatile" },
	{ label: "Cerebras (free tier)", baseUrl: "https://api.cerebras.ai/v1", exampleModel: "llama-3.3-70b" },
	{ label: "SambaNova (free tier)", baseUrl: "https://api.sambanova.ai/v1", exampleModel: "Meta-Llama-3.3-70B-Instruct" },
	{ label: "NVIDIA NIM (free tier)", baseUrl: "https://integrate.api.nvidia.com/v1", exampleModel: "meta/llama-3.3-70b-instruct" },
	{ label: "Fireworks AI", baseUrl: "https://api.fireworks.ai/inference/v1", exampleModel: "accounts/fireworks/models/llama-v3p3-70b-instruct" },
	{ label: "OpenAI", baseUrl: "https://api.openai.com/v1", exampleModel: "gpt-4o-mini" },
	{ label: "Mistral", baseUrl: "https://api.mistral.ai/v1", exampleModel: "mistral-small-latest" },
	{ label: "Custom / Local", baseUrl: "http://localhost:11434/v1", exampleModel: "llama3" },
]

const STRATEGY_OPTIONS: Array<{ value: RouterStrategy; label: string; description: string }> = [
	{ value: "priority", label: "Priority", description: "Use highest-priority healthy slot first" },
	{ value: "round-robin", label: "Round-Robin", description: "Cycle through slots evenly" },
	{ value: "cost-optimized", label: "Cost-Optimized", description: "Cheapest healthy slot first" },
	{ value: "random", label: "Random", description: "Random healthy slot each request" },
]

const DEFAULT_SLOT: RouterSlot = {
	label: "Slot 1",
	baseUrl: "https://api.deepseek.com/v1",
	apiKey: "",
	modelId: "deepseek-chat",
	priority: 1,
	costPerMToken: 1.1,
}

interface AtcliProviderProps {
	showModelOptions: boolean
	isPopup?: boolean
	currentMode: Mode
}

const labelStyle: React.CSSProperties = {
	fontSize: 11,
	fontWeight: 600,
	color: "var(--vscode-editor-foreground)",
	textTransform: "uppercase",
	letterSpacing: "0.05em",
	marginBottom: 4,
}

const inputStyle: React.CSSProperties = {
	padding: "5px 8px",
	borderRadius: 4,
	border: "1px solid var(--vscode-panel-border)",
	background: "var(--vscode-input-background)",
	color: "var(--vscode-input-foreground)",
	fontSize: 12,
	width: "100%",
	boxSizing: "border-box",
}

const selectStyle: React.CSSProperties = {
	...inputStyle,
	cursor: "pointer",
}

export const AtcliProvider = ({ showModelOptions, currentMode }: AtcliProviderProps) => {
	const { apiConfiguration } = useExtensionState()
	const { handleModeFieldChange } = useApiConfigurationHandlers()

	const cfg = apiConfiguration as Record<string, unknown>

	// Read current state from apiConfiguration
	const strategy = (cfg?.smartRouterStrategy as RouterStrategy | undefined) ?? "priority"
	const slots = (cfg?.smartRouterSlots as RouterSlot[] | undefined) ?? [{ ...DEFAULT_SLOT }]

	// Local UI state for the slot being edited
	const [expandedSlot, setExpandedSlot] = useState<number | null>(slots.length === 1 ? 0 : null)

	const saveChanges = useCallback(
		(newStrategy: RouterStrategy, newSlots: RouterSlot[]) => {
			// Persist to apiConfiguration via the handler
			// We use planModeApiModelId as the "display" model (router picks at runtime)
			handleModeFieldChange(
				{ plan: "planModeApiModelId", act: "actModeApiModelId" },
				"router/auto" as any,
				currentMode,
			)
			// Store the router settings in the configuration object via a custom handler
			// This is done by posting a message to the extension host
			// The session factory reads cfg.smartRouterStrategy and cfg.smartRouterSlots
			void (window as any).vscode?.postMessage?.({
				type: "updateApiConfiguration",
				values: {
					smartRouterStrategy: newStrategy,
					smartRouterSlots: newSlots,
				},
			})
		},
		[currentMode, handleModeFieldChange],
	)

	const updateStrategy = useCallback(
		(s: RouterStrategy) => {
			saveChanges(s, slots)
		},
		[slots, saveChanges],
	)

	const updateSlot = useCallback(
		(idx: number, patch: Partial<RouterSlot>) => {
			const newSlots = slots.map((slot, i) => (i === idx ? { ...slot, ...patch } : slot))
			saveChanges(strategy, newSlots)
		},
		[slots, strategy, saveChanges],
	)

	const addSlot = useCallback(() => {
		const newSlots = [
			...slots,
			{
				...DEFAULT_SLOT,
				label: `Slot ${slots.length + 1}`,
				priority: slots.length + 1,
			},
		]
		saveChanges(strategy, newSlots)
		setExpandedSlot(newSlots.length - 1)
	}, [slots, strategy, saveChanges])

	const removeSlot = useCallback(
		(idx: number) => {
			const newSlots = slots.filter((_, i) => i !== idx)
			saveChanges(strategy, newSlots.length > 0 ? newSlots : [{ ...DEFAULT_SLOT }])
			setExpandedSlot(null)
		},
		[slots, strategy, saveChanges],
	)

	const applyPreset = useCallback(
		(idx: number, preset: (typeof KNOWN_PROVIDERS)[number]) => {
			updateSlot(idx, {
				baseUrl: preset.baseUrl,
				modelId: preset.exampleModel,
				label: preset.label,
			})
		},
		[updateSlot],
	)

	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
			{/* Header */}
			<div
				style={{
					background: "linear-gradient(135deg, rgba(99,102,241,0.15) 0%, rgba(16,185,129,0.15) 100%)",
					border: "1px solid rgba(99,102,241,0.3)",
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
						fontWeight: 700,
						fontSize: 13,
						color: "var(--vscode-editor-foreground)",
					}}>
					<span style={{ fontSize: 18 }}>⚡</span>
					<span>atcli Smart Router — Multi-Provider AI</span>
				</div>
				<p
					style={{
						margin: 0,
						fontSize: 12,
						color: "var(--vscode-descriptionForeground)",
						lineHeight: 1.5,
					}}>
					Configure multiple AI providers with API keys. atcli automatically routes requests to the best
					available slot with fallback on rate limits or errors. Works with any OpenAI-compatible endpoint.
				</p>
			</div>

			{/* Routing Strategy */}
			<div style={{ display: "flex", flexDirection: "column" }}>
				<label style={labelStyle}>Routing Strategy</label>
				<div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 5 }}>
					{STRATEGY_OPTIONS.map((opt) => (
						<button
							key={opt.value}
							type="button"
							id={`atcli-strategy-${opt.value}`}
							onClick={() => updateStrategy(opt.value)}
							style={{
								display: "flex",
								flexDirection: "column",
								alignItems: "flex-start",
								padding: "7px 10px",
								borderRadius: 6,
								border:
									strategy === opt.value
										? "1px solid rgba(99,102,241,0.7)"
										: "1px solid var(--vscode-panel-border)",
								background:
									strategy === opt.value ? "rgba(99,102,241,0.18)" : "var(--vscode-input-background)",
								color: "var(--vscode-editor-foreground)",
								cursor: "pointer",
								fontSize: 12,
								fontWeight: strategy === opt.value ? 600 : 400,
								transition: "all 0.15s ease",
								textAlign: "left",
								gap: 2,
							}}>
							<span>{opt.label}</span>
							<span style={{ fontSize: 10, color: "var(--vscode-descriptionForeground)", fontWeight: 400 }}>
								{opt.description}
							</span>
						</button>
					))}
				</div>
			</div>

			{/* Provider Slots */}
			<div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
				<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
					<label style={{ ...labelStyle, margin: 0 }}>Provider Slots ({slots.length})</label>
					{slots.length < 5 && (
						<button
							type="button"
							id="atcli-add-slot"
							onClick={addSlot}
							style={{
								display: "flex",
								alignItems: "center",
								gap: 4,
								padding: "3px 10px",
								borderRadius: 4,
								border: "1px solid rgba(16,185,129,0.5)",
								background: "rgba(16,185,129,0.1)",
								color: "var(--vscode-editor-foreground)",
								cursor: "pointer",
								fontSize: 11,
								fontWeight: 500,
							}}>
							<span>+</span>
							<span>Add Slot</span>
						</button>
					)}
				</div>

				{slots.map((slot, idx) => (
					<div
						key={`slot-${idx}`}
						style={{
							border: "1px solid var(--vscode-panel-border)",
							borderRadius: 8,
							overflow: "hidden",
						}}>
						{/* Slot header */}
						<button
							type="button"
							id={`atcli-slot-${idx}-header`}
							onClick={() => setExpandedSlot(expandedSlot === idx ? null : idx)}
							style={{
								display: "flex",
								alignItems: "center",
								justifyContent: "space-between",
								width: "100%",
								padding: "8px 12px",
								background:
									expandedSlot === idx
										? "rgba(99,102,241,0.1)"
										: "var(--vscode-editor-background)",
								border: "none",
								color: "var(--vscode-editor-foreground)",
								cursor: "pointer",
								fontSize: 12,
								fontWeight: 500,
								textAlign: "left",
							}}>
							<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
								<span
									style={{
										width: 20,
										height: 20,
										borderRadius: "50%",
										background: slot.apiKey ? "rgba(16,185,129,0.7)" : "rgba(234,179,8,0.5)",
										display: "flex",
										alignItems: "center",
										justifyContent: "center",
										fontSize: 10,
										fontWeight: 700,
										flexShrink: 0,
									}}>
									{idx + 1}
								</span>
								<span>{slot.label || `Slot ${idx + 1}`}</span>
								{!slot.apiKey && (
									<span style={{ fontSize: 10, color: "rgba(234,179,8,0.9)" }}>⚠ No API key</span>
								)}
								{slot.apiKey && (
									<span style={{ fontSize: 10, color: "rgba(16,185,129,0.9)" }}>✓ Ready</span>
								)}
							</div>
							<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
								<span style={{ fontSize: 10, color: "var(--vscode-descriptionForeground)" }}>
									{slot.modelId}
								</span>
								<span style={{ fontSize: 10, color: "var(--vscode-descriptionForeground)" }}>
									{expandedSlot === idx ? "▲" : "▼"}
								</span>
							</div>
						</button>

						{/* Slot body */}
						{expandedSlot === idx && (
							<div
								style={{
									padding: "10px 12px",
									display: "flex",
									flexDirection: "column",
									gap: 8,
									borderTop: "1px solid var(--vscode-panel-border)",
									background: "var(--vscode-input-background)",
								}}>
								{/* Preset picker */}
								<div>
									<label style={labelStyle}>Quick Preset</label>
									<select
										id={`atcli-slot-${idx}-preset`}
										style={selectStyle}
										value=""
										onChange={(e) => {
											const p = KNOWN_PROVIDERS.find((x) => x.baseUrl === e.target.value)
											if (p) applyPreset(idx, p)
										}}>
										<option value="">— Select a provider —</option>
										{KNOWN_PROVIDERS.map((p) => (
											<option key={p.baseUrl} value={p.baseUrl}>
												{p.label}
											</option>
										))}
									</select>
								</div>

								{/* Label + Priority row */}
								<div style={{ display: "grid", gridTemplateColumns: "1fr 80px", gap: 6 }}>
									<div>
										<label style={labelStyle}>Slot Label</label>
										<input
											id={`atcli-slot-${idx}-label`}
											style={inputStyle}
											type="text"
											value={slot.label}
											placeholder="e.g. DeepSeek Primary"
											onChange={(e) => updateSlot(idx, { label: e.target.value })}
										/>
									</div>
									<div>
										<label style={labelStyle}>Priority</label>
										<input
											id={`atcli-slot-${idx}-priority`}
											style={inputStyle}
											type="number"
											min={1}
											max={99}
											value={slot.priority ?? idx + 1}
											onChange={(e) =>
												updateSlot(idx, { priority: Number.parseInt(e.target.value) || idx + 1 })
											}
										/>
									</div>
								</div>

								{/* Base URL */}
								<div>
									<label style={labelStyle}>Base URL</label>
									<input
										id={`atcli-slot-${idx}-baseurl`}
										style={inputStyle}
										type="text"
										value={slot.baseUrl}
										placeholder="https://api.deepseek.com/v1"
										onChange={(e) => updateSlot(idx, { baseUrl: e.target.value })}
									/>
								</div>

								{/* API Key */}
								<div>
									<label style={labelStyle}>API Key</label>
									<input
										id={`atcli-slot-${idx}-apikey`}
										style={inputStyle}
										type="password"
										value={slot.apiKey}
										placeholder="sk-..."
										onChange={(e) => updateSlot(idx, { apiKey: e.target.value })}
									/>
								</div>

								{/* Model ID */}
								<div>
									<label style={labelStyle}>Model ID</label>
									<input
										id={`atcli-slot-${idx}-model`}
										style={inputStyle}
										type="text"
										value={slot.modelId}
										placeholder="deepseek-chat"
										onChange={(e) => updateSlot(idx, { modelId: e.target.value })}
									/>
									<p style={{ margin: "3px 0 0", fontSize: 10, color: "var(--vscode-descriptionForeground)" }}>
										The model sent in the API request body for this slot.
									</p>
								</div>

								{/* Cost + Remove row */}
								<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 4 }}>
									<div style={{ display: "flex", alignItems: "center", gap: 6 }}>
										<label style={{ ...labelStyle, margin: 0 }}>$/1M tokens (output):</label>
										<input
											id={`atcli-slot-${idx}-cost`}
											style={{ ...inputStyle, width: 80 }}
											type="number"
											min={0}
											step={0.01}
											value={slot.costPerMToken ?? 0}
											onChange={(e) =>
												updateSlot(idx, { costPerMToken: Number.parseFloat(e.target.value) || 0 })
											}
										/>
									</div>
									{slots.length > 1 && (
										<button
											type="button"
											id={`atcli-slot-${idx}-remove`}
											onClick={() => removeSlot(idx)}
											style={{
												padding: "4px 10px",
												borderRadius: 4,
												border: "1px solid rgba(239,68,68,0.4)",
												background: "rgba(239,68,68,0.08)",
												color: "var(--vscode-errorForeground)",
												cursor: "pointer",
												fontSize: 11,
												fontWeight: 500,
											}}>
											Remove Slot
										</button>
									)}
								</div>
							</div>
						)}
					</div>
				))}
			</div>

			{/* Fallback info */}
			<div
				style={{
					background: "rgba(16,185,129,0.06)",
					border: "1px solid rgba(16,185,129,0.2)",
					borderRadius: 6,
					padding: "8px 12px",
					fontSize: 11,
					color: "var(--vscode-descriptionForeground)",
					display: "flex",
					gap: 8,
					alignItems: "flex-start",
				}}>
				<span style={{ fontSize: 13, flexShrink: 0 }}>🔄</span>
				<span>
					<strong style={{ color: "var(--vscode-editor-foreground)" }}>Auto-fallback enabled:</strong> If a
					slot returns 429 Too Many Requests, it will be cooldown for 60s and the next slot will be tried.
					Slots with 3+ consecutive errors trigger a circuit breaker (5 min recovery).
				</span>
			</div>

			{/* Docs links */}
			<div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
				{[
					{ label: "DeepSeek API", url: "https://platform.deepseek.com" },
					{ label: "Groq (free)", url: "https://console.groq.com" },
					{ label: "Cerebras (free)", url: "https://cloud.cerebras.ai" },
					{ label: "NVIDIA NIM (free)", url: "https://build.nvidia.com" },
					{ label: "SambaNova (free)", url: "https://cloud.sambanova.ai" },
				].map((link) => (
					<a
						key={link.url}
						href={link.url}
						target="_blank"
						rel="noreferrer"
						style={{
							fontSize: 10,
							color: "var(--vscode-textLink-foreground)",
							textDecoration: "none",
						}}>
						{link.label} ↗
					</a>
				))}
			</div>
		</div>
	)
}
