// Main-process entry for the Matrix Tester add-on.
import * as Local from '@getflywheel/local';
import * as LocalMain from '@getflywheel/local/main';
import { syncSetup } from './sync';
import { startMirror, stopMirror, getSession, MirrorIssue } from './mirror';

const ADDON_SLUG = 'matrix-test';

export default function (context: LocalMain.AddonMainContext): void {
	const {
		wpCli, siteData, localLogger, siteProcessManager, siteDatabase, importSQLFile,
	} = LocalMain.getServiceContainer().cradle;

	const logger = localLogger.child({ thread: 'main', addon: ADDON_SLUG });

	const progress = (siteId: string, step: number, total: number, label: string) => {
		LocalMain.sendIPCEvent(`${ADDON_SLUG}:progress`, { siteId, step, total, label });
	};

	const getSite = (siteId: string): Local.Site => {
		const site = siteData.getSite(siteId) as unknown as Local.Site;
		if (!site) {
			throw new Error('Site not found.');
		}
		return site;
	};

	const assertRunning = (site: Local.Site) => {
		try {
			const status = String(siteProcessManager.getSiteStatus(site));
			if (status !== 'running') {
				throw new Error(`"${site.name}" is not running — start it in Local first.`);
			}
		} catch (err: any) {
			if (err?.message?.includes('is not running')) {
				throw err;
			}
		}
	};

	const friendly = (err: any): Error => {
		const msg = String(err?.message || err);
		if (/database connection/i.test(msg)) {
			return new Error('Could not connect to a site database — make sure every selected site is running.');
		}
		const m = msg.match(/Error:\s*([\s\S]{1,300})/);
		return new Error(m ? m[1].trim() : msg.slice(0, 300));
	};

	// All sites with their running state, for the picker UI.
	LocalMain.addIpcAsyncListener(`${ADDON_SLUG}:sites`, async () => {
		const sites = siteData.getSites() as Record<string, any>;
		const statuses = siteProcessManager.getSiteStatuses();
		return Object.values(sites).map((s: any) => ({
			id: s.id,
			name: s.name,
			domain: s.domain,
			running: String(statuses[s.id]) === 'running',
		}));
	});

	// Copy the leader's setup onto each variant (DB + wp-content + URL rewrite + WP version).
	LocalMain.addIpcAsyncListener(
		`${ADDON_SLUG}:sync`,
		async (sourceId: string, variants: { siteId: string; wpVersion?: string }[]) => {
			const source = getSite(sourceId);
			assertRunning(source);
			const targets = variants.map((v) => {
				const site = getSite(v.siteId);
				assertRunning(site);
				return { site, wpVersion: v.wpVersion };
			});
			logger.info(`Sync setup: ${source.name} -> ${targets.map((t) => t.site.name).join(', ')}`);
			try {
				return await syncSetup(
					wpCli, siteDatabase, importSQLFile, source, targets,
					(s, t, l) => progress(sourceId, s, t, l),
				);
			} catch (err) {
				throw friendly(err);
			}
		},
	);

	// Start mirroring across the given sites (first = leader).
	LocalMain.addIpcAsyncListener(`${ADDON_SLUG}:mirror-start`, async (leaderId: string, siteIds: string[]) => {
		const leader = getSite(leaderId);
		const sites = siteIds.map((id) => {
			const s = getSite(id);
			assertRunning(s);
			return s;
		});
		const { port } = await startMirror(sites, leader, (issue: MirrorIssue) => {
			LocalMain.sendIPCEvent(`${ADDON_SLUG}:issue`, issue);
		}, logger);
		// Open every participating site in the default browser.
		for (const s of sites) {
			context.electron.shell.openExternal(`https://${s.domain}`);
		}
		return { port };
	});

	LocalMain.addIpcAsyncListener(`${ADDON_SLUG}:mirror-stop`, async (siteIds: string[]) => {
		const sites = siteIds.map((id) => getSite(id));
		return stopMirror(sites, logger);
	});

	LocalMain.addIpcAsyncListener(`${ADDON_SLUG}:mirror-status`, async () => getSession());

	// Clean up bridges if Local quits mid-session.
	context.electron.app.on('will-quit', () => {
		const s = getSession();
		if (s.active && s.siteIds) {
			const sites = s.siteIds.map((id) => siteData.getSite(id) as unknown as Local.Site).filter(Boolean);
			stopMirror(sites, logger).catch(() => undefined);
		}
	});
}
