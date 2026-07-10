# Site Snapshots — a Local (LocalWP) add-on

**Save game / load game for your Local sites.** Set up a site exactly how you need it —
YouTube feeds, Twitter feeds, plugin settings, test content — and save that whole state as
a **named snapshot**. Later (after a reset, a broken test, or on a fresh day), load the
snapshot and the site is back to that exact setup, ready to test.

## What a snapshot contains

| Part | How |
| --- | --- |
| **Database** | Full dump via Local's database service (`db.sql`) |
| **wp-content** | Full copy — plugins, themes, uploads, mu-plugins (cache dirs skipped) |
| **WordPress version** | Recorded; restore reinstalls the matching core if it differs |

Snapshots live in `<site>/site-snapshots/<name>-<timestamp>/`.

## Usage

1. Open a site in Local (it must be **running**) → **Tools** → **Site Snapshots**.
2. Type a name (e.g. `youtube-feeds-setup`) → **Save snapshot**.
3. Break things, reset, test whatever.
4. Come back → **Load** next to the snapshot → confirm. Database + wp-content + core
   version are restored, with a step-by-step progress bar.

Restores are safe-by-default: the current `wp-content` is kept until the snapshot copy
succeeds, then swapped (rolled back automatically on failure).

## Install on a new setup

Requires [Node.js](https://nodejs.org/) 16+ and [Local](https://localwp.com/).

```bash
git clone https://github.com/nathanrodrigues2111/local-addon-site-snapshots.git
cd local-addon-site-snapshots
npm install --legacy-peer-deps      # or: yarn install
npm run build                        # compiles src/ -> lib/
```

Symlink into Local's add-ons directory and restart Local:

```bash
# Linux
ln -s "$(pwd)" ~/.config/Local/addons/local-addon-site-snapshots
# macOS
ln -s "$(pwd)" ~/Library/Application\ Support/Local/addons/local-addon-site-snapshots
# Windows (PowerShell, as Administrator)
New-Item -ItemType SymbolicLink -Path "$env:APPDATA\Local\addons\local-addon-site-snapshots" -Target (Get-Location)
```

Then **Local → Add-ons → Site Snapshots → enable**, and relaunch Local.

## Notes

- The site must be **running** to save or load (database operations need it).
- Snapshots include uploads; big media libraries make big snapshots.
- Pairs well with the [WordPress Version Manager](https://github.com/nathanrodrigues2111/local-addon-wp-version-manager)
  add-on — snapshot your setup, then switch WordPress versions fearlessly.

## License

MIT
