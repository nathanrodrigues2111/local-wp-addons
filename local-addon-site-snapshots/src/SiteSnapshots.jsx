import { ipcRenderer } from 'electron';

// https://getflywheel.github.io/local-addon-api/modules/_local_renderer_.html
import * as LocalRenderer from '@getflywheel/local/renderer';

// https://github.com/getflywheel/local-components
import { Button, Text, FlyModal, Title, TableListRow, TextButton, ProgressBar } from '@getflywheel/local-components';

const SLUG = 'site-snapshots';

// Use Local's injected React instance (a bundled second copy breaks hooks).
let React;

/** Unwrap Local's ipcAsync rejection noise and return just the real message. */
function cleanError (err) {
	let msg = String(err?.message || err);
	const m = msg.match(/main thread error:\s*([\s\S]*?)(?:\s*Check out the error props.*)?$/i);
	if (m) {
		msg = m[1].trim();
	}
	return msg.replace(/^["']|["']$/g, '') || 'Something went wrong.';
}

function formatSize (bytes) {
	if (!bytes) return '—';
	const mb = bytes / 1024 / 1024;
	return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(1)} MB`;
}

export function registerSiteSnapshots (_React, hooks) {
	React = _React;

	hooks.addContent('siteInfoUtilities', (site) => (
		<TableListRow key={SLUG} label="Site Snapshots">
			<SiteSnapshots site={site} />
		</TableListRow>
	));
}

function SiteSnapshots ({ site }) {
	const { useState, useEffect, useCallback } = React;

	const siteId = site?.id;

	const [snapshots, setSnapshots] = useState([]);
	const [name, setName] = useState('');
	const [busy, setBusy] = useState(false);
	const [stage, setStage] = useState(null);
	const [error, setError] = useState(null);
	const [notice, setNotice] = useState('');
	const [confirmRestore, setConfirmRestore] = useState(null); // snapshot to restore

	useEffect(() => {
		const onProgress = (_event, p) => {
			if (p?.siteId === siteId) {
				setStage(p);
			}
		};
		ipcRenderer.on(`${SLUG}:progress`, onProgress);
		return () => ipcRenderer.removeListener(`${SLUG}:progress`, onProgress);
	}, [siteId]);

	const load = useCallback(async () => {
		const list = await LocalRenderer.ipcAsync(`${SLUG}:list`, siteId);
		setSnapshots(Array.isArray(list) ? list : []);
	}, [siteId]);

	useEffect(() => {
		load();
	}, [load]);

	const run = async (fn) => {
		setBusy(true);
		setError(null);
		setNotice('');
		try {
			await fn();
		} catch (err) {
			setError(cleanError(err));
		} finally {
			setBusy(false);
			setStage(null);
		}
	};

	const take = () => run(async () => {
		const label = name.trim() || 'snapshot';
		const snap = await LocalRenderer.ipcAsync(`${SLUG}:create`, siteId, label);
		setName('');
		setNotice(`Saved "${snap.name}" (${formatSize(snap.sizeBytes)}).`);
		await load();
	});

	const restore = (snap) => run(async () => {
		setConfirmRestore(null);
		const res = await LocalRenderer.ipcAsync(`${SLUG}:restore`, siteId, snap.slug);
		setNotice(`Loaded "${res.name}" — site is on WordPress ${res.newVersion} with that setup.`);
	});

	const remove = (snap) => run(async () => {
		await LocalRenderer.ipcAsync(`${SLUG}:delete`, siteId, snap.slug);
		await load();
	});

	const renderProgress = () => {
		const pct = stage ? Math.round(((stage.step - 0.5) / stage.total) * 100) : undefined;
		return (
			<div style={{ width: 360, maxWidth: '100%', marginTop: 14 }}>
				<ProgressBar progress={pct} />
				<Text style={{ fontSize: 12, opacity: 0.8, marginTop: 4, display: 'block' }}>
					{stage ? `${stage.label} (step ${stage.step} of ${stage.total})` : 'Working…'}
				</Text>
			</div>
		);
	};

	return (
		<div style={{ flex: '1', overflowY: 'auto' }}>
			<Text style={{ display: 'block', marginBottom: 12, opacity: 0.85 }}>
				Save the whole site state (database + wp-content) as a named snapshot, and load it
				back any time — your plugins, feeds, and settings exactly as you left them.
			</Text>

			<div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
				<input
					type="text"
					value={name}
					disabled={busy}
					placeholder="e.g. youtube-feeds-setup"
					onChange={(e) => setName(e.target.value)}
					onKeyDown={(e) => { if (e.key === 'Enter' && !busy) take(); }}
					style={{
						width: 260,
						padding: '8px 10px',
						borderRadius: 4,
						border: '1px solid #c3c4c7',
					}}
				/>
				<Button disabled={busy} onClick={take}>
					{busy ? 'Working…' : 'Save snapshot'}
				</Button>
			</div>

			{busy ? renderProgress() : null}

			{error ? (
				<Text style={{ display: 'block', marginTop: 12, color: '#b32d2e' }}>{error}</Text>
			) : null}
			{notice && !error && !busy ? (
				<Text style={{ display: 'block', marginTop: 12, color: '#51bb7b' }}>{notice}</Text>
			) : null}

			<div style={{ marginTop: 20 }}>
				{snapshots.length === 0 ? (
					<Text style={{ opacity: 0.7 }}>No snapshots yet — set up your site, then save one.</Text>
				) : (
					<table style={{ width: '100%', maxWidth: 680, fontSize: 13, borderCollapse: 'collapse' }}>
						<tbody>
							{snapshots.map((s) => (
								<tr key={s.slug} style={{ borderBottom: '1px solid rgba(127,127,127,0.15)' }}>
									<td style={{ padding: '7px 8px 7px 0', fontWeight: 600 }}>{s.name}</td>
									<td style={{ padding: '7px 8px', opacity: 0.75 }}>
										{new Date(s.date).toLocaleString()}
									</td>
									<td style={{ padding: '7px 8px', opacity: 0.75 }}>WP {s.wpVersion}</td>
									<td style={{ padding: '7px 8px', opacity: 0.75 }}>{formatSize(s.sizeBytes)}</td>
									<td style={{ padding: '7px 0 7px 8px', whiteSpace: 'nowrap' }}>
										<TextButton disabled={busy} onClick={() => setConfirmRestore(s)}>
											Load
										</TextButton>
										{' '}
										<TextButton
											disabled={busy}
											style={{ color: '#e2574f' }}
											onClick={() => remove(s)}
										>
											Delete
										</TextButton>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
			</div>

			<FlyModal
				isOpen={!!confirmRestore}
				onRequestClose={() => setConfirmRestore(null)}
			>
				<div style={{ padding: '10px 40px 35px', maxWidth: 520, margin: '0 auto', textAlign: 'center' }}>
					<Title fontSize="xl" style={{ marginBottom: 20 }}>Load this snapshot?</Title>
					<div style={{ marginBottom: 14, fontSize: 15, lineHeight: 1.5 }}>
						Load <strong>{confirmRestore?.name}</strong> onto <strong>{site?.name}</strong>?
					</div>
					<div style={{ marginBottom: 24, fontSize: 13, lineHeight: 1.5, opacity: 0.75 }}>
						The current database and wp-content will be replaced with the snapshot
						(WP {confirmRestore?.wpVersion}, {formatSize(confirmRestore?.sizeBytes)}).
						Anything not saved in another snapshot will be lost.
					</div>
					<div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
						<Button onClick={() => restore(confirmRestore)}>Yes, load it</Button>
						<Button className="Button--Ghost" onClick={() => setConfirmRestore(null)}>
							Cancel
						</Button>
					</div>
				</div>
			</FlyModal>
		</div>
	);
}
