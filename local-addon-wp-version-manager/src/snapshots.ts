// Database snapshots taken before WordPress version switches.
// Stored as plain .sql dumps in <site>/app/wp-version-snapshots/, with the
// WordPress version and a note encoded in the filename:
//   2026-07-10T15-30-00_wp-7.0_before-6.9.4.sql
import path from 'path';
import fs from 'fs-extra';
import * as Local from '@getflywheel/local';
import * as LocalMain from '@getflywheel/local/main';

export interface SnapshotInfo {
	filename: string;
	wpVersion: string;
	note: string;
	date: number;
	size: number;
}

export function getSnapshotDir (site: Local.Site): string {
	return path.join(LocalMain.formatHomePath(site.path), 'app', 'wp-version-snapshots');
}

const sanitize = (s: string) => String(s).replace(/[^a-zA-Z0-9.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

/** Parse "<stamp>_wp-<version>_<note>.sql" back into its parts. */
function parseFilename (filename: string): { wpVersion: string; note: string } {
	const m = filename.match(/_wp-([^_]+)_(.*)\.sql$/);
	return { wpVersion: m ? m[1] : 'unknown', note: m ? m[2].replace(/-/g, ' ') : '' };
}

export async function listSnapshots (site: Local.Site): Promise<SnapshotInfo[]> {
	const dir = getSnapshotDir(site);
	await fs.ensureDir(dir);
	const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.sql'));
	const out: SnapshotInfo[] = [];
	for (const filename of files) {
		const stat = await fs.stat(path.join(dir, filename));
		out.push({ filename, ...parseFilename(filename), date: stat.mtimeMs, size: stat.size });
	}
	out.sort((a, b) => b.date - a.date);
	return out;
}

export async function createSnapshot (
	wpCli: LocalMain.Services.WpCli,
	siteDatabase: LocalMain.Services.SiteDatabase,
	site: Local.Site,
	note: string,
): Promise<SnapshotInfo> {
	const dir = getSnapshotDir(site);
	await fs.ensureDir(dir);

	const wpVersion = (await wpCli.run(site, ['core', 'version'])).trim();
	const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
	const filename = `${stamp}_wp-${sanitize(wpVersion)}_${sanitize(note || 'manual')}.sql`;
	const file = path.join(dir, filename);

	// Local's own dump service — wp db export would need mysqldump on PATH.
	await siteDatabase.dump(site, file);

	const stat = await fs.stat(file);
	return { filename, wpVersion, note: note || 'manual', date: stat.mtimeMs, size: stat.size };
}

/** Restore = import the DB dump, then put core back on the snapshot's WordPress version. */
export async function restoreSnapshot (
	wpCli: LocalMain.Services.WpCli,
	importSQLFile: (site: Local.Site, sqlFile: string) => Promise<string>,
	site: Local.Site,
	filename: string,
	onProgress?: (step: number, total: number, label: string) => void,
): Promise<string> {
	const file = path.join(getSnapshotDir(site), path.basename(filename));
	if (!(await fs.pathExists(file))) {
		throw new Error(`Snapshot not found: ${filename}`);
	}

	const { wpVersion } = parseFilename(filename);
	onProgress?.(1, 3, 'Importing database snapshot…');
	await importSQLFile(site, file);
	if (wpVersion !== 'unknown' && /^\d/.test(wpVersion)) {
		onProgress?.(2, 3, `Reinstalling WordPress ${wpVersion}…`);
		await wpCli.run(site, ['core', 'update', `--version=${wpVersion}`, '--force']);
	}
	onProgress?.(3, 3, 'Verifying…');
	return (await wpCli.run(site, ['core', 'version'])).trim();
}

export async function deleteSnapshot (site: Local.Site, filename: string): Promise<void> {
	await fs.remove(path.join(getSnapshotDir(site), path.basename(filename)));
}
