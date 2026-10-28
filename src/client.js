/**
 * dsh-open browser half — runs inside the DSH Web GUI and turns a pending
 * `dsh-open <dir>` request into an opened workspace session.
 *
 * This file is the readable source; `scripts/build-client.mjs` wraps it in the
 * `window.__ModuleLoader__.load({ id, factory })` envelope the client module
 * system expects and writes `lib/client.js`. `npm test` fails when the two
 * disagree.
 *
 * Two jobs:
 *
 * 1. Poll the host half for a pending request, adopt its directory as a
 *    workspace (creating it when the path is new), wait until the workspace
 *    snapshot carries it, open a session there, then ack so the CLI exits 0.
 * 2. Contribute a Settings page that installs or removes the `dsh-open`
 *    command, since `dsh plugin add` only populates the profile's private
 *    `node_modules/.bin`.
 */

/** Host route returning the pending request, if any. */
const pendingRoute = "/dsh-open/pending";

/** Host route that persists the outcome and unblocks the CLI. */
const ackRoute = "/dsh-open/ack";

/** Host route reporting whether the command shim is installed. */
const commandRoute = "/dsh-open/command";

/** Host route that installs or removes the shim (loopback + header fenced). */
const setupRoute = "/dsh-open/setup";

/** How often the browser asks for a pending request. */
const pollIntervalMs = 750;

/** Upper bound for waiting on the workspace state stream (cold start includes host boot). */
const stateTimeoutMs = 30000;

/** Services this plugin cannot act without. */
const inject = ["workspaces", "uiWorkspace"];

/**
 * Read an error's message for the ack payload.
 * @param error - anything thrown.
 * @returns the message text.
 */
function messageOf(error) {
	// Duck-typed on purpose: errors here can come from the plugin's own realm or
	// from the remote layer, and `instanceof` fails across realms.
	if (error !== null && typeof error === "object" && typeof error.message === "string") return error.message;
	return String(error);
}

/**
 * Poll `predicate` until it returns a truthy value.
 * @param predicate - sync check over current state.
 * @param timeoutMs - give-up budget.
 * @param label - failure description.
 * @returns the first truthy value.
 */
async function waitFor(predicate, timeoutMs, label) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		let value;
		try {
			value = predicate();
		} catch {
			value = undefined;
		}
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`dsh-open: timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

/**
 * Persist one outcome for the CLI. Failures are swallowed: the host half clears
 * the pending request on a matching nonce anyway, and a lost ack only costs the
 * CLI its timeout.
 * @param nonce - request nonce echoed from the host half.
 * @param extra - `{ workspaceId }` on success, `{ error }` on failure.
 */
async function sendAck(nonce, extra) {
	try {
		await fetch(ackRoute, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ nonce, ...extra }),
		});
	} catch {
		// The poll loop retries with the next pending request.
	}
}

/**
 * Adopt one directory into a workspace and open a session in it.
 * @param ctx - client root context.
 * @param path - absolute directory the CLI was invoked in.
 * @returns the workspace id the session was opened in.
 */
async function adoptDirectory(ctx, path) {
	const workspaces = ctx.get("workspaces");
	const uiWorkspace = ctx.get("uiWorkspace");
	const snapshot = () => workspaces.list?.getSnapshot?.();

	await waitFor(() => snapshot()?.phase === "ready", stateTimeoutMs, "workspace list");

	let workspace = snapshot().items.find((item) => item.path === path);
	if (workspace === undefined) {
		try {
			workspace = await workspaces.create({ path });
		} catch (error) {
			// A concurrent adopt of the same directory can win the race; adopt its row.
			workspace = snapshot().items.find((item) => item.path === path);
			if (workspace === undefined) throw error;
		}
	}
	const workspaceId = workspace.workspaceId;

	// `uiWorkspace.openWorkspace` resolves the row from the snapshot, so the
	// just-created workspace must be projected before the session can open.
	await waitFor(
		() => snapshot().items.some((item) => item.workspaceId === workspaceId),
		stateTimeoutMs,
		`workspace ${workspaceId}`,
	);
	await uiWorkspace.openWorkspace(workspaceId);
	return workspaceId;
}

/**
 * Start the polling bridge and stop it with the plugin fiber.
 * @param ctx - client root context.
 */
function startBridge(ctx) {
	/** Nonces currently being adopted, so a re-read pending row is not adopted twice. */
	const inFlight = new Set();
	let stopped = false;

	const tick = async () => {
		if (stopped) return;
		let body;
		try {
			const response = await fetch(pendingRoute, { headers: { accept: "application/json" } });
			if (!response.ok) return;
			body = await response.json();
		} catch {
			return;
		}
		const nonce = body?.nonce;
		const path = body?.path;
		if (typeof nonce !== "string" || typeof path !== "string" || inFlight.has(nonce)) return;
		inFlight.add(nonce);
		try {
			const workspaceId = await adoptDirectory(ctx, path);
			await sendAck(nonce, { workspaceId });
		} catch (error) {
			await sendAck(nonce, { error: messageOf(error) });
		} finally {
			inFlight.delete(nonce);
		}
	};

	const timer = setInterval(() => {
		void tick();
	}, pollIntervalMs);
	void tick();
	ctx.effect(() => () => {
		stopped = true;
		clearInterval(timer);
	}, "dsh-open: pending poller");
}

/**
 * Fetch the command status once.
 * @returns the host's `{installed, shimPath, managed, onPath, version}`.
 */
async function readCommandStatus() {
	const response = await fetch(commandRoute, { headers: { accept: "application/json" } });
	if (!response.ok) throw new Error(`dsh-open: command status ${response.status}`);
	return response.json();
}

/**
 * Ask the host to install or remove the shim.
 * @param action - "install" or "remove".
 * @returns the host's response body.
 */
async function mutateCommand(action) {
	const response = await fetch(setupRoute, {
		method: "POST",
		// The `x-dsh-open` header is the host's CSRF fence: a cross-site form
		// cannot set it, and the route rejects requests without it.
		headers: { "content-type": "application/json", "x-dsh-open": "setup" },
		body: JSON.stringify({ action }),
	});
	const body = await response.json();
	if (!response.ok || body?.ok === false) {
		throw new Error(body?.error ?? body?.reason ?? `dsh-open: setup ${response.status}`);
	}
	return body;
}

/** Page styling on DSH's theme tokens, so light and dark both work. */
const styles = {
	page: {
		display: "flex",
		flexDirection: "column",
		gap: "14px",
		maxWidth: "640px",
		color: "var(--dsw-alias-label-primary, inherit)",
	},
	header: {
		display: "flex",
		alignItems: "flex-start",
		justifyContent: "space-between",
		gap: "16px",
	},
	title: { margin: 0, fontSize: "16px", fontWeight: 600, letterSpacing: "-0.01em" },
	subtitle: {
		margin: "3px 0 0",
		fontSize: "12px",
		lineHeight: 1.5,
		color: "var(--dsw-alias-label-secondary, rgba(127,127,127,0.9))",
	},
	pill: {
		display: "inline-flex",
		alignItems: "center",
		gap: "6px",
		flexShrink: 0,
		padding: "3px 10px",
		borderRadius: "999px",
		fontSize: "12px",
		fontWeight: 500,
		whiteSpace: "nowrap",
	},
	dot: { width: "6px", height: "6px", borderRadius: "50%", flexShrink: 0 },
	card: {
		display: "flex",
		flexDirection: "column",
		gap: "14px",
		padding: "16px 18px",
		border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.28))",
		borderRadius: "12px",
		background: "var(--dsw-alias-bg-layer-1, transparent)",
	},
	lead: { margin: 0, fontSize: "13px", lineHeight: 1.6 },
	details: { display: "grid", gridTemplateColumns: "max-content 1fr", gap: "8px 16px", fontSize: "12px" },
	label: { color: "var(--dsw-alias-label-secondary, rgba(127,127,127,0.9))", whiteSpace: "nowrap" },
	mono: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "12px", overflowWrap: "anywhere" },
	actions: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: "8px" },
	primary: {
		padding: "7px 14px",
		borderRadius: "8px",
		border: "1px solid transparent",
		background: "var(--dsw-alias-brand-primary, #4f6bed)",
		color: "#fff",
		font: "inherit",
		fontSize: "13px",
		fontWeight: 500,
		cursor: "pointer",
	},
	ghost: {
		padding: "7px 12px",
		borderRadius: "8px",
		border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.45))",
		background: "transparent",
		color: "inherit",
		font: "inherit",
		fontSize: "13px",
		cursor: "pointer",
	},
	danger: {
		padding: "7px 12px",
		borderRadius: "8px",
		border: "1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary, #d3322b) 40%, transparent)",
		background: "transparent",
		color: "var(--dsw-alias-state-error-primary, #d3322b)",
		font: "inherit",
		fontSize: "13px",
		cursor: "pointer",
	},
	banner: {
		display: "block",
		margin: 0,
		padding: "9px 12px",
		borderRadius: "9px",
		borderLeftWidth: "3px",
		borderLeftStyle: "solid",
		fontSize: "12.5px",
		lineHeight: 1.55,
	},
	footnote: {
		margin: 0,
		fontSize: "11.5px",
		lineHeight: 1.5,
		color: "var(--dsw-alias-label-secondary, rgba(127,127,127,0.8))",
	},
	version: { marginLeft: "auto", fontSize: "11px", color: "var(--dsw-alias-label-secondary, rgba(127,127,127,0.7))" },
};

/** Status tone → theme colour. */
const tones = {
	idle: "var(--dsw-alias-state-idle-primary, #8a8a8a)",
	success: "var(--dsw-alias-state-success-primary, #2ea043)",
	warn: "var(--dsw-alias-state-warn-primary, #b26a00)",
	error: "var(--dsw-alias-state-error-primary, #d3322b)",
};

/** Copy for an English UI. */
const english = {
	title: "dsh-open",
	subtitle: "Open any folder in DeepSeek Harness from your terminal",
	checking: "Checking",
	unavailable: "Unavailable",
	notInstalled: "Not installed",
	ready: "Ready",
	foreign: "Installed elsewhere",
	leadChecking: "Reading your shell and PATH…",
	leadUnknown: "The host half did not answer, so the command state is unknown.",
	leadNotInstalled: "The dsh-open command is not on your PATH yet. One click installs it and updates your shell profile — no terminal needed.",
	leadInstalled: "Ready to use. Run dsh-open . in any folder to open it here.",
	leadForeign: "A dsh-open already on your PATH was not written by this plugin, so it was left alone. Installing adds this plugin's own copy in ~/.local/bin.",
	labelCommand: "Command",
	labelLocation: "Location",
	labelInstallAt: "Will install to",
	labelPath: "Terminal PATH",
	pathYes: "already on it",
	pathPending: (file) => `added to ${file} · applies to new terminals`,
	pathNo: "not on it",
	pathUnknown: "could not read it",
	install: "Install command",
	remove: "Remove command",
	working: "Working…",
	refresh: "Refresh",
	footnote: "Writes one wrapper plus one marked PATH block; Remove takes both back out.",
	removed: "Removed the command. Open a new terminal to get the shorter PATH.",
	removeSkipped: (file) => `${file} was written by something else, so it was left in place.`,
	removeNothing: "The command was not installed, so there was nothing to remove.",
	installAdded: (file) => `Installed. Its folder is now in ${file} — open a new terminal to use it.`,
	installAlreadyOnPath: "Installed, and its folder is already on your shell PATH.",
	installUnknownPath: (dir, file) =>
		`Installed, but your login shell's PATH could not be read. If dsh-open is not found, add ${dir} to ${file ?? "your shell profile"}.`,
	installUnsupportedShell: (dir) => `Installed, but this shell has no profile this plugin knows. Add ${dir} to PATH yourself.`,
	installWriteFailed: (detail, dir) =>
		`Installed, but the shell profile could not be updated: ${detail ?? "write failed"}. Add ${dir} to PATH yourself.`,
	installed: "Installed.",
};

/** Copy for a Chinese UI. */
const chinese = {
	title: "dsh-open",
	subtitle: "在终端里打开任意文件夹",
	checking: "检查中",
	unavailable: "无法连接",
	notInstalled: "未安装",
	ready: "已就绪",
	foreign: "外部安装",
	leadChecking: "正在读取 shell 与 PATH…",
	leadUnknown: "host 半没有响应，暂时读不到命令状态。",
	leadNotInstalled: "终端里还没有 dsh-open 命令。点一下就能装好命令和 shell PATH，不用开终端。",
	leadInstalled: "一切就绪。在任意文件夹运行 dsh-open . 即可在这里打开。",
	leadForeign: "PATH 上已有一个 dsh-open，但不是本插件写的，所以没有动它。安装会在 ~/.local/bin 再放一份本插件自己的副本。",
	labelCommand: "命令",
	labelLocation: "安装位置",
	labelInstallAt: "将安装到",
	labelPath: "终端 PATH",
	pathYes: "已包含",
	pathPending: (file) => `已写入 ${file} · 新终端生效`,
	pathNo: "未包含",
	pathUnknown: "读取失败",
	install: "安装命令",
	remove: "移除命令",
	working: "处理中…",
	refresh: "刷新",
	footnote: "只写入一个包装脚本和一段带标记的 PATH；移除时两者一起收回。",
	removed: "已移除命令，新开终端后 PATH 恢复。",
	removeSkipped: (file) => `${file} 不是本插件写的，保持原样。`,
	removeNothing: "命令本来就没安装，无需移除。",
	installAdded: (file) => `已安装，目录已写进 ${file}，新开终端即可使用。`,
	installAlreadyOnPath: "已安装，目录本来就在 shell PATH 上。",
	installUnknownPath: (dir, file) => `已安装，但读不到登录 shell 的 PATH。若找不到 dsh-open，请把 ${dir} 加入 ${file ?? "shell 配置"}。`,
	installUnsupportedShell: (dir) => `已安装，但这个 shell 没有本插件认识的配置文件，请自行把 ${dir} 加入 PATH。`,
	installWriteFailed: (detail, dir) => `已安装，但写入 shell 配置失败：${detail ?? "写入失败"}。请自行把 ${dir} 加入 PATH。`,
	installed: "已安装。",
};

/**
 * Pick the page's copy from the browser language. The settings shell is
 * bilingual, and shipping a locale bundle just for one page buys nothing.
 * @returns the string table (Chinese when the browser asks for it).
 */
function copy() {
	const language = typeof navigator !== "undefined" && typeof navigator.language === "string" ? navigator.language : "";
	return language.toLowerCase().startsWith("zh") ? chinese : english;
}

/** Status pill, tinted by tone. */
function pillStyle(tone) {
	return {
		...styles.pill,
		color: tones[tone],
		border: `1px solid color-mix(in srgb, ${tones[tone]} 35%, transparent)`,
		background: `color-mix(in srgb, ${tones[tone]} 10%, transparent)`,
	};
}

/** Result banner, tinted by kind. */
function bannerStyle(kind) {
	const color = kind === "success" ? tones.success : kind === "error" ? tones.error : kind === "warn" ? tones.warn : tones.idle;
	return {
		...styles.banner,
		borderLeftColor: color,
		background: `color-mix(in srgb, ${color} 9%, transparent)`,
	};
}

/**
 * Turn a setup response into the banner the page shows under the button.
 * @param action - the action that was requested.
 * @param body - the host's response body.
 * @param t - the active string table.
 * @returns `{kind, text}` with kind one of success/info/warn/error.
 */
function describeResult(action, body, t) {
	const path = body?.path;
	if (action === "remove") {
		if (body?.removed === true) return { kind: "success", text: t.removed };
		if (body?.reason === "not-ours") return { kind: "info", text: t.removeSkipped(body.shimPath) };
		return { kind: "info", text: t.removeNothing };
	}
	if (path?.changed === true) return { kind: "success", text: t.installAdded(path.rcFile) };
	if (path?.reason === "already-on-path") return { kind: "success", text: t.installAlreadyOnPath };
	if (path?.reason === "login-path-unknown") {
		return { kind: "warn", text: t.installUnknownPath(body?.dir, path?.rcFile) };
	}
	if (path?.reason === "unsupported-shell") return { kind: "warn", text: t.installUnsupportedShell(body?.dir) };
	if (path?.reason === "write-failed") return { kind: "warn", text: t.installWriteFailed(path.detail, body?.dir) };
	return { kind: "success", text: t.installed };
}

/**
 * Build one label/value pair for the details grid.
 * @param react - the platform's React.
 * @param t - the active string table.
 * @param label - row label.
 * @param value - row value (string or element).
 * @param style - value style override.
 * @returns a `[dt, dd]` pair to spread into the grid.
 */
function detail(react, t, label, value, style) {
	return [
		react.createElement("span", { key: `${label}-label`, style: styles.label }, label),
		react.createElement("span", { key: `${label}-value`, style: style ?? styles.mono }, value),
	];
}

/**
 * Settings page: the state of the command, and the one action that changes it.
 *
 * Props are injected by the slot registry below; `react` comes from the
 * platform module table, so this bundle ships no UI library of its own.
 */
function CommandSettingsPage() {
	const react = hostRequire("react");
	const { useCallback, useEffect, useState } = react;
	const t = copy();
	const [status, setStatus] = useState({ phase: "loading" });
	const [busy, setBusy] = useState(false);
	const [banner, setBanner] = useState(undefined);

	const refresh = useCallback(async () => {
		try {
			const value = await readCommandStatus();
			setStatus({ phase: "ready", value });
		} catch (failure) {
			setStatus({ phase: "unavailable" });
			setBanner({ kind: "error", text: messageOf(failure) });
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const run = async (action) => {
		setBusy(true);
		setBanner(undefined);
		try {
			const body = await mutateCommand(action);
			setBanner(describeResult(action, body, t));
			await refresh();
		} catch (failure) {
			setBanner({ kind: "error", text: messageOf(failure) });
		} finally {
			setBusy(false);
		}
	};

	const ready = status.phase === "ready";
	const value = ready ? status.value : undefined;
	const installed = value?.installed === true;
	const managed = value?.managed === true;
	const tone = !ready ? (status.phase === "loading" ? "idle" : "error") : !installed ? "idle" : managed ? "success" : "warn";
	const pill = !ready ? (status.phase === "loading" ? t.checking : t.unavailable) : !installed ? t.notInstalled : managed ? t.ready : t.foreign;
	const lead = !ready
		? status.phase === "loading"
			? t.leadChecking
			: t.leadUnknown
		: !installed
			? t.leadNotInstalled
			: managed
				? t.leadInstalled
				: t.leadForeign;

	const details = [detail(react, t, t.labelCommand, react.createElement("code", { style: styles.mono }, "dsh-open ."))];
	if (ready && installed) details.push(detail(react, t, t.labelLocation, value.shimPath ?? "—"));
	if (ready && !installed) details.push(detail(react, t, t.labelInstallAt, value.dir ?? "~/.local/bin"));
	if (ready && installed) {
		const pathState =
			value.onLoginPath === true
				? { text: t.pathYes, tone: "success" }
				: value.pathConfigured === true
					? { text: t.pathPending(value.rcFile), tone: "warn" }
					: value.loginPathKnown === false
						? { text: t.pathUnknown, tone: "idle" }
						: { text: t.pathNo, tone: "warn" };
		details.push(detail(react, t, t.labelPath, react.createElement("span", { style: { color: tones[pathState.tone] } }, pathState.text)));
	}

	return react.createElement(
		"section",
		{ style: styles.page },
		react.createElement(
			"header",
			{ style: styles.header },
			react.createElement(
				"div",
				null,
				react.createElement("h2", { style: styles.title }, t.title),
				react.createElement("p", { style: styles.subtitle }, t.subtitle),
			),
			react.createElement(
				"span",
				{ style: pillStyle(tone) },
				react.createElement("span", { style: { ...styles.dot, background: tones[tone] } }),
				pill,
			),
		),
		react.createElement(
			"div",
			{ style: styles.card },
			react.createElement("p", { style: styles.lead }, lead),
			react.createElement("div", { style: styles.details }, ...details.flat()),
			react.createElement(
				"div",
				{ style: styles.actions },
				ready
					? react.createElement(
							"button",
							{
								type: "button",
								style: managed ? styles.danger : styles.primary,
								disabled: busy,
								onClick: () => void run(managed ? "remove" : "install"),
							},
							busy ? t.working : managed ? t.remove : t.install,
						)
					: null,
				react.createElement("button", { type: "button", style: styles.ghost, disabled: busy, onClick: () => void refresh() }, t.refresh),
				react.createElement("span", { style: styles.version }, value?.version === undefined ? "" : `v${value.version}`),
			),
			banner === undefined ? null : react.createElement("div", { style: bannerStyle(banner.kind) }, banner.text),
			react.createElement("p", { style: styles.footnote }, t.footnote),
		),
	);
}

/**
 * Contribute the page to Settings: a section of its own (what a user looking
 * for the plugin actually sees in the sidebar) and a view inside the built-in
 * Plugins page (the convention every plugin page follows).
 *
 * `slots.inject` registers only when the deployment actually composes that
 * slot, so a bare `dsh web` without the settings UI still loads this plugin.
 * @param ctx - client root context.
 */
function contributeSettingsPage(ctx) {
	// The bridge above matters more than the page: any surprise here (a client
	// contract that moved, a service that is not reachable) leaves `dsh-open .`
	// working and only costs the settings page.
	for (const add of [addSection, addTab]) {
		try {
			add(ctx);
		} catch {
			// Ignored on purpose.
		}
	}
}

/**
 * Register the page as its own settings section, next to WeChat and the market.
 * @param ctx - client root context.
 */
function addSection(ctx) {
	const slots = ctx.get("slots");
	if (slots === undefined || slots === null || typeof slots.inject !== "function") return;
	ctx.effect(
		() =>
			slots.inject("settings.section", () =>
				slots.register(
					{
						name: "settings.section",
						id: "dsh-open",
						order: 45,
						label: () => "dsh-open",
					},
					CommandSettingsPage,
				),
			),
		"dsh-open: settings section",
	);
}

/**
 * Register the view inside the built-in Plugins section.
 * @param ctx - client root context.
 */
function addTab(ctx) {
	const slots = ctx.get("slots");
	if (slots === undefined || slots === null || typeof slots.inject !== "function") return;
	ctx.effect(
		() =>
			slots.inject("settings.plugins.tab", () =>
				slots.register(
					{
						name: "settings.plugins.tab",
						id: "dsh-open",
						order: 40,
						label: () => "dsh-open",
					},
					CommandSettingsPage,
				),
			),
		"dsh-open: settings tab",
	);
}

/**
 * Install the browser half.
 * @param ctx - client root context (services named by `inject` are present).
 */
function apply(ctx) {
	if (typeof window === "undefined") return;
	startBridge(ctx);
	contributeSettingsPage(ctx);
}

exports.apply = apply;
exports.inject = inject;
