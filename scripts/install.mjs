#!/usr/bin/env node
/**
 * Install dsh-app into the DeepSeek Harness desktop profile.
 *
 * The desktop profile lives under `$DSH_HOME/profiles/desktop` and is owned by
 * the app, so the installer edits exactly three things and nothing else:
 *
 *   package.json        dependency entry + `dsh.profile.bundles` membership
 *   cordis.patch.yml    the `insert` row that mounts the host half
 *   node_modules/dsh-app  a symlink to this repository
 *
 * Every file is backed up before the first edit and restored if any later step
 * throws. The app loads profile bundles at boot, so a restart is needed; the
 * script says so when it detects a live host.
 */
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const PACKAGE_NAME = "dsh-app";
const ROW_ID = "dsh-app";
const REPO = resolve(dirname(new URL(import.meta.url).pathname), "..");

/**
 * Resolve the desktop profile directory.
 * @returns absolute profile path.
 */
function profileDir() {
	const home = process.env.DSH_HOME?.trim() || join(homedir(), ".dsh");
	return join(home, "profiles", "desktop");
}

/**
 * Read a JSON file.
 * @param file - path.
 * @returns parsed value.
 */
function readJson(file) {
	return JSON.parse(readFileSync(file, "utf8"));
}

/**
 * Serialize JSON the way the desktop profile keeps it (two-space, trailing newline).
 * @param value - JSON value.
 * @returns file text.
 */
function writeJson(file, value) {
	writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Whether a live host announced itself for this profile.
 * @param profile - profile directory.
 * @returns true when host.json names a running process.
 */
function hostRunning(profile) {
	try {
		const host = readJson(join(profile, "host.json"));
		if (typeof host?.pid !== "number") return false;
		process.kill(host.pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Install the plugin, rolling back every edit on failure.
 * @param profile - desktop profile directory.
 * @returns nothing; throws on failure after restoring backups.
 */
function install(profile) {
	const packageFile = join(profile, "package.json");
	const patchFile = join(profile, "cordis.patch.yml");
	const modules = join(profile, "node_modules");
	const link = join(modules, PACKAGE_NAME);
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const backups = [];
	const created = [];
	const moved = [];

	if (!existsSync(packageFile)) throw new Error(`no profile at ${profile} (is the desktop app installed and started once?)`);

	/**
	 * Back up a file before the first edit.
	 * @param file - path.
	 * @param copy - backup path.
	 */
	const backup = (file, copy) => {
		if (existsSync(file)) {
			copyFileSync(file, copy);
			backups.push([copy, file]);
		}
	};

	backup(packageFile, `${packageFile}.dsh-app-${stamp}.bak`);
	backup(patchFile, `${patchFile}.dsh-app-${stamp}.bak`);

	try {
		const manifest = readJson(packageFile);
		manifest.dependencies ??= {};
		if (manifest.dependencies[PACKAGE_NAME] === undefined) manifest.dependencies[PACKAGE_NAME] = `file:${REPO}`;
		manifest.dsh ??= {};
		manifest.dsh.profile ??= {};
		manifest.dsh.profile.bundles ??= [];
		if (!manifest.dsh.profile.bundles.includes(PACKAGE_NAME)) manifest.dsh.profile.bundles.push(PACKAGE_NAME);
		writeJson(packageFile, manifest);

		let patch = existsSync(patchFile) ? readFileSync(patchFile, "utf8") : "";
		if (!/^\s*-?\s*name:\s*["']?dsh-app["']?\s*$/m.test(patch)) {
			patch = `${patch.trimEnd()}\n- insert:\n    - id: ${ROW_ID}\n      name: ${PACKAGE_NAME}\n`;
			writeFileSync(patchFile, patch);
		}

		mkdirSync(modules, { recursive: true });
		if (existsSync(link) || isSymlink(link)) {
			const previous = `${link}.dsh-app-backup-${stamp}`;
			if (isSymlink(link)) unlinkSync(link);
			else {
				renameSync(link, previous);
				moved.push([previous, link]);
			}
		}
		symlinkSync(REPO, link, "dir");
		created.push(link);

		// Validate what the loader will actually read.
		const check = readJson(packageFile);
		if (check.dependencies?.[PACKAGE_NAME] === undefined) throw new Error("package.json dependency was not recorded");
		if (!check.dsh.profile.bundles.includes(PACKAGE_NAME)) throw new Error("dsh.profile.bundles entry was not recorded");
		if (!existsSync(join(link, "lib", "index.js"))) throw new Error(`symlink ${link} does not resolve to the plugin`);
		if (!/name:\s*["']?dsh-app["']?\s*$/m.test(readFileSync(patchFile, "utf8"))) throw new Error("cordis.patch.yml row was not recorded");
	} catch (error) {
		for (const [copy, file] of backups) copyFileSync(copy, file);
		for (const [previous, file] of moved) renameSync(previous, file);
		for (const file of created) rmSync(file, { force: true });
		throw error;
	}

	return { backupCount: backups.length, stamp };
}

/**
 * Whether a path is a symlink (also for broken links).
 * @param path - filesystem path.
 * @returns true for symlinks.
 */
function isSymlink(path) {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
}

const profile = profileDir();
if (!existsSync(profile)) {
	process.stderr.write(`dsh-app: no desktop profile at ${profile}\nStart DeepSeek Harness once, then re-run this installer.\n`);
	process.exitCode = 1;
} else {
	let result;
	try {
		result = install(profile);
	} catch (error) {
		process.stderr.write(`dsh-app: ${error instanceof Error ? error.message : String(error)}\n`);
		process.stderr.write("No changes were kept: every edited file was restored from its backup.\n");
		process.exitCode = 1;
	}
	if (result !== undefined) {
		process.stdout.write(`dsh-app installed into ${profile}\n`);
		process.stdout.write(`  dependency  file:${REPO}\n`);
		process.stdout.write(`  profile     dsh.profile.bundles += dsh-app\n`);
		process.stdout.write(`  patch       cordis.patch.yml += insert dsh-app\n`);
		process.stdout.write(`  link        node_modules/dsh-app -> ${REPO}\n`);
		process.stdout.write(`  backups     ${String(result.backupCount)} file(s), stamp ${result.stamp}\n`);
		if (hostRunning(profile)) {
			process.stdout.write("\nThe app is running and loads profile bundles at boot: quit and reopen DeepSeek Harness.\n");
		}
	}
}
