#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const helperDestPath = path.join(os.homedir(), ".pi", "agent", "helpers", "pi-computer-use", "bridge");
const helperSourcePath = path.join(rootDir, "native", "macos", "bridge.swift");
const linuxHelperSourcePath = path.join(rootDir, "native", "linux", "bridge.mjs");

const linuxInstallHint = [
	"Linux support currently requires an X11 session plus these system tools:",
	"  sudo apt install wmctrl xdotool imagemagick x11-utils x11-apps",
	"Wayland sessions are not supported yet; choose an Xorg/X11 session at login.",
].join("\n");

const args = new Set(process.argv.slice(2));
const isPostinstall = args.has("--postinstall");
const allowBuildFallback = args.has("--allow-build") || args.has("--runtime") || process.env.PI_COMPUTER_USE_ALLOW_BUILD === "1";
const archTargets = {
	arm64: "arm64-apple-macosx14.0",
	x64: "x86_64-apple-macosx14.0",
};
const defaultCodeSignIdentifier = "com.injaneity.pi-computer-use.bridge";

function normalizeArch(arch) {
	if (arch === "arm64" || arch === "x64") return arch;
	throw new Error(`Unsupported architecture '${arch}'. Supported: arm64, x64.`);
}

function prebuiltPathForArch(arch) {
	return path.join(rootDir, "prebuilt", "macos", arch, "bridge");
}

async function exists(filePath) {
	try {
		await fs.access(filePath, fsConstants.F_OK);
		return true;
	} catch {
		return false;
	}
}

async function isExecutable(filePath) {
	try {
		await fs.access(filePath, fsConstants.X_OK);
		return true;
	} catch {
		return false;
	}
}

async function hashFile(filePath) {
	const data = await fs.readFile(filePath);
	return createHash("sha256").update(data).digest("hex");
}

async function copyIfChanged(sourcePath, destinationPath) {
	const destinationExists = await exists(destinationPath);
	if (destinationExists) {
		const [sourceHash, destinationHash] = await Promise.all([hashFile(sourcePath), hashFile(destinationPath)]);
		if (sourceHash === destinationHash) {
			await fs.chmod(destinationPath, 0o755);
			return { changed: false };
		}
	}

	await fs.mkdir(path.dirname(destinationPath), { recursive: true });
	const tempPath = `${destinationPath}.tmp-${process.pid}-${Date.now()}`;
	await fs.copyFile(sourcePath, tempPath);
	await fs.chmod(tempPath, 0o755);
	await fs.rename(tempPath, destinationPath);
	return { changed: true };
}

async function run(command, commandArgs) {
	await new Promise((resolve, reject) => {
		const child = spawn(command, commandArgs, { stdio: "inherit" });
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) {
				resolve();
				return;
			}
			reject(new Error(`Command failed (${code}): ${command} ${commandArgs.join(" ")}`));
		});
	});
}

async function commandAvailable(command) {
	return await new Promise((resolve) => {
		const child = spawn("sh", ["-c", `command -v ${command} >/dev/null 2>&1`], { stdio: "ignore" });
		child.on("error", () => resolve(false));
		child.on("close", (code) => resolve(code === 0));
	});
}

async function linuxDependencyReport() {
	const [wmctrl, xdotool, xprop, importCommand, xwd, convert] = await Promise.all([
		commandAvailable("wmctrl"),
		commandAvailable("xdotool"),
		commandAvailable("xprop"),
		commandAvailable("import"),
		commandAvailable("xwd"),
		commandAvailable("convert"),
	]);

	const missing = [];
	if (!wmctrl) missing.push("wmctrl");
	if (!xdotool) missing.push("xdotool");
	if (!xprop) missing.push("xprop");
	if (!importCommand && !(xwd && convert)) {
		missing.push("ImageMagick import or xwd+convert");
	}

	const warnings = [];
	if (!process.env.DISPLAY) {
		warnings.push("DISPLAY is not set, so no X11 display is available.");
	}
	if (String(process.env.XDG_SESSION_TYPE || "").toLowerCase() === "wayland") {
		warnings.push("XDG_SESSION_TYPE=wayland was detected; Linux support currently requires X11/Xorg.");
	}

	return { missing, warnings };
}

async function validateLinuxSystemDependencies() {
	const { missing, warnings } = await linuxDependencyReport();
	const problems = [];
	if (missing.length > 0) problems.push(`Missing required command(s): ${missing.join(", ")}.`);
	problems.push(...warnings);
	if (problems.length === 0) return;

	const message = `[pi-computer-use] Linux/X11 prerequisite check failed:\n${problems.map((problem) => `- ${problem}`).join("\n")}\n${linuxInstallHint}`;
	if (isPostinstall) {
		console.warn(message);
		return;
	}
	throw new Error(message);
}

function moduleCachePath(arch) {
	return path.join(os.tmpdir(), `pi-computer-use-swift-module-cache-${arch}`);
}

async function signHelper(outputPath) {
	if (process.env.PI_COMPUTER_USE_NO_SIGN === "1") {
		return;
	}

	const identity = process.env.PI_COMPUTER_USE_CODESIGN_IDENTITY ?? "-";
	const identifier = process.env.PI_COMPUTER_USE_CODESIGN_IDENTIFIER ?? defaultCodeSignIdentifier;
	const commandArgs = ["--force", "-i", identifier, "--timestamp=none", "--sign", identity, outputPath];
	await run("codesign", commandArgs);
}

async function buildHelper(arch, outputPath) {
	if (!(await exists(helperSourcePath))) {
		throw new Error(`Native helper source not found at ${helperSourcePath}`);
	}

	await fs.mkdir(path.dirname(outputPath), { recursive: true });
	const swiftArgs = [
		"swiftc",
		"-target",
		archTargets[arch],
		"-module-cache-path",
		moduleCachePath(arch),
		"-O",
		"-framework",
		"ApplicationServices",
		"-framework",
		"AppKit",
		"-framework",
		"ScreenCaptureKit",
		"-framework",
		"Foundation",
		helperSourcePath,
		"-o",
		outputPath,
	];

	await run("xcrun", swiftArgs);
	await fs.chmod(outputPath, 0o755);
	await signHelper(outputPath);
}

async function setup() {
	if (process.platform === "linux") {
		if (!(await exists(linuxHelperSourcePath))) {
			throw new Error(`Linux helper source not found at ${linuxHelperSourcePath}`);
		}
		const { changed } = await copyIfChanged(linuxHelperSourcePath, helperDestPath);
		console.log(
			changed
				? `[pi-computer-use] installed Linux X11 helper to ${helperDestPath}`
				: `[pi-computer-use] Linux X11 helper already up to date at ${helperDestPath}`,
		);
		await validateLinuxSystemDependencies();
		return;
	}

	if (process.platform !== "darwin") {
		if (isPostinstall) {
			console.warn("[pi-computer-use] skipping helper setup: platform is not macOS or Linux.");
			return;
		}
		throw new Error("pi-computer-use helper is only supported on macOS and Linux/X11.");
	}

	const arch = normalizeArch(process.arch);
	const prebuiltPath = prebuiltPathForArch(arch);
	const prebuiltExists = await exists(prebuiltPath);

	if (prebuiltExists) {
		const { changed } = await copyIfChanged(prebuiltPath, helperDestPath);
		console.log(
			changed
				? `[pi-computer-use] installed helper from prebuilt (${arch}) to ${helperDestPath}`
				: `[pi-computer-use] helper already up to date at ${helperDestPath}`,
		);
		return;
	}

	if (await isExecutable(helperDestPath)) {
		console.log(`[pi-computer-use] using existing helper at ${helperDestPath}`);
		return;
	}

	if (allowBuildFallback) {
		console.log("[pi-computer-use] prebuilt helper missing; attempting source build with xcrun swiftc...");
		await buildHelper(arch, helperDestPath);
		console.log(`[pi-computer-use] built helper at ${helperDestPath}`);
		return;
	}

	throw new Error(
		`No prebuilt helper found for ${arch} at ${prebuiltPath}. Run 'node scripts/build-native.mjs --output ${helperDestPath}' to build locally.`,
	);
}

setup().catch((error) => {
	if (isPostinstall) {
		console.warn(`[pi-computer-use] postinstall helper setup skipped: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(0);
	}

	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
