# Self-Sync Plugin for Obsidian

This is a plugin for [Obsidian](https://obsidian.md) that allows you to synchronize your notes across multiple devices.

## Features

- Synchronize notes across multiple devices.
- Automatic synchronization when changes are detected.
- Manual synchronization option.

## How to Use

1. Clone this repository.
2. Make sure your NodeJS is at least v16 (`node --version`).
3. Run `npm i` or `yarn` to install dependencies.
4. Run `npm run dev` to start compilation in watch mode.
5. Copy over `main.js`, `styles.css`, `manifest.json` to your vault `VaultFolder/.obsidian/plugins/self-sync/`.

## How to Debug

1. Connect your Android device to your laptop via USB.
2. Open Obsidian on your Android device.
3. In Chrome, you should now see a section called _WebView in md.obsidian_. Click on _inspect_.
4. Go to Chrome and type: `chrome://inspect`.

## Development

This project uses Typescript for type checking and documentation. The repo depends on the latest plugin API (obsidian.d.ts) in Typescript Definition format, which contains TSDoc comments describing what it does.

To build this project, run the `build` script in the package.json file:

`npm run build`

## Hot Reload

This project uses the Hot-Reload Plugin for Obsidian.md Plugins. This plugin automatically watches for changes to the `main.js` or `styles.css` of any plugin whose directory includes a `.git` subdirectory or a file called `.hotreload`, and then automatically disables and re-enables that plugin once changes have stopped for about three-quarters of a second.

For more information, see the Hot-Reload Plugin README.

## Obsidian API Documentation

See [API Documentation](https://github.com/obsidianmd/obsidian-api)


