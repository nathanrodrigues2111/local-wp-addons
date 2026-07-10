// Main-process entry for the WordPress Version Manager add-on.
// API reference: https://getflywheel.github.io/local-addon-api/modules/_local_main_.html
import * as Local from '@getflywheel/local';
import * as LocalMain from '@getflywheel/local/main';
import { VersionInfo, fetchAllVersions, buildUpdateArgs } from './versions';
import { listSnapshots, createSnapshot, restoreSnapshot, deleteSnapshot } from './snapshots';

const ADDON_SLUG = 'wp-version-manager';

export default function (context: LocalMain.AddonMainContext): void {
	const {
		wpCli, siteData, localLogger, siteProcessManager, siteDatabase, importSQLFile,
	} = LocalMain.getServiceContainer().cradle;

	const logger = localLogger.child({
		thread: 'main',
		addon: ADDON_SLUG,
	});

	/** Throw a clear error when the site isn't running (WP-CLI needs its database). */
	const assertRunning = (site: Local.Site) => {
		try {
			const status = String(siteProcessManager.getSiteStatus(site));
			if (status !== 'running') {
				throw new Error(`"${site.name}" is not running — start the site in Local, then try again.`);
			}
		} catch (err: any) {
			if (err?.message?.includes('is not running')) {
				throw err;
			}
			// If status can't be determined, let the command itself fail.
		}
	};

	/** Broadcast a progress stage to the renderer's progress bar. */
	const progress = (siteId: string, step: number, total: number, label: string) => {
		LocalMain.sendIPCEvent(`${ADDON_SLUG}:progress`, { siteId, step, total, label });
	};

	/** Strip the noisy WP-CLI command line out of errors; keep the actual reason. */
	const friendly = (err: any): Error => {
		const msg = String(err?.message || err);
		if (/database connection/i.test(msg)) {
			return new Error('Could not connect to the database — make sure the site is running in Local.');
		}
		// "Command failed: <huge command> Error: <reason>" -> keep the reason.
		const m = msg.match(/Error:\s*([\s\S]{1,300})/);
		return new Error(m ? m[1].trim() : msg.slice(0, 300));
	};

	// Read the WordPress core version currently installed for a site.
	LocalMain.addIpcAsyncListener(`${ADDON_SLUG}:get-current-version`, async (siteId: string) => {
		const site = siteData.getSite(siteId) as unknown as Local.Site;
		if (!site) {
			return { version: null, error: 'Site not found.' };
		}

		try {
			const out = await wpCli.run(site, ['core', 'version']);
			return { version: (out || '').trim(), error: null };
		} catch (err: any) {
			logger.warn(`get-current-version failed for ${siteId}: ${err?.message}`);
			return {
				version: null,
				error: 'Could not read the WordPress version. Make sure the site is running, then try again.',
			};
		}
	});

	// List every WordPress release the site can be switched to (nightly + beta/RC + all stable).
	LocalMain.addIpcAsyncListener(`${ADDON_SLUG}:get-available-versions`, async () => {
		try {
			return { versions: await fetchAllVersions(), error: null };
		} catch (err: any) {
			logger.warn(`get-available-versions failed: ${err?.message}`);
			return { versions: [] as VersionInfo[], error: err?.message || 'Failed to fetch versions.' };
		}
	});

	// Switch the site's WordPress core to a specific version, beta/RC, nightly, or .zip URL.
	// `--force` lets WP-CLI re-download core for same-version reinstalls and downgrades.
	// When snapshotFirst is set, a database snapshot is taken before switching.
	LocalMain.addIpcAsyncListener(
		`${ADDON_SLUG}:set-version`,
		async (siteId: string, version: string, snapshotFirst: boolean) => {
			const site = siteData.getSite(siteId) as unknown as Local.Site;
			if (!site) {
				throw new Error('Site not found.');
			}

			const updateArgs = buildUpdateArgs(version);
			assertRunning(site);

			try {
				const total = snapshotFirst ? 4 : 3;
				let step = 0;

				let snapshotName: string | null = null;
				if (snapshotFirst) {
					progress(siteId, ++step, total, 'Taking database snapshot…');
					const snap = await createSnapshot(wpCli, siteDatabase, site, `before ${version}`);
					snapshotName = snap.filename;
					logger.info(`Snapshot taken before switch: ${snapshotName}`);
				}

				logger.info(`Changing WordPress core to "${version}" for site ${siteId}.`);

				progress(siteId, ++step, total, `Downloading & installing WordPress ${version}…`);
				const updateOut = await wpCli.run(site, updateArgs);
				progress(siteId, ++step, total, 'Updating the database…');
				const dbOut = await wpCli.run(site, ['core', 'update-db']);
				progress(siteId, ++step, total, 'Verifying…');
				const newVersion = (await wpCli.run(site, ['core', 'version'])).trim();

				logger.info(`Site ${siteId} is now on WordPress ${newVersion}.`);

				return {
					newVersion,
					snapshot: snapshotName,
					log: [updateOut, dbOut].filter(Boolean).join('\n').trim(),
				};
			} catch (err) {
				throw friendly(err);
			}
		},
	);

	// --- Snapshots: list / create / restore / delete ---
	LocalMain.addIpcAsyncListener(`${ADDON_SLUG}:list-snapshots`, async (siteId: string) => {
		const site = siteData.getSite(siteId) as unknown as Local.Site;
		if (!site) {
			return [];
		}
		try {
			return await listSnapshots(site);
		} catch (err: any) {
			logger.warn(`list-snapshots failed: ${err?.message}`);
			return [];
		}
	});

	LocalMain.addIpcAsyncListener(`${ADDON_SLUG}:create-snapshot`, async (siteId: string, note: string) => {
		const site = siteData.getSite(siteId) as unknown as Local.Site;
		if (!site) {
			throw new Error('Site not found.');
		}
		assertRunning(site);
		logger.info(`Creating snapshot for site ${siteId}.`);
		try {
			return await createSnapshot(wpCli, siteDatabase, site, note);
		} catch (err) {
			throw friendly(err);
		}
	});

	LocalMain.addIpcAsyncListener(`${ADDON_SLUG}:restore-snapshot`, async (siteId: string, filename: string) => {
		const site = siteData.getSite(siteId) as unknown as Local.Site;
		if (!site) {
			throw new Error('Site not found.');
		}
		assertRunning(site);
		logger.info(`Restoring snapshot ${filename} for site ${siteId}.`);
		try {
			const newVersion = await restoreSnapshot(wpCli, importSQLFile, site, filename, (step, total, label) => {
				progress(siteId, step, total, label);
			});
			return { newVersion };
		} catch (err) {
			throw friendly(err);
		}
	});

	LocalMain.addIpcAsyncListener(`${ADDON_SLUG}:delete-snapshot`, async (siteId: string, filename: string) => {
		const site = siteData.getSite(siteId) as unknown as Local.Site;
		if (!site) {
			throw new Error('Site not found.');
		}
		await deleteSnapshot(site, filename);
		return true;
	});
}
