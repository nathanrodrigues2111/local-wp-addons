# WordPress Version Manager — a Local (LocalWP) add-on

Change a site's **WordPress core version** from a dropdown, the same way Local lets you
switch the **PHP version**. Local pins WordPress to whatever shipped with the site; this
add-on lets you move it to any release you want — including **beta/RC** and **nightly**
builds and **old** versions.

![WordPress Version Manager](icon.svg)

## What it does

Adds a **WordPress Version** tab to each site's tools menu. From there you can:

- See the site's currently-installed WordPress version.
- Pick from a dropdown of **every** release: nightly, the current beta/RC, and all stable
  versions (fetched live from WordPress.org).
- Or type **any** version string (`6.6-RC1`, `4.9.8`, `nightly`) or a wordpress.org `.zip`
  URL.
- Apply it. The add-on runs WP-CLI under the hood:

  ```
  wp core update --version=<version> --force   # or a .zip URL for beta/nightly
  wp core update-db
  ```

Downgrades and pre-release installs are supported (WP-CLI `--force`), with a confirmation
prompt and warnings — **back up first**, downgrades are not officially supported by
WordPress.

## Requirements

- [Local](https://localwp.com/) 6+ (add-on API v9).
- The target **site must be running** — WP-CLI executes inside the site environment.
- Internet access (core downloads come from WordPress.org).

## How it works

| Process    | File                            | Responsibility                                                        |
| ---------- | ------------------------------- | --------------------------------------------------------------------- |
| Main       | `src/main.ts`                   | IPC handlers; fetches version lists; runs `wpCli.run(site, [...])`.   |
| Renderer   | `src/renderer.jsx`              | Registers the **WordPress Version** menu item via `siteInfoToolsItem`.|
| Renderer   | `src/WordPressVersionManager.jsx` | The UI: current version, dropdown, free-text input, apply + log.    |

IPC channels (`addIpcAsyncListener` ⇄ `LocalRenderer.ipcAsync`):

- `wp-version-manager:get-current-version` → `{ version, error }`
- `wp-version-manager:get-available-versions` → `{ versions: [{version, status, download?}], error }`
- `wp-version-manager:set-version` → `{ newVersion, log }`

## Install on a new setup

You need [Node.js](https://nodejs.org/) 16+ and [Local](https://localwp.com/) installed.
The add-on ships as source only — you build it once, then point Local at the folder.

### 1. Get the code and build it

```bash
git clone https://github.com/nathanrodrigues2111/local-addon-wp-version-manager.git
cd local-addon-wp-version-manager

# install deps (npm needs --legacy-peer-deps; yarn does not)
npm install --legacy-peer-deps      # or: yarn install

# compile src/ (TypeScript + JSX) -> lib/
npm run build                        # or: yarn build
```

After this you should have a `lib/` folder containing `main.js`, `renderer.js`,
`versions.js`, and `WordPressVersionManager.js`.

### 2. Put it where Local looks for add-ons

Local loads every folder inside its `addons` directory. Symlink (recommended, so you can
keep developing) or copy this project there:

| OS      | Add-ons directory                                                        |
| ------- | ------------------------------------------------------------------------ |
| Linux   | `~/.config/Local/addons/`                                                |
| macOS   | `~/Library/Application Support/Local/addons/`                            |
| Windows | `%APPDATA%\Local\addons\`                                               |

```bash
# Linux
ln -s "$(pwd)" ~/.config/Local/addons/local-addon-wp-version-manager

# macOS
ln -s "$(pwd)" ~/Library/Application\ Support/Local/addons/local-addon-wp-version-manager

# Windows (PowerShell, run as Administrator)
New-Item -ItemType SymbolicLink `
  -Path "$env:APPDATA\Local\addons\local-addon-wp-version-manager" `
  -Target (Get-Location)
```

> Using **Local Lightning**? Some versions use an `addons` folder under
> `~/.config/Local Beta/` or `~/Library/Application Support/Local Beta/` instead. If Local
> doesn't see the add-on, check for a `Local Beta` directory.

### 3. Enable it in Local

1. Fully quit and reopen **Local** (so it picks up the new folder).
2. Open **Local → Add-ons** (bottom-left). The **WordPress Version Manager** appears under
   *Installed / Local add-ons* — toggle it **on**.
3. If prompted, allow Local to relaunch.

### 4. Use it

1. Select a site in Local and make sure it is **running** (the add-on talks to WP-CLI
   inside the site).
2. Click the site's tools row — you'll see a new **WordPress Version** tab.
3. Pick a version from the dropdown (or type any version / `.zip` URL), then **Apply**.

### One-command scaffold (alternative)

Prefer the official generator? You can also start from scratch with
`npx create-local-addon`, which symlinks and enables the add-on for you — then drop these
`src/` files in. See <https://localwp.com/get-involved/build/>.

### Developing

Run `npm run watch` (or `yarn watch`) for incremental rebuilds, and `npm test` to run the
version-logic smoke test. Reload the add-on in Local from **Add-ons → (gear) → Reload** or
by restarting Local.

## Caveats

- Very old WordPress releases may not run on modern PHP — pair this with Local's PHP
  version switcher.
- Beta/RC availability tracks WordPress.org's beta channel; between cycles there may be no
  active pre-release (use `nightly` or a typed version/URL).

## License

MIT
