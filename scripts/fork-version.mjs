// Fork: prints the fork's display version, e.g. "0.6.1-fork.1". package.json
// "version" stays upstream's numeric base, which plugin compatibility checks
// require; "forkRelease" counts fork releases on that base. next.config.ts
// builds LH_VERSION the same way (tests/desktop-platform.test.ts pins both).
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
if (!/^\d+\.\d+\.\d+$/.test(pkg.version) || !Number.isInteger(pkg.forkRelease) || pkg.forkRelease < 1) {
	throw new Error("package.json needs a numeric x.y.z version and a positive integer forkRelease");
}
console.log(`${pkg.version}-fork.${pkg.forkRelease}`);
