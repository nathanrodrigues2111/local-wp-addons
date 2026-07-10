// Copy one site's setup (database + wp-content) onto variant sites, rewriting
// URLs for each target, and optionally pinning each variant to a WordPress version.
import path from 'path';
import os from 'os';
import fs from 'fs-extra';
import * as Local from '@getflywheel/local';
import * as LocalMain from '@getflywheel/local/main';

export type ProgressFn = (step: number, total: number, label: string) => void;

const publicDir = (site: Local.Site) => path.join(LocalMain.formatHomePath(site.path), 'app', 'public');
const wpContentDir = (site: Local.Site) => path.join(publicDir(site), 'wp-content');

const VERSION_RE = /^(nightly|\d+(\.\d+){0,2}(-(?:alpha|beta|rc)\d*)?)$/i;

export interface VariantSpec {
	siteId: string;
	wpVersion?: string; // optional: pin this variant to a WP core version
}

export async function syncSetup (
	wpCli: LocalMain.Services.WpCli,
	siteDatabase: LocalMain.Services.SiteDatabase,
	importSQLFile: (site: Local.Site, sqlFile: string) => Promise<string>,
	source: Local.Site,
	targets: { site: Local.Site; wpVersion?: string }[],
	onProgress?: ProgressFn,
): Promise<string[]> {
	const results: string[] = [];
	const total = 1 + targets.length * 4;
	let step = 0;

	// One source dump reused for every target.
	const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'matrix-sync-'));
	try {
		onProgress?.(++step, total, `Dumping ${source.name} database…`);
		const dbFile = path.join(tmp, 'source.sql');
		await siteDatabase.dump(source, dbFile);

		for (const { site: target, wpVersion } of targets) {
			onProgress?.(++step, total, `${target.name}: copying wp-content…`);
			const dest = wpContentDir(target);
			const backup = `${dest}.pre-sync`;
			await fs.remove(backup);
			await fs.move(dest, backup);
			try {
				await fs.copy(wpContentDir(source), dest, {
					filter: (src) => !src.includes(`${path.sep}cache${path.sep}`) && !src.endsWith(`${path.sep}cache`),
				});
				await fs.remove(backup);
			} catch (err) {
				await fs.remove(dest).catch(() => undefined);
				await fs.move(backup, dest).catch(() => undefined);
				throw err;
			}

			onProgress?.(++step, total, `${target.name}: importing database…`);
			await importSQLFile(target, dbFile);

			onProgress?.(++step, total, `${target.name}: rewriting URLs…`);
			// Covers http/https and protocol-relative references in one pass.
			await wpCli.run(target, ['search-replace', `//${source.domain}`, `//${target.domain}`, '--all-tables', '--skip-plugins', '--skip-themes']);
			await wpCli.run(target, ['cache', 'flush']).catch(() => undefined);

			if (wpVersion && VERSION_RE.test(wpVersion.trim())) {
				onProgress?.(++step, total, `${target.name}: setting WordPress ${wpVersion}…`);
				await wpCli.run(target, ['core', 'update', `--version=${wpVersion.trim()}`, '--force']);
				await wpCli.run(target, ['core', 'update-db']);
			} else {
				++step;
			}

			const v = (await wpCli.run(target, ['core', 'version'])).trim();
			results.push(`${target.name}: synced, WordPress ${v}`);
		}
	} finally {
		await fs.remove(tmp).catch(() => undefined);
	}
	return results;
}
