import { ipcRenderer } from 'electron';

// https://getflywheel.github.io/local-addon-api/modules/_local_renderer_.html
import * as LocalRenderer from '@getflywheel/local/renderer';

// https://github.com/getflywheel/local-components
import { Button, Text, TableListRow, TextButton, ProgressBar } from '@getflywheel/local-components';

const SLUG = 'matrix-test';

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

export function registerMatrixTester (_React, hooks) {
	React = _React;

	hooks.addContent('siteInfoUtilities', (site) => (
		<TableListRow key={SLUG} label="Matrix Tester">
			<MatrixPanel site={site} />
		</TableListRow>
	));
}

function MatrixPanel ({ site }) {
	const { useState, useEffect, useCallback } = React;

	const leaderId = site?.id;

	const [sites, setSites] = useState([]);
	const [picked, setPicked] = useState({}); // siteId -> { on: bool, wpVersion: '' }
	const [busy, setBusy] = useState(false);
	const [stage, setStage] = useState(null);
	const [error, setError] = useState(null);
	const [notice, setNotice] = useState('');
	const [mirror, setMirror] = useState({ active: false });
	const [issues, setIssues] = useState([]);

	const refresh = useCallback(async () => {
		const list = await LocalRenderer.ipcAsync(`${SLUG}:sites`);
		setSites(Array.isArray(list) ? list : []);
		setMirror(await LocalRenderer.ipcAsync(`${SLUG}:mirror-status`));
	}, []);

	useEffect(() => {
		refresh();
	}, [refresh]);

	useEffect(() => {
		const onProgress = (_e, p) => { if (p?.siteId === leaderId) setStage(p); };
		const onIssue = (_e, issue) => setIssues((prev) => [...prev.slice(-99), issue]);
		ipcRenderer.on(`${SLUG}:progress`, onProgress);
		ipcRenderer.on(`${SLUG}:issue`, onIssue);
		return () => {
			ipcRenderer.removeListener(`${SLUG}:progress`, onProgress);
			ipcRenderer.removeListener(`${SLUG}:issue`, onIssue);
		};
	}, [leaderId]);

	const variants = sites.filter((s) => s.id !== leaderId);
	const pickedIds = variants.filter((s) => picked[s.id]?.on).map((s) => s.id);

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

	const doSync = () => run(async () => {
		const specs = pickedIds.map((id) => ({ siteId: id, wpVersion: (picked[id].wpVersion || '').trim() || undefined }));
		const results = await LocalRenderer.ipcAsync(`${SLUG}:sync`, leaderId, specs);
		setNotice(results.join(' · '));
	});

	const startMirror = () => run(async () => {
		setIssues([]);
		const res = await LocalRenderer.ipcAsync(`${SLUG}:mirror-start`, leaderId, [leaderId, ...pickedIds]);
		setNotice(`Mirroring live (hub port ${res.port}). Browser windows opened — drive THIS site (${site?.name}); the others follow.`);
		await refresh();
	});

	const stopMirror = () => run(async () => {
		await LocalRenderer.ipcAsync(`${SLUG}:mirror-stop`, [leaderId, ...pickedIds]);
		setNotice('Mirror stopped; bridges removed.');
		await refresh();
	});

	const renderProgress = () => {
		const pct = stage ? Math.round(((stage.step - 0.5) / stage.total) * 100) : undefined;
		return (
			<div style={{ width: 380, maxWidth: '100%', marginTop: 14 }}>
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
				Test the same setup on several sites at once. <strong>{site?.name}</strong> is the
				leader — sync its setup to the variants below (optionally pinning each to a
				WordPress version), then start mirroring: whatever you do on the leader replays on
				every variant, and their errors show up here. Set PHP per site in Local as usual.
			</Text>

			{variants.length === 0 ? (
				<Text style={{ opacity: 0.7 }}>No other sites in Local to use as variants.</Text>
			) : (
				<table style={{ maxWidth: 640, fontSize: 13, borderCollapse: 'collapse', marginBottom: 8 }}>
					<tbody>
						{variants.map((s) => (
							<tr key={s.id} style={{ borderBottom: '1px solid rgba(127,127,127,0.15)' }}>
								<td style={{ padding: '6px 8px 6px 0' }}>
									<label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
										<input
											type="checkbox"
											disabled={busy || mirror.active}
											checked={!!picked[s.id]?.on}
											onChange={(e) => setPicked((p) => ({ ...p, [s.id]: { ...(p[s.id] || {}), on: e.target.checked } }))}
										/>
										<strong>{s.name}</strong>
									</label>
								</td>
								<td style={{ padding: '6px 8px', opacity: 0.75 }}>
									<span style={{ width: 8, height: 8, borderRadius: '50%', display: 'inline-block', marginRight: 6, background: s.running ? '#51bb7b' : '#9aa0a6' }} />
									{s.running ? 'running' : 'stopped'}
								</td>
								<td style={{ padding: '6px 0 6px 8px' }}>
									<input
										type="text"
										placeholder="WP version (optional, e.g. 6.4.6)"
										disabled={busy || !picked[s.id]?.on || mirror.active}
										value={picked[s.id]?.wpVersion || ''}
										onChange={(e) => setPicked((p) => ({ ...p, [s.id]: { ...(p[s.id] || {}), wpVersion: e.target.value } }))}
										style={{ width: 220, height: 30, boxSizing: 'border-box', padding: '0 8px', borderRadius: 4, border: '1px solid #c3c4c7', fontSize: 12 }}
									/>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			)}

			<div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 10 }}>
				<Button disabled={busy || pickedIds.length === 0 || mirror.active} onClick={doSync}>
					{busy ? 'Working…' : `Sync setup to ${pickedIds.length || '…'} variant${pickedIds.length === 1 ? '' : 's'}`}
				</Button>
				{mirror.active ? (
					<Button disabled={busy} onClick={stopMirror}>Stop mirroring</Button>
				) : (
					<Button disabled={busy || pickedIds.length === 0} onClick={startMirror}>Start mirroring</Button>
				)}
			</div>

			{busy ? renderProgress() : null}
			{error ? <Text style={{ display: 'block', marginTop: 12, color: '#b32d2e' }}>{error}</Text> : null}
			{notice && !error ? <Text style={{ display: 'block', marginTop: 12, color: '#51bb7b' }}>{notice}</Text> : null}

			{mirror.active || issues.length ? (
				<div style={{ marginTop: 18 }}>
					<strong>Issues {mirror.active ? '(live)' : ''}</strong>
					{issues.length === 0 ? (
						<Text style={{ display: 'block', opacity: 0.7, marginTop: 6 }}>None yet — differences and errors will appear here.</Text>
					) : (
						<table style={{ width: '100%', maxWidth: 680, fontSize: 12, borderCollapse: 'collapse', marginTop: 6 }}>
							<tbody>
								{issues.slice().reverse().map((i, idx) => (
									<tr key={idx} style={{ borderBottom: '1px solid rgba(127,127,127,0.12)' }}>
										<td style={{ padding: '5px 8px 5px 0', whiteSpace: 'nowrap', fontWeight: 600 }}>{i.site}</td>
										<td style={{ padding: '5px 8px', whiteSpace: 'nowrap', color: i.kind === 'js-error' ? '#e2574f' : '#e8a33d' }}>{i.kind}</td>
										<td style={{ padding: '5px 0 5px 8px', opacity: 0.85 }}>{i.detail}</td>
									</tr>
								))}
							</tbody>
						</table>
					)}
				</div>
			) : null}
		</div>
	);
}
