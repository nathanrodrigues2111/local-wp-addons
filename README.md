# local-wp-addons

Add-ons for [Local (LocalWP)](https://localwp.com/) that make WordPress plugin QA faster.

| Add-on | What it does |
| --- | --- |
| [**WordPress Version Manager**](local-addon-wp-version-manager/) | Switch a site's WordPress core to **any** version — stable, beta/RC, nightly, or old — from a dropdown styled like Local's PHP version selector. Auto DB snapshot before each switch, with one-click restore. |
| [**Site Snapshots**](local-addon-site-snapshots/) | Save the **whole site state** (database + wp-content) as a named snapshot and load it back in one click — "save game / load game" for dev sites. Set up your feeds/plugins once, reload that setup any time. |
| [**Cloudflare Tunnel**](local-addon-cloudflare-tunnel/) | Expose a site on a public `trycloudflare.com` URL — OAuth callbacks, webhooks, sharing. Optionally rewrites home/siteurl while active and restores on stop. |
| [**Matrix Tester**](local-addon-matrix-test/) | Test the same setup on several sites at once (different WP/PHP/plugin versions): sync the setup to variants, then mirror clicks/typing/navigation across all of them live, with per-variant error reporting. |

## Install (either add-on)

Requires [Node.js](https://nodejs.org/) 16+ and Local.

```bash
git clone https://github.com/nathanrodrigues2111/local-wp-addons.git
cd local-wp-addons/<addon-folder>
npm install --legacy-peer-deps
npm run build

# symlink into Local's add-ons dir (Linux; see each README for macOS/Windows)
ln -s "$(pwd)" ~/.config/Local/addons/$(basename "$(pwd)")
```

Then **Local → Add-ons → enable it** and relaunch Local. Full instructions, caveats, and
architecture notes are in each add-on's own README.

> Note: sites must be **running** for version switches and snapshots — the add-ons talk to
> the site's database through Local's services.

## Layout

```
local-wp-addons/
├── local-addon-wp-version-manager/   # WordPress core version switcher + DB snapshots
└── local-addon-site-snapshots/       # full site-state save/load (DB + wp-content)
```

Both are also published as standalone repos:
[local-addon-wp-version-manager](https://github.com/nathanrodrigues2111/local-addon-wp-version-manager) ·
[local-addon-site-snapshots](https://github.com/nathanrodrigues2111/local-addon-site-snapshots)

## License

MIT
