// Full site-state snapshots: database dump + wp-content copy + metadata.
// Stored under <site>/site-snapshots/<slug>/:
//   meta.json        { name, date, wpVersion }
//   db.sql           database dump (via Local's siteDatabase service)
//   wp-content/      full copy of app/public/wp-content
import path from 'path';
import fs from 'fs-extra';
import * as Local from '@getflywheel/local';
import * as LocalMain from '@getflywheel/local/main';

export interface SnapshotInfo {
	slug: string;
	name: string;
	date: number;
	wpVersion: string;
	sizeBytes: number;
}

export type ProgressFn = (step: number, total: number, label: string) => void;

const sitePath = (site: Local.Site) => LocalMain.formatHomePath(site.path);
const snapshotsRoot = (site: Local.Site) => path.join(sitePath(site), 'site-snapshots');
const wpContentDir = (site: Local.Site) => path.join(sitePath(site), 'app', 'public', 'wp-content');

const slugify = (s: string) =>
	String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'snapshot';

async function dirSize (dir: string): Promise<number> {
	let total = 0;
	let entries: any[] = [];
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch (err) {
		return 0;
	}
	for (const e of entries) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) {
			total += await dirSize(p);
		} else if (e.isFile()) {
			total += (await fs.stat(p)).size;
		}
	}
	return total;
}

export async function listSnapshots (site: Local.Site): Promise<SnapshotInfo[]> {
	const root = snapshotsRoot(site);
	await fs.ensureDir(root);
	const out: SnapshotInfo[] = [];
	for (const slug of await fs.readdir(root)) {
		const metaFile = path.join(root, slug, 'meta.json');
		if (!(await fs.pathExists(metaFile))) {
			continue;
		}
		try {
			const meta = await fs.readJson(metaFile);
			out.push({
				slug,
				name: meta.name || slug,
				date: meta.date || 0,
				wpVersion: meta.wpVersion || 'unknown',
				sizeBytes: meta.sizeBytes || 0,
			});
		} catch (err) {
			// Skip corrupt snapshots rather than breaking the list.
		}
	}
	out.sort((a, b) => b.date - a.date);
	return out;
}

export async function createSnapshot (
	wpCli: LocalMain.Services.WpCli,
	siteDatabase: LocalMain.Services.SiteDatabase,
	site: Local.Site,
	name: string,
	onProgress?: ProgressFn,
): Promise<SnapshotInfo> {
	const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
	const slug = `${slugify(name)}-${stamp}`;
	const dir = path.join(snapshotsRoot(site), slug);
	await fs.ensureDir(dir);

	try {
		onProgress?.(1, 3, 'Dumping database…');
		const wpVersion = (await wpCli.run(site, ['core', 'version'])).trim();
		await siteDatabase.dump(site, path.join(dir, 'db.sql'));

		onProgress?.(2, 3, 'Copying wp-content (plugins, themes, uploads)…');
		await fs.copy(wpContentDir(site), path.join(dir, 'wp-content'), {
			filter: (src) => !src.includes(`${path.sep}cache${path.sep}`) && !src.endsWith(`${path.sep}cache`),
		});

		onProgress?.(3, 3, 'Finalizing…');
		const sizeBytes = await dirSize(dir);
		const meta = { name, slug, date: Date.now(), wpVersion, sizeBytes };
		await fs.writeJson(path.join(dir, 'meta.json'), meta, { spaces: 2 });

		return meta as SnapshotInfo;
	} catch (err) {
		// Don't leave half-written snapshots behind.
		await fs.remove(dir).catch(() => undefined);
		throw err;
	}
}

export async function restoreSnapshot (
	wpCli: LocalMain.Services.WpCli,
	importSQLFile: (site: Local.Site, sqlFile: string) => Promise<string>,
	site: Local.Site,
	slug: string,
	onProgress?: ProgressFn,
): Promise<{ newVersion: string; name: string }> {
	const dir = path.join(snapshotsRoot(site), path.basename(slug));
	const metaFile = path.join(dir, 'meta.json');
	if (!(await fs.pathExists(metaFile))) {
		throw new Error(`Snapshot not found: ${slug}`);
	}
	const meta = await fs.readJson(metaFile);

	onProgress?.(1, 4, 'Restoring wp-content…');
	const target = wpContentDir(site);
	const backup = `${target}.pre-restore`;
	await fs.remove(backup);
	await fs.move(target, backup); // keep the old wp-content until the copy succeeds
	try {
		await fs.copy(path.join(dir, 'wp-content'), target);
		await fs.remove(backup);
	} catch (err) {
		await fs.remove(target).catch(() => undefined);
		await fs.move(backup, target).catch(() => undefined); // roll back
		throw err;
	}

	onProgress?.(2, 4, 'Importing database…');
	await importSQLFile(site, path.join(dir, 'db.sql'));

	if (meta.wpVersion && /^\d/.test(meta.wpVersion)) {
		onProgress?.(3, 4, `Matching WordPress core (${meta.wpVersion})…`);
		const currentVersion = (await wpCli.run(site, ['core', 'version'])).trim();
		if (currentVersion !== meta.wpVersion) {
			await wpCli.run(site, ['core', 'update', `--version=${meta.wpVersion}`, '--force']);
		}
	}

	onProgress?.(4, 4, 'Verifying…');
	const newVersion = (await wpCli.run(site, ['core', 'version'])).trim();
	return { newVersion, name: meta.name || slug };
}

export async function deleteSnapshot (site: Local.Site, slug: string): Promise<void> {
	await fs.remove(path.join(snapshotsRoot(site), path.basename(slug)));
}
