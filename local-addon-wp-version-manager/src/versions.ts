// Pure version logic for the WordPress Version Manager add-on.
// No Electron / @getflywheel dependencies, so this module is unit-testable in plain Node.
import https from 'https';

// Returns { "<version>": "latest" | "outdated" | "insecure", ... } for every stable release.
export const STABLE_CHECK_URL = 'https://api.wordpress.org/core/stable-check/1.0/';
// Returns the current beta / release-candidate offer(s).
export const BETA_CHECK_URL = 'https://api.wordpress.org/core/version-check/1.7/?channel=beta';
// Rolling nightly build ("bleeding edge").
export const NIGHTLY_ZIP_URL = 'https://wordpress.org/nightly-builds/wordpress-latest.zip';

export interface VersionInfo {
	version: string;
	// 'latest' | 'outdated' | 'insecure' | 'beta' | 'nightly'
	status: string;
	// Optional explicit download URL (used for nightly / some betas).
	download?: string;
}

// Accepts stable, beta/RC/alpha, and "nightly" version strings.
const VERSION_RE = /^(nightly|\d+(\.\d+){0,2}(-(?:alpha|beta|rc)\d*)?)$/i;

/** Numeric, segment-by-segment comparison of the leading x.y.z part. Returns <0, 0, or >0. */
export function compareVersions (a: string, b: string): number {
	const numeric = (s: string) => s.split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
	const pa = numeric(a);
	const pb = numeric(b);
	const len = Math.max(pa.length, pb.length);
	for (let i = 0; i < len; i++) {
		const diff = (pa[i] || 0) - (pb[i] || 0);
		if (diff !== 0) {
			return diff;
		}
	}
	// Same base version: a pre-release (has a "-") sorts below the final release.
	const preA = a.includes('-');
	const preB = b.includes('-');
	if (preA !== preB) {
		return preA ? -1 : 1;
	}
	return 0;
}

/**
 * GET a URL and JSON-parse the body.
 * Prefers Electron's net.fetch (Chromium network stack — proxy-aware, robust
 * happy-eyeballs) because Node's https stack can dead-end on hosts whose
 * resolved IP is unreachable. Falls back to Node https outside Electron (tests).
 */
export async function httpsGetJson (url: string): Promise<any> {
	try {
		// eslint-disable-next-line global-require
		const { net } = require('electron');
		if (net?.fetch) {
			const res = await net.fetch(url);
			if (!res.ok) {
				throw new Error(`WordPress.org API returned HTTP ${res.status} for ${url}`);
			}
			return await res.json();
		}
	} catch (err: any) {
		// Only fall through to Node https when Electron isn't available at all.
		if (err?.code !== 'MODULE_NOT_FOUND') {
			throw err;
		}
	}
	return nodeHttpsGetJson(url);
}

/** Node-https fallback used outside Electron (e.g. unit tests). */
function nodeHttpsGetJson (url: string): Promise<any> {
	return new Promise((resolve, reject) => {
		https
			.get(url, (res) => {
				if (res.statusCode !== 200) {
					res.resume();
					reject(new Error(`WordPress.org API returned HTTP ${res.statusCode} for ${url}`));
					return;
				}

				let raw = '';
				res.setEncoding('utf8');
				res.on('data', (chunk) => {
					raw += chunk;
				});
				res.on('end', () => {
					try {
						resolve(JSON.parse(raw));
					} catch (err) {
						reject(err);
					}
				});
			})
			.on('error', reject);
	});
}

/**
 * Fetch every WordPress release the site can be switched to:
 * nightly + current beta/RC + every stable release, newest first.
 */
export async function fetchAllVersions (): Promise<VersionInfo[]> {
	// Stable releases are the reliable core of the list; betas are best-effort.
	const stableMap = (await httpsGetJson(STABLE_CHECK_URL)) as Record<string, string>;
	const stable: VersionInfo[] = Object.keys(stableMap).map((v) => ({ version: v, status: stableMap[v] }));

	const seen = new Set(stable.map((v) => v.version));
	const preRelease: VersionInfo[] = [];

	try {
		const beta = await httpsGetJson(BETA_CHECK_URL);
		for (const offer of beta?.offers || []) {
			if (offer?.version && !seen.has(offer.version)) {
				seen.add(offer.version);
				preRelease.push({ version: offer.version, status: 'beta', download: offer.download });
			}
		}
	} catch (err) {
		// Beta channel is optional — ignore failures and keep the stable list.
	}

	preRelease.sort((a, b) => compareVersions(b.version, a.version));
	stable.sort((a, b) => compareVersions(b.version, a.version));

	return [
		{ version: 'nightly', status: 'nightly', download: NIGHTLY_ZIP_URL },
		...preRelease,
		...stable,
	];
}

/** Turn a requested target into the WP-CLI `core update` arguments that install it. */
export function buildUpdateArgs (target: string): string[] {
	const value = target.trim();

	// A direct .zip URL (nightly, a specific beta build, etc.) — must be on wordpress.org.
	if (/^https?:\/\//i.test(value)) {
		let host: string;
		try {
			host = new URL(value).hostname.toLowerCase();
		} catch (err) {
			throw new Error(`Not a valid URL: "${value}".`);
		}
		if (host !== 'wordpress.org' && !host.endsWith('.wordpress.org')) {
			throw new Error('Only wordpress.org .zip URLs are allowed.');
		}
		if (!/\.zip$/i.test(value)) {
			throw new Error('A URL target must point to a .zip file.');
		}
		return ['core', 'update', value, '--force'];
	}

	if (value.toLowerCase() === 'nightly') {
		return ['core', 'update', NIGHTLY_ZIP_URL, '--force'];
	}

	if (!VERSION_RE.test(value)) {
		throw new Error(`Invalid version string: "${value}". Use e.g. 6.5.2, 6.6-RC1, or a wordpress.org .zip URL.`);
	}

	return ['core', 'update', `--version=${value}`, '--force'];
}
