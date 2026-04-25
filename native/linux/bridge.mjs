#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import process from "node:process";

const stdinChunks = [];
const elementRefs = new Map();
let nextElementId = 0;

const linuxDependencyHint = "Install Linux/X11 prerequisites with: sudo apt install wmctrl xdotool imagemagick x11-utils x11-apps";
const commandPackageHints = new Map([
	["wmctrl", "wmctrl"],
	["xdotool", "xdotool"],
	["xprop", "x11-utils"],
	["import", "imagemagick"],
	["convert", "imagemagick"],
	["xwd", "x11-apps"],
]);

function missingCommandMessage(command, detail) {
	const packageName = commandPackageHints.get(command);
	const packageHint = packageName ? ` Install package: ${packageName}.` : "";
	return `${command} not available: ${detail}.${packageHint} ${linuxDependencyHint}`;
}

function ok(id, result) {
	process.stdout.write(`${JSON.stringify({ id, ok: true, result })}\n`);
}

function fail(id, message, code = "internal_error") {
	process.stdout.write(`${JSON.stringify({ id, ok: false, error: { message, code } })}\n`);
}

function run(command, args = [], options = {}) {
	const result = spawnSync(command, args, {
		encoding: options.encoding ?? "utf8",
		maxBuffer: options.maxBuffer ?? 20 * 1024 * 1024,
		input: options.input,
	});
	if (result.error) {
		throw Object.assign(new Error(missingCommandMessage(command, result.error.message)), { code: "dependency_missing" });
	}
	if (result.status !== 0) {
		const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
		const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
		throw Object.assign(new Error(`${command} failed (${result.status})${stderr || stdout ? `: ${stderr || stdout}` : ""}`), { code: "command_failed" });
	}
	return result.stdout;
}

function tryRun(command, args = [], options = {}) {
	try {
		return run(command, args, options);
	} catch {
		return undefined;
	}
}

function needDisplay() {
	if (!process.env.DISPLAY) {
		throw Object.assign(new Error(`DISPLAY is not set. The Linux bridge currently supports X11 sessions only. ${linuxDependencyHint}`), { code: "x11_unavailable" });
	}
	if (String(process.env.XDG_SESSION_TYPE || "").toLowerCase() === "wayland") {
		throw Object.assign(new Error("Wayland session detected. The Linux bridge currently supports X11/Xorg sessions only; choose an Xorg session at login."), { code: "x11_unavailable" });
	}
}

function numberArg(request, key, fallback) {
	const value = request[key];
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
	if (fallback !== undefined) return fallback;
	throw Object.assign(new Error(`${key} must be a number`), { code: "invalid_args" });
}

function stringArg(request, key, fallback) {
	const value = request[key];
	if (typeof value === "string") return value;
	if (fallback !== undefined) return fallback;
	throw Object.assign(new Error(`${key} must be a string`), { code: "invalid_args" });
}

function windowIdToHex(windowId) {
	if (typeof windowId === "string" && windowId.startsWith("0x")) return windowId;
	const numeric = Number(windowId);
	if (!Number.isFinite(numeric) || numeric <= 0) {
		throw Object.assign(new Error("windowId must be a positive X11 window id"), { code: "invalid_args" });
	}
	return `0x${Math.trunc(numeric).toString(16)}`;
}

function windowIdToNumber(raw) {
	if (typeof raw === "number") return Math.trunc(raw);
	if (typeof raw === "string") return Number.parseInt(raw, raw.startsWith("0x") ? 16 : 10);
	return 0;
}

function parseWmctrlLine(line) {
	// wmctrl -lpxG:
	// 0x04c00007  0 1234  10  20  900  700 class.name host title words...
	const match = line.match(/^(0x[0-9a-fA-F]+)\s+(-?\d+)\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s*(.*)$/);
	if (!match) return undefined;
	const [, rawId, desktop, pid, x, y, w, h, wmClass, _host, title = ""] = match;
	return {
		windowId: windowIdToNumber(rawId),
		rawId,
		desktop: Number(desktop),
		pid: Number(pid),
		x: Number(x),
		y: Number(y),
		w: Number(w),
		h: Number(h),
		wmClass,
		title: title.trim(),
	};
}

function wmctrlWindows() {
	needDisplay();
	const output = run("wmctrl", ["-lpxG"]);
	return output.split(/\r?\n/).map(parseWmctrlLine).filter(Boolean);
}

function focusedWindowId() {
	needDisplay();
	const raw = tryRun("xdotool", ["getwindowfocus"]);
	if (!raw) return undefined;
	const id = Number.parseInt(raw.trim(), 10);
	return Number.isFinite(id) && id > 0 ? id : undefined;
}

function getWindowPid(windowId) {
	const raw = tryRun("xdotool", ["getwindowpid", String(windowId)]);
	const pid = raw ? Number.parseInt(raw.trim(), 10) : NaN;
	return Number.isFinite(pid) && pid > 0 ? pid : undefined;
}

function getWindowName(windowId) {
	return tryRun("xdotool", ["getwindowname", String(windowId)])?.trim() || "";
}

function xprop(windowId, prop) {
	return tryRun("xprop", ["-id", windowIdToHex(windowId), prop])?.trim() || "";
}

function wmClassParts(wmClass) {
	const parts = String(wmClass || "").split(".").filter(Boolean);
	const instance = parts[0] || "";
	const klass = parts[parts.length - 1] || instance || "Unknown App";
	return { instance, klass };
}

function friendlyAppName(wmClass, title = "") {
	const { klass } = wmClassParts(wmClass);
	if (klass && klass !== "N/A") return klass.replaceAll("_", " ");
	return title || "Unknown App";
}

function windowState(windowId) {
	return xprop(windowId, "_NET_WM_STATE");
}

function listApps() {
	const focused = focusedWindowId();
	const byPid = new Map();
	for (const win of wmctrlWindows()) {
		if (!win.pid || win.pid <= 0) continue;
		if (!byPid.has(win.pid)) {
			byPid.set(win.pid, {
				appName: friendlyAppName(win.wmClass, win.title),
				bundleId: win.wmClass,
				pid: win.pid,
				isFrontmost: win.windowId === focused,
			});
		} else if (win.windowId === focused) {
			byPid.get(win.pid).isFrontmost = true;
		}
	}
	return [...byPid.values()];
}

function listWindows(pid) {
	const focused = focusedWindowId();
	return wmctrlWindows()
		.filter((win) => win.pid === pid)
		.map((win) => {
			const state = windowState(win.windowId);
			return {
				windowId: win.windowId,
				windowRef: `x11:${win.rawId}`,
				title: win.title,
				framePoints: { x: win.x, y: win.y, w: Math.max(1, win.w), h: Math.max(1, win.h) },
				scaleFactor: 1,
				isMinimized: /_NET_WM_STATE_HIDDEN/.test(state),
				isOnscreen: win.desktop !== -1,
				isMain: win.windowId === focused,
				isFocused: win.windowId === focused,
			};
		});
}

function getFrontmost() {
	const focused = focusedWindowId();
	if (!focused) throw Object.assign(new Error("No focused X11 window available"), { code: "frontmost_unavailable" });
	const windows = wmctrlWindows();
	const match = windows.find((win) => win.windowId === focused);
	const pid = match?.pid || getWindowPid(focused);
	if (!pid) throw Object.assign(new Error("Focused X11 window has no pid"), { code: "frontmost_unavailable" });
	const wmClass = match?.wmClass || "";
	const title = match?.title || getWindowName(focused);
	return {
		appName: friendlyAppName(wmClass, title),
		bundleId: wmClass || undefined,
		pid,
		windowTitle: title,
		windowId: focused,
	};
}

function focusWindow(request) {
	const windowId = request.windowId ? Number(request.windowId) : undefined;
	if (!windowId) return { focused: false, reason: "window_id_required" };
	try {
		run("xdotool", ["windowactivate", "--sync", String(windowId)]);
		return { focused: true };
	} catch (error) {
		return { focused: false, reason: error.message || "focus_failed" };
	}
}

function restoreUserFocus(request) {
	const pid = numberArg(request, "pid");
	const title = typeof request.windowTitle === "string" ? request.windowTitle.trim().toLowerCase() : "";
	const candidates = listWindows(pid);
	const chosen = title ? candidates.find((win) => win.title.trim().toLowerCase() === title) : candidates[0];
	if (!chosen) return { restored: false, appRestored: false, windowRestored: false };
	const result = focusWindow({ windowId: chosen.windowId });
	return {
		restored: result.focused,
		appRestored: result.focused,
		windowRestored: result.focused,
		windowTitle: chosen.title,
	};
}

function pngSize(buffer) {
	if (buffer.length >= 24 && buffer.toString("ascii", 1, 4) === "PNG") {
		return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
	}
	return { width: 1, height: 1 };
}

function captureWindow(request) {
	const windowId = numberArg(request, "windowId");
	const hex = windowIdToHex(windowId);
	let png;
	try {
		png = run("import", ["-window", hex, "png:-"], { encoding: "buffer", maxBuffer: 50 * 1024 * 1024 });
	} catch (importError) {
		try {
			const xwd = run("xwd", ["-silent", "-id", hex], { encoding: "buffer", maxBuffer: 50 * 1024 * 1024 });
			png = run("convert", ["xwd:-", "png:-"], { input: xwd, encoding: "buffer", maxBuffer: 50 * 1024 * 1024 });
		} catch {
			throw Object.assign(new Error(`Window screenshot requires ImageMagick 'import' or xwd+convert (${importError.message}). ${linuxDependencyHint}`), { code: "screenshot_failed" });
		}
	}
	const { width, height } = pngSize(png);
	return { pngBase64: Buffer.from(png).toString("base64"), width, height, scaleFactor: 1 };
}

function relativePoint(request) {
	const x = numberArg(request, "x");
	const y = numberArg(request, "y");
	const captureWidth = Math.max(1, numberArg(request, "captureWidth", 1));
	const captureHeight = Math.max(1, numberArg(request, "captureHeight", 1));
	const windowId = numberArg(request, "windowId");
	const win = wmctrlWindows().find((candidate) => candidate.windowId === windowId);
	const w = Math.max(1, win?.w || captureWidth);
	const h = Math.max(1, win?.h || captureHeight);
	return {
		windowId,
		x: Math.round(Math.max(0, Math.min(w - 1, (x / captureWidth) * w))),
		y: Math.round(Math.max(0, Math.min(h - 1, (y / captureHeight) * h))),
	};
}

function mouseButtonNumber(name) {
	switch (String(name || "left").toLowerCase()) {
		case "right": return "3";
		case "middle":
		case "center": return "2";
		default: return "1";
	}
}

function mouseClick(request) {
	const { windowId, x, y } = relativePoint(request);
	const clickCount = Math.max(1, Math.min(3, Math.trunc(numberArg(request, "clickCount", 1))));
	const button = mouseButtonNumber(request.button);
	run("xdotool", ["windowactivate", "--sync", String(windowId)]);
	run("xdotool", ["mousemove", "--window", String(windowId), String(x), String(y)]);
	for (let i = 0; i < clickCount; i += 1) run("xdotool", ["click", button]);
	return { clicked: true };
}

function mouseMove(request) {
	const { windowId, x, y } = relativePoint(request);
	run("xdotool", ["mousemove", "--window", String(windowId), String(x), String(y)]);
	return { moved: true };
}

function scrollWheel(request) {
	const { windowId, x, y } = relativePoint(request);
	const scrollX = Math.trunc(numberArg(request, "scrollX", 0));
	const scrollY = Math.trunc(numberArg(request, "scrollY", 0));
	run("xdotool", ["windowactivate", "--sync", String(windowId)]);
	run("xdotool", ["mousemove", "--window", String(windowId), String(x), String(y)]);
	const clicks = [];
	const yButton = scrollY > 0 ? "5" : "4";
	const xButton = scrollX > 0 ? "7" : "6";
	for (let i = 0; i < Math.min(12, Math.max(0, Math.ceil(Math.abs(scrollY) / 120))); i += 1) clicks.push(yButton);
	for (let i = 0; i < Math.min(12, Math.max(0, Math.ceil(Math.abs(scrollX) / 120))); i += 1) clicks.push(xButton);
	for (const button of clicks) run("xdotool", ["click", button]);
	return { scrolled: true };
}

function normalizeKey(key) {
	const trimmed = String(key).trim();
	const lower = trimmed.toLowerCase();
	const table = new Map([
		["enter", "Return"], ["return", "Return"], ["esc", "Escape"], ["escape", "Escape"],
		["backspace", "BackSpace"], ["delete", "BackSpace"], ["del", "BackSpace"],
		["tab", "Tab"], ["space", "space"], [" ", "space"],
		["left", "Left"], ["arrowleft", "Left"], ["arrow_left", "Left"],
		["right", "Right"], ["arrowright", "Right"], ["arrow_right", "Right"],
		["up", "Up"], ["arrowup", "Up"], ["arrow_up", "Up"],
		["down", "Down"], ["arrowdown", "Down"], ["arrow_down", "Down"],
		["pageup", "Page_Up"], ["page_up", "Page_Up"], ["pagedown", "Page_Down"], ["page_down", "Page_Down"],
		["home", "Home"], ["end", "End"],
	]);
	return table.get(lower) || trimmed;
}

function normalizeChord(chord) {
	return String(chord)
		.split("+")
		.map((part, index, parts) => {
			const lower = part.trim().toLowerCase();
			if (index < parts.length - 1) {
				if (["cmd", "command", "meta"].includes(lower)) return "ctrl";
				if (["control"].includes(lower)) return "ctrl";
				if (["option"].includes(lower)) return "alt";
			}
			return normalizeKey(part);
		})
		.join("+");
}

function keyPress(request) {
	const keys = Array.isArray(request.keys) ? request.keys : [];
	if (!keys.length) throw Object.assign(new Error("keys must be a non-empty array"), { code: "invalid_args" });
	if (request.pid) {
		const win = listWindows(Number(request.pid)).find((candidate) => candidate.isFocused) || listWindows(Number(request.pid))[0];
		if (win) focusWindow({ windowId: win.windowId });
	}
	for (const key of keys) {
		run("xdotool", ["key", normalizeChord(key)]);
	}
	return { pressed: true };
}

function typeText(request) {
	const text = stringArg(request, "text", "");
	if (request.pid) {
		const win = listWindows(Number(request.pid)).find((candidate) => candidate.isFocused) || listWindows(Number(request.pid))[0];
		if (win) focusWindow({ windowId: win.windowId });
	}
	run("xdotool", ["type", "--clearmodifiers", text]);
	return { typed: true };
}

function mouseDrag(request) {
	const rawPath = Array.isArray(request.path) ? request.path : [];
	if (rawPath.length < 2) throw Object.assign(new Error("mouseDrag requires at least two points"), { code: "invalid_args" });
	const windowId = numberArg(request, "windowId");
	run("xdotool", ["windowactivate", "--sync", String(windowId)]);
	const points = rawPath.map((point) => relativePoint({ ...request, x: point.x, y: point.y }));
	const first = points[0];
	run("xdotool", ["mousemove", "--window", String(windowId), String(first.x), String(first.y), "mousedown", "1"]);
	for (const point of points.slice(1)) {
		run("xdotool", ["mousemove", "--window", String(windowId), String(point.x), String(point.y)]);
	}
	run("xdotool", ["mouseup", "1"]);
	return { dragged: true };
}

function axStubElement() {
	const ref = `linux-e${++nextElementId}`;
	elementRefs.set(ref, true);
	return ref;
}

function handle(request) {
	switch (request.cmd) {
		case "checkPermissions":
			return { accessibility: true, screenRecording: true };
		case "openPermissionPane":
			return { opened: false };
		case "listApps":
			return listApps();
		case "listWindows":
			return listWindows(numberArg(request, "pid"));
		case "getFrontmost":
			return getFrontmost();
		case "getUserContext": {
			const front = getFrontmost();
			return { ...front, window: { title: front.windowTitle || "", role: "window", subrole: "" } };
		}
		case "beginInputSuppression":
			return { active: false };
		case "endInputSuppression":
			return { active: false };
		case "restoreUserFocus":
			return restoreUserFocus(request);
		case "focusWindow":
			return focusWindow(request);
		case "screenshot":
			return captureWindow(request);
		case "mouseClick":
			return mouseClick(request);
		case "mouseMove":
			return mouseMove(request);
		case "mouseDrag":
			return mouseDrag(request);
		case "scrollWheel":
			return scrollWheel(request);
		case "keyPress":
			return keyPress(request);
		case "typeText":
			return typeText(request);
		case "getMousePosition": {
			const raw = run("xdotool", ["getmouselocation", "--shell"]);
			const x = Number(raw.match(/^X=(\d+)/m)?.[1] || 0);
			const y = Number(raw.match(/^Y=(\d+)/m)?.[1] || 0);
			return { x, y };
		}
		case "axListTargets":
			return [];
		case "axPressAtPoint":
			return { pressed: false, reason: "linux_ax_not_implemented" };
		case "axFindTextInput":
			return { found: false, reason: "linux_ax_not_implemented" };
		case "axFocusTextInput":
			return { focused: false, reason: "linux_ax_not_implemented" };
		case "axPressElement":
			return { pressed: false, reason: "linux_ax_not_implemented" };
		case "axPerformActionElement":
			return { performed: false, reason: "linux_ax_not_implemented" };
		case "axFocusElement":
			return { focused: false, reason: "linux_ax_not_implemented" };
		case "axFocusAtPoint":
			return { focused: false, reason: "linux_ax_not_implemented" };
		case "axScrollElement":
		case "axScrollAtPoint":
			return { scrolled: false, reason: "linux_ax_not_implemented" };
		case "focusedElement":
			return { exists: false };
		case "setValue":
			if (!elementRefs.has(request.elementRef)) throw Object.assign(new Error("Element reference is no longer valid"), { code: "element_ref_invalid" });
			return { set: false };
		default:
			throw Object.assign(new Error(`Unknown command '${request.cmd}'`), { code: "unknown_command" });
	}
}

function processLine(line) {
	if (!line.trim()) return;
	let request;
	let id = "invalid";
	try {
		request = JSON.parse(line);
		id = typeof request.id === "string" ? request.id : id;
		ok(id, handle(request));
	} catch (error) {
		fail(id, error?.message || String(error), error?.code || "internal_error");
	}
}

process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	let newline;
	while ((newline = buffer.indexOf("\n")) >= 0) {
		const line = buffer.slice(0, newline);
		buffer = buffer.slice(newline + 1);
		processLine(line);
	}
});
process.stdin.on("end", () => process.exit(0));
