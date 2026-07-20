"use client";

import {
	ArrowRight,
	BrainCircuit,
	FolderPlus,
	GitBranch,
	History,
	Plus,
	Sparkles,
} from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useWorkspace } from "@/contexts/workspace-context";
import { cn } from "@/lib/utils";
import { normalizeWorkspacePath } from "@/lib/workspace-paths";

interface QuickAction {
	id: string;
	label: string;
	description: string;
	prompt: string;
}

const DEFAULT_QUICK_ACTIONS: QuickAction[] = [
	{
		id: "review-changes",
		label: "Review changes",
		description: "Review the current changes and call out anything risky.",
		prompt: "Review the current changes and call out anything risky.",
	},
	{
		id: "check-build",
		label: "Check for build errors",
		description: "Run the relevant checks and help me fix any failures.",
		prompt: "Check this project for build errors and help me fix any failures.",
	},
];

function toWorkspaceName(path: string): string {
	const trimmed = path.trim().replace(/[\\/]+$/, "");
	if (!trimmed) return "Workspace";
	const parts = trimmed.split(/[\\/]/);
	return parts[parts.length - 1] || "Workspace";
}

function workspaceLabels(paths: string[]): Map<string, string> {
	const segments = paths.map((path) =>
		path
			.trim()
			.replace(/[\\/]+$/, "")
			.split(/[\\/]/)
			.filter(Boolean),
	);
	return new Map(
		paths.map((path, index) => {
			const parts = segments[index] ?? [];
			for (let depth = 1; depth <= parts.length; depth += 1) {
				const candidate = parts.slice(-depth).join("/");
				const matches = segments.filter(
					(other) => other.slice(-depth).join("/") === candidate,
				).length;
				if (matches === 1) return [path, candidate];
			}
			return [path, toWorkspaceName(path)];
		}),
	);
}

export function WelcomeScreen({
	active,
	body,
	composer,
	onStartChat,
	quickActions,
}: {
	active: boolean;
	body: ReactNode;
	composer: ReactNode;
	onStartChat: (prompt: string) => void;
	quickActions: QuickAction[];
}) {
	const {
		workspaceRoot,
		workspaces,
		refreshWorkspaces,
		switchWorkspace,
		pickWorkspaceDirectory,
	} = useWorkspace();
	const [switchingWorkspace, setSwitchingWorkspace] = useState<string | null>(
		null,
	);
	const [addingWorkspace, setAddingWorkspace] = useState(false);
	const availableWorkspaces = useMemo(() => {
		const next = new Map<string, string>();
		const register = (path: string) => {
			const trimmed = path.trim();
			if (trimmed) next.set(normalizeWorkspacePath(trimmed), trimmed);
		};
		register(workspaceRoot);
		for (const workspacePath of workspaces) register(workspacePath);
		return [...next.values()];
	}, [workspaceRoot, workspaces]);
	const actions =
		quickActions.length > 0 ? quickActions : DEFAULT_QUICK_ACTIONS;
	const labelsByWorkspace = useMemo(
		() => workspaceLabels(availableWorkspaces),
		[availableWorkspaces],
	);

	useEffect(() => {
		if (active) void refreshWorkspaces();
	}, [active, refreshWorkspaces]);

	const handleSelectWorkspace = useCallback(
		async (path: string) => {
			if (
				normalizeWorkspacePath(path) ===
					normalizeWorkspacePath(workspaceRoot) ||
				switchingWorkspace
			) {
				return;
			}
			setSwitchingWorkspace(path);
			try {
				await switchWorkspace(path);
			} finally {
				setSwitchingWorkspace(null);
			}
		},
		[switchWorkspace, switchingWorkspace, workspaceRoot],
	);

	const handleAddWorkspace = useCallback(async () => {
		if (addingWorkspace) return;
		setAddingWorkspace(true);
		try {
			const selected = await pickWorkspaceDirectory(workspaceRoot || undefined);
			if (selected) await switchWorkspace(selected);
		} finally {
			setAddingWorkspace(false);
		}
	}, [addingWorkspace, pickWorkspaceDirectory, switchWorkspace, workspaceRoot]);

	return (
		<div
			className={cn(
				active ? "relative h-full min-h-0 overflow-hidden" : "contents",
			)}
		>
			{active ? (
				<div className="atcli-soft-grid pointer-events-none absolute inset-0 opacity-80" />
			) : null}
			<div
				className={cn(
					active
						? "relative z-10 h-full w-full overflow-x-hidden overflow-y-auto atcli-premium-scroll"
						: "contents",
				)}
			>
				<div
					className={cn(
						active
							? "mx-auto grid min-h-full w-full max-w-[1180px] grid-cols-[minmax(0,0.82fr)_minmax(22rem,0.38fr)] gap-5 px-6 py-8 max-[980px]:flex max-[980px]:flex-col max-[720px]:px-4 max-[720px]:py-4"
							: "contents",
					)}
				>
					{active ? (
						<section className="flex min-h-0 flex-col justify-center py-8 max-[980px]:py-0">
							<div className="mb-5 inline-flex w-fit items-center gap-2 rounded-lg border border-border/70 bg-card/80 px-3 py-1.5 font-mono text-[11px] uppercase text-muted-foreground shadow-sm backdrop-blur">
								<Sparkles className="size-3.5 text-primary" />
								ATCLI command center
							</div>
							<h1 className="max-w-3xl text-balance text-[clamp(2.35rem,5vw,5.1rem)] font-semibold leading-[0.98] text-foreground">
								Turn the whole codebase into a calm, clickable workflow.
							</h1>
							<p className="mt-5 max-w-2xl text-[17px] leading-7 text-muted-foreground">
								Start from intent, switch projects quickly, and keep model,
								mode, files, branch, and queue controls in one clean surface.
							</p>

							<div className="mt-8 atcli-glass rounded-lg p-3">
								<div className="mb-3 flex items-center justify-between gap-3">
									<div className="flex min-w-0 items-center gap-2">
										<GitBranch className="size-4 shrink-0 text-primary" />
										<span className="truncate text-sm font-semibold">
											{toWorkspaceName(workspaceRoot)}
										</span>
									</div>
									<button
										className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
										disabled={addingWorkspace}
										onClick={() => void handleAddWorkspace()}
										type="button"
									>
										{addingWorkspace ? (
											<FolderPlus className="size-4 animate-pulse" />
										) : (
											<Plus className="size-4" />
										)}
										Add project
									</button>
								</div>
								<fieldset className="grid max-h-32 min-w-0 grid-cols-2 gap-2 overflow-y-auto max-[640px]:grid-cols-1">
									<legend className="sr-only">Workspaces</legend>
									{availableWorkspaces.map((path) => {
										const isActive =
											normalizeWorkspacePath(path) ===
											normalizeWorkspacePath(workspaceRoot);
										const isSwitching = switchingWorkspace === path;
										return (
											<button
												aria-pressed={isActive}
												className={cn(
													"min-w-0 rounded-lg border px-3 py-2 text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
													isActive
														? "border-primary/35 bg-primary/10 text-foreground shadow-sm"
														: "border-border/70 bg-background/55 text-muted-foreground hover:border-primary/25 hover:bg-accent/50 hover:text-foreground",
												)}
												disabled={Boolean(switchingWorkspace)}
												key={path}
												onClick={() => void handleSelectWorkspace(path)}
												title={path}
												type="button"
											>
												<span className="block truncate text-sm font-semibold">
													{isSwitching
														? "Switching..."
														: (labelsByWorkspace.get(path) ??
															toWorkspaceName(path))}
												</span>
												<span className="mt-1 block truncate font-mono text-[10px] text-muted-foreground">
													{path}
												</span>
											</button>
										);
									})}
								</fieldset>
							</div>
						</section>
					) : null}

					<div
						className={active ? "hidden" : "h-full min-h-0 overflow-hidden"}
						key="conversation-body"
					>
						{body}
					</div>

					<div
						className={
							active ? "self-center max-[980px]:self-stretch" : "z-20 shrink-0"
						}
						key="persistent-composer"
					>
						<div className={active ? "sticky top-6" : undefined}>
							{composer}
						</div>
					</div>

					{active ? (
						<section className="col-span-2 grid grid-cols-[0.35fr_0.65fr] gap-5 max-[980px]:grid-cols-1">
							<div className="atcli-panel rounded-lg p-4">
								<div className="flex items-center gap-2 text-sm font-semibold">
									<BrainCircuit className="size-4 text-primary" />
									Agent modes
								</div>
								<div className="mt-3 grid gap-2 text-sm text-muted-foreground">
									<div className="flex items-center gap-2 rounded-md bg-background/55 px-3 py-2">
										<History className="size-4" />
										Session history and forks
									</div>
									<div className="flex items-center gap-2 rounded-md bg-background/55 px-3 py-2">
										<GitBranch className="size-4" />
										Workspace and branch switching
									</div>
								</div>
							</div>
							<div className="divide-y divide-border/80 overflow-hidden rounded-lg atcli-panel">
								{actions.map((action) => (
									<button
										className="group flex w-full items-center justify-between gap-5 px-4 py-4 text-left transition-colors hover:bg-accent/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
										key={action.id}
										onClick={() => onStartChat(action.prompt)}
										type="button"
									>
										<span className="min-w-0">
											<span className="block text-[15px] font-semibold text-foreground">
												{action.label}
											</span>
											<span className="mt-0.5 block truncate text-sm text-muted-foreground">
												{action.description}
											</span>
										</span>
										<span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
											<ArrowRight className="size-3.5" />
										</span>
									</button>
								))}
							</div>
						</section>
					) : null}
				</div>
			</div>
		</div>
	);
}
