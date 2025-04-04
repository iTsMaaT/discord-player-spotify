/* eslint-disable @typescript-eslint/no-explicit-any */
import { BaseExtractor, ExtractorInfo, ExtractorSearchContext, ExtractorStreamable, GuildQueueHistory, Playlist, Track, Util } from "discord-player";
import type { Readable } from "stream";
import { SpotifyAPI } from "./internal/spotify";
import { spotifySongRegex, spotifyPlaylistRegex, spotifyAlbumRegex, isUrl, parseSpotifyUrl, market } from "./internal/helper";
import { User } from "discord.js";

type StreamFN = (url: string, track: Track) => Promise<Readable | string>;

export interface SpotifyExtractorInit {
  clientId?: string;
  clientSecret?: string;
  market?: string | null;
  createStream?: (ext: SpotifyExtractor, url: string) => Promise<Readable | string>;
}

export { parseSpotifyUrl };

export class SpotifyExtractor extends BaseExtractor<SpotifyExtractorInit> {
    public static identifier = "com.discord-player.spotifyextractor" as const;
    private _stream!: StreamFN;
    private _credentials = {
        clientId: this.options.clientId || process.env.DP_SPOTIFY_CLIENT_ID || "",
        clientSecret: this.options.clientSecret || process.env.DP_SPOTIFY_CLIENT_SECRET || "",
    };

    private _market = this.options.market || market;

    public internal = new SpotifyAPI({ ...this._credentials, market: this._market });

    public async activate(): Promise<void> {
        this.protocols = ["spsearch", "spotify"];

        const fn = this.options.createStream;
        if (typeof fn === "function") {
            this._stream = (q: string) => {
                return fn(this, q);
            };
        }
    }

    public async deactivate() {
        this._stream = undefined as unknown as StreamFN;
        this.protocols = [];
    }

    public async validate(query: string): Promise<boolean> {
        return !isUrl(query) || [spotifyAlbumRegex, spotifyPlaylistRegex, spotifySongRegex].some((regex) => regex.test(query));
    }

    buildTrack(trackInfo: any, requestedBy: User | null | undefined, playlist?: Playlist): Track {
        return new Track(this.context.player, {
            title: trackInfo.name || trackInfo.title,
            description: `${trackInfo.name || trackInfo.title} by ${
                Array.isArray(trackInfo.artists) ? trackInfo.artists.map((m: any) => m.name).join(", ") : trackInfo.artist || "Unknown Artist"
            }`,
            author: Array.isArray(trackInfo.artists) ? trackInfo.artists[0]?.name : trackInfo.artist || "Unknown Artist",
            url: trackInfo.external_urls?.spotify || trackInfo.url || `https://open.spotify.com/track/${trackInfo.id}`,
            thumbnail: trackInfo.album?.images?.[0]?.url || trackInfo.thumbnail || "https://www.scdn.co/i/_global/twitter_card-default.jpg",
            duration: Util.buildTimeCode(Util.parseMS(trackInfo.duration_ms || trackInfo.duration || 0)),
            views: 0,
            requestedBy: requestedBy,
            source: "spotify",
            metadata: {
                source: trackInfo,
                bridge: null,
            },
            requestMetadata: async () => ({
                source: trackInfo,
                bridge: null,
            }),
            playlist: playlist,
        });
    }

    buildPlaylist(data: any, context: ExtractorSearchContext, type: "album" | "playlist" = "playlist"): Playlist {
        const playlist = new Playlist(this.context.player, {
            title: data.name,
            description: "",
            thumbnail: data.thumbnail,
            type,
            source: "spotify",
            author: {
                name: data.author,
                url: null as unknown as string,
            },
            tracks: [],
            id: data.id,
            url: data.url,
            rawPlaylist: data,
        });

        playlist.tracks = (data.tracks || []).map((trackData: any) => {
            const track = new Track(this.context.player, {
                title: trackData.name,
                description: `${trackData.name} by ${trackData.artists.map((a: any) => a.name).join(", ")}`,
                author: trackData.artists[0].name,
                url: trackData.external_urls.spotify,
                thumbnail: trackData.album?.images?.[0]?.url || "https://www.scdn.co/i/_global/twitter_card-default.jpg",
                duration: Util.buildTimeCode(Util.parseMS(trackData.duration_ms)),
                views: 0,
                requestedBy: context.requestedBy,
                source: "spotify",
                metadata: {
                    source: trackData,
                    bridge: null,
                },
                requestMetadata: async () => ({
                    source: trackData,
                    bridge: null,
                }),
                playlist: playlist,
            });
            track.extractor = this;
            return track;
        });

        return playlist;
    }

    public async handle(query: string, context: ExtractorSearchContext): Promise<ExtractorInfo> {
        const { id } = parseSpotifyUrl(query);
        if (spotifySongRegex.test(query)) {
            const spotifyData = await this.internal.getTrack(id);
            if (!spotifyData) return this.createResponse();

            const track = this.buildTrack(spotifyData, context?.requestedBy);
            track.extractor = this;

            return this.createResponse(null, [track]);
        }

        if (spotifyPlaylistRegex.test(query)) {
            const spotifyPlaylist = await this.internal.getPlaylist(id);
            if (!spotifyPlaylist) return this.createResponse();

            const playlist = this.buildPlaylist(spotifyPlaylist, context, "playlist");
            return this.createResponse(playlist, playlist.tracks);
        }

        if (spotifyAlbumRegex.test(query)) {
            const spotifyAlbum = await this.internal.getAlbum(id);
            if (!spotifyAlbum) return this.createResponse();

            const playlist = this.buildPlaylist(spotifyAlbum, context, "album");
            return this.createResponse(playlist, playlist.tracks);
        }

        const data = await this.internal.search(query);
        if (!data) return this.createResponse();

        return this.createResponse(
            null,
            data.map((spotifyData) => {
                const track = this.buildTrack(spotifyData, context.requestedBy);
                track.extractor = this;
                return track;
            }),
        );
    }

    public async stream(info: Track): Promise<ExtractorStreamable> {
        if (this._stream) {
            const stream = await this._stream(info.url, info);
            return stream;
        }

        const result = await this.context.requestBridge(info, this);

        if (!result?.result) throw new Error("Could not bridge this track");

        return result.result;
    }

    public async getRelatedTracks(track: Track, history: GuildQueueHistory): Promise<ExtractorInfo> {
        let relatedTracks: { title: string; duration: number; artist: string; url: string; thumbnail: string | null }[] | null = null;
        if (!this.internal.useCredentials) {
            const trackIds = Array.from(
                new Set(
                    history.tracks
                        .toArray()
                        .filter((t: Track) => t.url.includes("spotify.com"))
                        .slice(0, 25)
                        .map((t: Track) => {
                            const lastSegment = t.url.split("/").at(-1);
                            return lastSegment ? lastSegment.split("?").at(0) : null;
                        })
                        .filter((id): id is string => id !== null),
                ),
            )
                .sort(() => 0.5 - Math.random())
                .slice(0, 5);
            if (trackIds.length) 
                relatedTracks = await this.internal.getRecommendations(trackIds);
      
        }
        if (this.internal.useCredentials || !relatedTracks?.length) {
            const artist = Array.from(
                new Set(
                    history.tracks
                        .toArray()
                        .filter((t: Track) => t.author && !["unknown artist", "unknown"].includes(t.author.toLowerCase()))
                        .slice(0, 25)
                        .flatMap((t: Track) => t.author.split(",").map((author) => author.trim())),
                ),
            )
                .sort(() => 0.5 - Math.random())
                .slice(0, 1);

            if (artist) 
                relatedTracks = await this.internal.search(`artist:${artist}`);
      
        }

        if (!relatedTracks?.length) {
            this.context.player.debug("Unable to fetch related tracks");
            return this.createResponse();
        }

        return this.createResponse(
            null,
            relatedTracks
                .filter(
                    (spotifyData) =>
                        !Array.from(new Set(history.tracks.toArray()))
                            .slice(0, relatedTracks.length)
                            .some((t: Track) => t.url === spotifyData.url),
                )
                .map((spotifyData) => {
                    const t = this.buildTrack(spotifyData, track.requestedBy);
                    t.extractor = this;
                    return t;
                }),
        );
    }
}
