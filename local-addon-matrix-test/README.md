# Matrix Tester — a Local (LocalWP) add-on

Test the **same setup on several sites at once** — e.g. one on WordPress 7.0, one on 6.9,
one on 6.4.6, each on whatever PHP you choose — and drive them **all simultaneously**:
click on the leader site and the same click happens on every variant, live. Errors from
every variant stream into one panel.

## Workflow

1. Set up your leader site exactly how you want it (plugin under test, feeds, settings).
2. Open **Tools → Matrix Tester** on the leader.
3. Tick the variant sites, optionally pin each to a WordPress version (e.g. `6.4.6`).
   Set PHP per site in Local's Overview as usual.
4. **Sync setup** — copies the leader's database + wp-content to each variant
   (URLs rewritten per site, WP core pinned if requested).
5. **Start mirroring** — browser windows open for every site. Interact with the
   **leader** window: clicks, typing, and navigation replay on all variants.
6. Watch the **Issues** feed: JS errors and failed replays per variant, live.

## How mirroring works

The add-on runs a WebSocket hub on `127.0.0.1` and installs a managed mu-plugin
(`wp-content/mu-plugins/matrix-mirror.php`) on every participating site:

- The **leader** bridge captures clicks (as CSS selectors), input changes, and navigation,
  and sends them to the hub.
- **Follower** bridges replay each event on their own site and report anything that fails
  (selector missing = the UI differs on that variant → that's a finding!).
- All bridges report uncaught JS errors with their site name.

Bridges are removed when you stop mirroring (and on Local quit).

## Notes & limits

- All participating sites must be **running**.
- Sync **overwrites** the variants' database and wp-content — pair with the
  [Site Snapshots](../local-addon-site-snapshots/) add-on if you want a way back.
- Mirroring replays semantic events (click/input/navigate), not pixel-perfect scrolling.
  Password fields are never mirrored.
- Log in on each variant once (or sync from the leader so logins match).

## Install

```bash
git clone https://github.com/nathanrodrigues2111/local-wp-addons.git
cd local-wp-addons/local-addon-matrix-test
npm install --legacy-peer-deps
npm run build
ln -s "$(pwd)" ~/.config/Local/addons/local-addon-matrix-test   # Linux
```

Enable under **Local → Add-ons**, relaunch Local.

## License

MIT
