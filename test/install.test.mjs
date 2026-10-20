import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const installer = new URL("../scripts/install.mjs", import.meta.url).pathname;

/**
 * Run the installer against a private DSH_HOME.
 * @param home - fake DSH_HOME.
 * @returns the spawn result.
 */
function install(home) {
	return spawnSync(process.execPath, [installer], { env: { ...process.env, DSH_HOME: home }, encoding: "utf8" });
}

/**
 * Create a fake desktop profile.
 * @param manifest - package.json content.
 * @param patch - cordis.patch.yml content, or null for absent.
 * @returns DSH_HOME path.
 */
function home(manifest, patch = null) {
	const root = mkdtempSync(join(tmpdir(), "dsh-app-install-"));
	const profile = join(root, "profiles", "desktop");
	mkdirSync(profile, { recursive: true });
	writeFileSync(join(profile, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
	if (patch !== null) writeFileSync(join(profile, "cordis.patch.yml"), patch);
	return root;
}

test("a fresh profile gains the dependency, bundle row, patch row and symlink", () => {
	const root = home({ name: "p", dependencies: { dshmarket: "^1.66.7" }, dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"] } } });
	const result = install(root);
	assert.equal(result.status, 0, result.stderr);
	const profile = join(root, "profiles", "desktop");
	const manifest = JSON.parse(readFileSync(join(profile, "package.json"), "utf8"));
	assert.match(manifest.dependencies["dsh-app"], /^file:/);
	assert.deepEqual(manifest.dsh.profile.bundles, ["@deepseek-ai/dsh-base", "dsh-app"]);
	const patch = readFileSync(join(profile, "cordis.patch.yml"), "utf8");
	assert.match(patch, /- insert:\n    - id: dsh-app\n      name: dsh-app/);
	assert.ok(readlinkSync(join(profile, "node_modules", "dsh-app")).endsWith("dsh-app"));
	assert.match(result.stdout, /installed into/);
});

test("installing twice keeps the profile free of duplicates", () => {
	const root = home({ name: "p", dependencies: {}, dsh: { profile: { bundles: [] } } }, "# empty\n");
	assert.equal(install(root).status, 0);
	assert.equal(install(root).status, 0);
	const profile = join(root, "profiles", "desktop");
	const manifest = JSON.parse(readFileSync(join(profile, "package.json"), "utf8"));
	assert.deepEqual(manifest.dsh.profile.bundles, ["dsh-app"]);
	const patch = readFileSync(join(profile, "cordis.patch.yml"), "utf8");
	assert.equal((patch.match(/name: dsh-app/g) ?? []).length, 1);
});

test("a missing profile is reported without touching anything", () => {
	const root = mkdtempSync(join(tmpdir(), "dsh-app-install-"));
	const result = install(root);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /no desktop profile/);
});

test("a failure restores the edited files", () => {
	const root = home({ name: "p", dependencies: {} });
	const profile = join(root, "profiles", "desktop");
	writeFileSync(join(profile, "node_modules"), "not a directory");
	const result = install(root);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /No changes were kept/);
	const manifest = JSON.parse(readFileSync(join(profile, "package.json"), "utf8"));
	assert.equal(manifest.dependencies["dsh-app"], undefined);
	assert.equal(manifest.dsh, undefined);
	assert.equal(existsSync(join(profile, "node_modules", "dsh-app")), false);
});
