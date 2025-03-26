# Spotify Extractor (metadata only)

> ⚠️ Warning: This extractor is still in development and may not work as expected.

This is a reworked Spotify extractor inspired from the original one at @discord-player/extractors.

## Installation

```bash
npm install discord-player-spotify
```

## Usage

```js
const { Player } = require("discord-player");

const { SpotifyExtractor } = require("discord-player-spotify");
// Or
import { SpotifyExtractor } from "discord-player-spotify";

const player = new Player(client, {});

await player.extractors.register(SpotifyExtractor, { /* options */ });
```

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| clientId | string | null | Your Spotify client ID |
| clientSecret | string | null | Your Spotify client secret |
| createStream(ext: SpotifyExtractor, url: string) => Promise<Readable \| string>; | function | null | A function that returns a stream or streamable url |