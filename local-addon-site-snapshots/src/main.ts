// Main-process entry for the Site Snapshots add-on.
import * as Local from '@getflywheel/local';
import * as LocalMain from '@getflywheel/local/main';
import { listSnapshots, createSnapshot, restoreSnapshot, deleteSnapshot } from './snapshots';

const ADDON_SLUG = 'site-snapshots';

export default function (context: LocalMain.AddonMainContext): void {
	const {
		wpCli, siteData, localLogger, siteProcessManager, siteDatabase, importSQLFile,
	} = LocalMain.getServiceContainer().cradle;

	const logger = localLogger.child({
		thread: 'main',
		addon: ADDON_SLUG,
	});

	const progress = (siteId: string, step: number, total: number, label: string) => {
		LocalMain.sendIPCEvent(`${ADDON_SLUG}:progress`, { siteId, step, total, label });
	};

	/** Throw a clear error when the site isn't running (DB operations need it). */
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
		}
	};

	/** Strip noisy command lines out of errors; keep the actual reason. */
	const friendly = (err: any): Error => {
		const msg = String(err?.message || err);
		if (/database connection/i.test(msg)) {
			return new Error('Could not connect to the database — make sure the site is running in Local.');
		}
		const m = msg.match(/Error:\s*([\s\S]{1,300})/);
		return new Error(m ? m[1].trim() : msg.slice(0, 300));
	};

	LocalMain.addIpcAsyncListener(`${ADDON_SLUG}:list`, async (siteId: string) => {
		const site = siteData.getSite(siteId) as unknown as Local.Site;
		if (!site) {
			return [];
		}
		try {
			return await listSnapshots(site);
		} catch (err: any) {
			logger.warn(`list failed: ${err?.message}`);
			return [];
		}
	});

	LocalMain.addIpcAsyncListener(`${ADDON_SLUG}:create`, async (siteId: string, name: string) => {
		const site = siteData.getSite(siteId) as unknown as Local.Site;
		if (!site) {
			throw new Error('Site not found.');
		}
		assertRunning(site);
		logger.info(`Creating snapshot "${name}" for site ${siteId}.`);
		try {
			return await createSnapshot(wpCli, siteDatabase, site, name, (s, t, l) => progress(siteId, s, t, l));
		} catch (err) {
			throw friendly(err);
		}
	});

	LocalMain.addIpcAsyncListener(`${ADDON_SLUG}:restore`, async (siteId: string, slug: string) => {
		const site = siteData.getSite(siteId) as unknown as Local.Site;
		if (!site) {
			throw new Error('Site not found.');
		}
		assertRunning(site);
		logger.info(`Restoring snapshot "${slug}" for site ${siteId}.`);
		try {
			return await restoreSnapshot(wpCli, importSQLFile, site, slug, (s, t, l) => progress(siteId, s, t, l));
		} catch (err) {
			throw friendly(err);
		}
	});

	LocalMain.addIpcAsyncListener(`${ADDON_SLUG}:delete`, async (siteId: string, slug: string) => {
		const site = siteData.getSite(siteId) as unknown as Local.Site;
		if (!site) {
			throw new Error('Site not found.');
		}
		await deleteSnapshot(site, slug);
		return true;
	});
}
