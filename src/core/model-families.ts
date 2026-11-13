/**
 * Default model-picker view (fork, 2026-11-12; docs/fork/plans/01-small-fixes.md
 * §5a). Each provider shows the newest model of each family; "Show all
 * models" and search reach the rest. Pure: catalog entries in, the
 * default-visible subset out. The server catalog and saved selections are
 * unaffected.
 *
 * A family is the id with a trailing date stamp and its first version number
 * removed: `claude-opus-5-5` → `claude-opus-#` at 5.5, `gpt-6.1-terra` →
 * `gpt-#-terra` at 6.1. This is a naming heuristic, checked against the
 * Anthropic and OpenAI catalogs; an id it cannot parse is always shown.
 */

const DATE_SUFFIX = /-(\d{8}|\d{4}-\d{2}-\d{2})$/;
const VERSION = /\d+(?:[.-]\d+)*/;

interface FamilyMember {
	family: string;
	version: number[];
	dated: boolean;
}

function familyOf(id: string): FamilyMember | null {
	const dated = DATE_SUFFIX.test(id);
	const base = id.replace(DATE_SUFFIX, "");
	const match = VERSION.exec(base);
	if (!match) return null;
	return {
		family: base.slice(0, match.index) + "#" + base.slice(match.index + match[0].length),
		version: match[0].split(/[.-]/).map(Number),
		dated,
	};
}

/** Positive when `a` should be preferred: higher version, then undated. */
function compareMembers(a: FamilyMember, b: FamilyMember): number {
	const length = Math.max(a.version.length, b.version.length);
	for (let i = 0; i < length; i++) {
		const difference = (a.version[i] ?? 0) - (b.version[i] ?? 0);
		if (difference !== 0) return difference;
	}
	return Number(b.dated) - Number(a.dated);
}

export interface DefaultViewOptions {
	/** Providers whose default view is only their unversioned aliases (the
	 *  Claude Code CLI's `opus`/`sonnet`/...); versioned ids stay under Show all. */
	aliasOnlyProviders?: ReadonlySet<string>;
}

/** The entries shown when the picker is not searching and Show all is off. */
export function defaultVisibleModels<T extends { provider: string; id: string; unverified?: boolean }>(
	models: readonly T[],
	options: DefaultViewOptions = {},
): Set<T> {
	const visible = new Set<T>();
	const newest = new Map<string, { entry: T; member: FamilyMember }>();
	for (const entry of models) {
		if (entry.unverified) continue;
		const member = familyOf(entry.id);
		if (!member) {
			visible.add(entry);
			continue;
		}
		if (options.aliasOnlyProviders?.has(entry.provider)) continue;
		const key = `${entry.provider}\u0000${member.family}`;
		const current = newest.get(key);
		if (!current || compareMembers(member, current.member) > 0) newest.set(key, { entry, member });
	}
	for (const { entry } of newest.values()) visible.add(entry);
	return visible;
}
