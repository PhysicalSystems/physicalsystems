import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const readJson = async (name) =>
	JSON.parse(await readFile(join(packageDir, name), "utf8"));

const manifest = await readJson("package.json");
const shrinkwrap = await readJson("npm-shrinkwrap.json");

const expectedDependencies = {
	"@earendil-works/pi-agent-core": "0.84.2",
	"@earendil-works/pi-ai": "0.84.2",
	"@earendil-works/pi-client": "0.84.2",
	"@earendil-works/pi-protocol": "0.84.2",
	"@earendil-works/pi-tui": "0.84.2",
	chalk: "5.6.2",
	"cross-spawn": "7.0.6",
	diff: "8.0.4",
	glob: "13.0.6",
	"grok-mermaid": "0.2.2",
	"highlight.js": "10.7.3",
	"hosted-git-info": "9.0.3",
	ignore: "7.0.5",
	jiti: "2.7.0",
	minimatch: "10.2.5",
	"proper-lockfile": "4.1.2",
	semver: "7.8.0",
	typebox: "1.3.7",
	undici: "8.9.0",
	yaml: "2.9.0",
};
const expectedPeers = {
	"@mariozechner/clipboard": "0.3.9",
	"@silvia-odwyer/photon-node": "0.3.4",
};
const expectedPeerMeta = Object.fromEntries(
	Object.keys(expectedPeers).map((name) => [name, { optional: true }]),
);
const reviewedPiIntegrities = {
	"node_modules/@earendil-works/pi-agent-core":
		"sha512-8Pn3wSCxj0cfo5I6jxQYVB/3uuQRmHhAlEclyjqpOuMEdQMIODHizRogv56FLdbU+dTiGnybeHQ2N+sV1/L2YA==",
	"node_modules/@earendil-works/pi-ai":
		"sha512-6MzsrYIYNVlE7SfpbL2yYb67Qo58p/7Q+xWG1RZvoX1P80aRCHSod2/13aFpxkow1lPO2LEh3c495J0Gwmyjig==",
	"node_modules/@earendil-works/pi-client":
		"sha512-/RFSPhD/bZbpOp1oJj+UneSUFSgZhWxzcSENUY+8+8xhoBrWXMYI2t77XNx4Yf+c8YK2qTHquForhNcelYpXvg==",
	"node_modules/@earendil-works/pi-protocol":
		"sha512-jbBh03fkeckWEroHpcZBr4w5/Ibat8WwdXFlXHivYQImrQNFtLpDeL0t1cku4hmK0q3pceIRQHkw4fwbM4YILQ==",
	"node_modules/@earendil-works/pi-telemetry":
		"sha512-wg5caea7uIv1BHRBm2Y116RvFG4oSAiP5qk9tA2463PDGIr4K8M1Ceyyg5DOpF/shUUl0gk826yQJAeAcHYB9g==",
	"node_modules/@earendil-works/pi-tui":
		"sha512-ds2TLihOnM5sLJB3VpXV6y0uR5efVuHf4MN7yDpsty6hA2DUO/EDVzjp/0od0G2JslzVLMjT8T8zavtxVb+qbg==",
};
const auditedUpstream = {
	package: "@earendil-works/pi-coding-agent@0.84.2",
	integrity:
		"sha512-l4E+B7hgXKWddRo8bC/eSue2aWZjEgJ9xIpf5p0Og+lq8a2TArCwJ0HCoCPCgaBP/tN4zbYH/wOwvx9pJpeLCA==",
	retainedNodeCount: 127,
	retainedClosureWithoutSriHardeningSha256:
		"4d2900c140b4fca37471fe0c2057835768cb4c443eecbb2ffd554032b3de5eb1",
	hardenedClosureSha256:
		"627185623a6c6fc6e6427ba2ef2a9ec9007068dcf052cabd9dbfe4dad9e42523",
	retainedSourceFileCount: 837,
	retainedSourceTreeSha256:
		"2a47a2cd5f18798e65cf709b4d1b3d51a3181ed6b9cb65858d90d72ddc144172",
	packedRuntimeFileCount: 439,
	packedRuntimeTreeSha256:
		"efdbacde19b08f9fa63d69cb67710172502366ec1401447426620ce0e9fb8984",
};

assert.equal(manifest.name, "@tinyedge/pi-runtime");
assert.equal(manifest.version, "0.84.2-tinyedge.1");
assert.equal(manifest.license, "MIT");
assert.equal("bin" in manifest, false, "compatibility package must not install a command");
assert.deepEqual(manifest.dependencies, expectedDependencies);
assert.deepEqual(manifest.peerDependencies, expectedPeers);
assert.deepEqual(manifest.peerDependenciesMeta, expectedPeerMeta);
assert.equal(manifest.optionalDependencies, undefined);
assert.equal(manifest.devDependencies, undefined);

assert.equal(shrinkwrap.lockfileVersion, 3);
const root = shrinkwrap.packages?.[""];
assert.ok(root, "shrinkwrap must contain a root package record");
assert.equal(root.name, manifest.name);
assert.equal(root.version, manifest.version);
assert.equal(root.license, manifest.license);
assert.equal("bin" in root, false);
assert.deepEqual(root.dependencies, expectedDependencies);
assert.deepEqual(root.engines, manifest.engines);
assert.deepEqual(root.peerDependencies, expectedPeers);
assert.deepEqual(root.peerDependenciesMeta, expectedPeerMeta);
assert.equal(root.optionalDependencies, undefined);
assert.equal(root.devDependencies, undefined);

const bannedNodePatterns = [
	/(?:^|\/)node_modules\/@mariozechner\/clipboard(?:-|$)/,
	/(?:^|\/)node_modules\/@silvia-odwyer\/photon-node(?:\/|$)/,
];
for (const [packagePath, metadata] of Object.entries(shrinkwrap.packages ?? {})) {
	if (packagePath === "") continue;
	assert.equal(
		bannedNodePatterns.some((pattern) => pattern.test(packagePath)),
		false,
		`native optional peer must not have a shrinkwrap node: ${packagePath}`,
	);
	assert.notEqual(metadata.dev, true, `development-only lock node: ${packagePath}`);
	assert.notEqual(
		metadata.devOptional,
		true,
		`development-optional lock node: ${packagePath}`,
	);
}

const retainedClosure = Object.fromEntries(
	Object.entries(shrinkwrap.packages)
		.filter(([packagePath]) => packagePath !== "")
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
);
assert.equal(
	Object.keys(retainedClosure).length,
	auditedUpstream.retainedNodeCount,
	`runtime closure must retain only the audited nodes from ${auditedUpstream.package}`,
);
for (const [packagePath, integrity] of Object.entries(reviewedPiIntegrities)) {
	assert.equal(
		retainedClosure[packagePath]?.integrity,
		integrity,
		`missing reviewed SRI hardening for ${packagePath}`,
	);
}
const upstreamComparableClosure = structuredClone(retainedClosure);
for (const packagePath of Object.keys(reviewedPiIntegrities)) {
	delete upstreamComparableClosure[packagePath].integrity;
}
assert.equal(
	createHash("sha256")
		.update(JSON.stringify(upstreamComparableClosure))
		.digest("hex"),
	auditedUpstream.retainedClosureWithoutSriHardeningSha256,
	`runtime closure drifted from verified ${auditedUpstream.package} beyond the six explicit SRI hardenings (${auditedUpstream.integrity})`,
);
assert.equal(
	createHash("sha256").update(JSON.stringify(retainedClosure)).digest("hex"),
	auditedUpstream.hardenedClosureSha256,
	"runtime closure or one of its six reviewed SRI hardenings drifted",
);

const vendorHashes = {
	"dist/core/export-html/vendor/highlight.min.js":
		"837a6fa5b0c736b52bbde2b2b6190f305da3fc9ed41681db5321507057b5c846",
	"dist/core/export-html/vendor/marked.min.js":
		"d5487edc7258b404bfa74c393d74a6393155f02517bd5e7e77cd64f8187f39a0",
};
for (const [path, expectedHash] of Object.entries(vendorHashes)) {
	const bytes = await readFile(join(packageDir, ...path.split("/")));
	assert.equal(createHash("sha256").update(bytes).digest("hex"), expectedHash);
}
const upstreamReadme = await readFile(join(packageDir, "UPSTREAM_README.md"));
assert.equal(
	createHash("sha256").update(upstreamReadme).digest("hex"),
	"ce0f95c3d314dcacb5f2388b956880a86736ede3c383fd1f8e91bf9056aa134d",
);

const forbiddenFilePattern = /\.(?:wasm|node|dll|exe|so|dylib|ttf|otf|woff2?|eot|png|jpe?g|gif|webp|svg)$/i;
const walk = async (dir) => {
	const files = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		if (entry.name === "node_modules") continue;
		const path = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...(await walk(path)));
		else files.push(path);
	}
	return files;
};
const packageFiles = await walk(packageDir);
const forbiddenFiles = packageFiles.filter((path) =>
	forbiddenFilePattern.test(path),
);
assert.deepEqual(
	forbiddenFiles,
	[],
	"package must not contain opaque native, font, or unlicensed image payloads",
);
const packageRelativePaths = packageFiles.map((path) =>
	relative(packageDir, path).replaceAll("\\", "/"),
);
const sourceMode = packageRelativePaths.includes("dist/.npmignore");
const sourceMaps = packageRelativePaths.filter((path) => path.endsWith(".map"));
if (sourceMode) {
	assert.equal(
		sourceMaps.length,
		398,
		"the public source mirror must retain the exact upstream source maps",
	);
	assert.equal(
		await readFile(join(packageDir, "dist", ".npmignore"), "utf8"),
		"**/*.map\n",
		"the npm artifact must exclude the retained source maps",
	);
} else {
	assert.equal(sourceMaps.length, 0, "the npm artifact must omit source maps");
}

const retainedPayload = [];
for (const [index, path] of packageRelativePaths.entries()) {
	if (
		!((path.startsWith("dist/") && path !== "dist/.npmignore")
			|| path.startsWith("docs/")
			|| path === "CHANGELOG.md"
			|| path === "UPSTREAM_README.md")
	) {
		continue;
	}
	const upstreamPath = path === "UPSTREAM_README.md" ? "README.md" : path;
	const digest = createHash("sha256")
		.update(await readFile(packageFiles[index]))
		.digest("hex");
	retainedPayload.push([upstreamPath, digest]);
}
retainedPayload.sort(([left], [right]) =>
	left < right ? -1 : left > right ? 1 : 0,
);
const retainedPayloadIndex = retainedPayload
	.map(([path, digest]) => `${digest}  ${path}\n`)
	.join("");
const expectedPayload = sourceMode
	? {
		count: auditedUpstream.retainedSourceFileCount,
		digest: auditedUpstream.retainedSourceTreeSha256,
		label: "public source mirror",
	}
	: {
		count: auditedUpstream.packedRuntimeFileCount,
		digest: auditedUpstream.packedRuntimeTreeSha256,
		label: "packed runtime",
	};
assert.equal(
	retainedPayload.length,
	expectedPayload.count,
	`${expectedPayload.label} retained upstream file count drifted`,
);
assert.equal(
	createHash("sha256").update(retainedPayloadIndex, "utf8").digest("hex"),
	expectedPayload.digest,
	`${expectedPayload.label} drifted from ${auditedUpstream.package}`,
);

console.error(
	`verified ${manifest.name}@${manifest.version}: ${Object.keys(shrinkwrap.packages).length - 1} exact upstream dependency nodes plus six explicit SRI hardenings; no clipboard or Photon install edge and no native, WASM, font, or unlicensed image payload inside this runtime package`,
);
