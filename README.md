# Spotify Extractor (metadata only)

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

## Supported features

| Feature | Supported |
| --- | --- |
| Single tracks | ✅ |
| Playlists | ✅ |
| Search | ✅ |
| Direct streaming | ❌ |
| Can be used as a bridge | ❌ |
| Can bridge to ... | ✅ |
| Autoplay | ✅* |

\* Autoplay is a work in progress. Currently, it simply fetches a track from the same artist.

## Options

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| clientId | string | null | No | Your Spotify client id |
| clientSecret | string | null | No | Your Spotify client secret |
| market | string | "" | No | The market to use for the Spotify API. |
| createStream(ext: SpotifyExtractor, url: string) => Promise<Readable \| string>; | function | null | No | A function that returns a Readable stream or a string URL to the stream. |
| anon.maxPagingQueries | number | 25 | No | Limits the number of tracks per request fetched for playlists when using anon mode. Must be between 1 and 5000. |

[Information on the market parameter and the reason why it is required.](https://developer.spotify.com/documentation/web-api/concepts/track-relinking)

[How to get the spotify client id and secret.](https://developer.spotify.com/documentation/web-api/concepts/apps)

> You can also set clientId and clientSecret in the environment variables `DP_SPOTIFY_CLIENT_ID` and `DP_SPOTIFY_CLIENT_SECRET`.