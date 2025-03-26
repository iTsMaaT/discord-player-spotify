/* eslint-disable @typescript-eslint/no-explicit-any */
import {
    BaseExtractor,
    ExtractorInfo,
    ExtractorSearchContext,
    ExtractorStreamable,
    Playlist,
    QueryType,
    SearchQueryType,
    Track,
    Util,
} from "discord-player";
import type { Readable } from "stream";
import { fetch } from "./helper";
import spotify, {
    Spotify,
    SpotifyAlbum,
    SpotifyPlaylist,
    SpotifySong,
} from "spotify-url-info";
import { SpotifyAPI } from "./internal/index";

  type StreamFN = (
    url: string,
    track: Track,
  ) => Promise<Readable | string>;
  
const re =
    /^(?:https:\/\/open\.spotify\.com\/(intl-([a-z]|[A-Z]){0,3}\/)?(?:user\/[A-Za-z0-9]+\/)?|spotify:)(album|playlist|track)(?:[/:])([A-Za-z0-9]+).*$/;

const spotifySongRegex =
  /^https?:\/\/(?:embed\.|open\.)(?:spotify\.com\/)(intl-([a-z]|[A-Z])+\/)?(?:track\/|\?uri=spotify:track:)((\w|-){22})(\?si=.+)?$/;
const spotifyPlaylistRegex =
  /^https?:\/\/(?:embed\.|open\.)(?:spotify\.com\/)(intl-([a-z]|[A-Z])+\/)?(?:playlist\/|\?uri=spotify:playlist:)((\w|-){22})(\?si=.+)?$/;
const spotifyAlbumRegex =
  /^https?:\/\/(?:embed\.|open\.)(?:spotify\.com\/)(intl-([a-z]|[A-Z])+\/)?(?:album\/|\?uri=spotify:album:)((\w|-){22})(\?si=.+)?$/;
  
export interface SpotifyExtractorInit {
    clientId?: string | null;
    clientSecret?: string | null;
    createStream?: (
      ext: SpotifyExtractor,
      url: string,
    ) => Promise<Readable | string>;
}

const isUrl = (query: string): boolean => {
    try {
        return ["http:", "https:"].includes(new URL(query).protocol);
    } catch {
        return false;
    }
};
  
export class SpotifyExtractor extends BaseExtractor<SpotifyExtractorInit> {
    public static identifier = "com.discord-player.spotifyextractor" as const;
    private _stream!: StreamFN;
    private _lib!: Spotify;
    private _credentials = {
        clientId: this.options.clientId || process.env.DP_SPOTIFY_CLIENT_ID || "",
        clientSecret:
        this.options.clientSecret || process.env.DP_SPOTIFY_CLIENT_SECRET || "",
    };
    public internal = new SpotifyAPI(this._credentials);
  
    public async activate(): Promise<void> {
        this.protocols = ["spsearch", "spotify"];
        this._lib = spotify(fetch);
  
        const fn = this.options.createStream;
        if (typeof fn === "function") {
            this._stream = (q: string) => {
                return fn(this, q);
            };
        }
    }
  
    public async deactivate() {
        this._stream = undefined as unknown as StreamFN;
        this._lib = undefined as unknown as Spotify;
        this.protocols = [];
    }
  
    public async validate(query: string): Promise<boolean> {
        return !isUrl(query) ||
      [spotifyAlbumRegex, spotifyPlaylistRegex, spotifySongRegex ].some(regex => regex.test(query));
    }

     
    buildTrack(trackInfo: any, context: ExtractorSearchContext, playlist?: Playlist): Track {
        return new Track(this.context.player, {
            title: trackInfo.name || trackInfo.title,
            description: `${trackInfo.name || trackInfo.title} by ${Array.isArray(trackInfo.artists) 
                 
                ? trackInfo.artists.map((m: any) => m.name).join(", ") 
                : trackInfo.artist || "Unknown Artist"}`,
            author: Array.isArray(trackInfo.artists) 
                ? trackInfo.artists[0]?.name 
                : trackInfo.artist || "Unknown Artist",
            url: trackInfo.external_urls?.spotify || trackInfo.url || `https://open.spotify.com/track/${trackInfo.id}`,
            thumbnail: trackInfo.album?.images?.[0]?.url || trackInfo.thumbnail || "https://www.scdn.co/i/_global/twitter_card-default.jpg",
            duration: Util.buildTimeCode(Util.parseMS(trackInfo.duration_ms || trackInfo.duration || 0)),
            views: 0,
            requestedBy: context.requestedBy,
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
  
    public async handle(
        query: string,
        context: ExtractorSearchContext,
    ): Promise<ExtractorInfo> {
        if (spotifySongRegex.test(query)) {
            const spotifyData = await this._lib
                .getData(query, context.requestOptions as unknown as RequestInit)
                .catch(Util.noop);
            if (!spotifyData) return { playlist: null, tracks: [] };
    
            const track = this.buildTrack(spotifyData, context);
            track.extractor = this;
    
            return { playlist: null, tracks: [track] };
        }
    
        if (spotifyPlaylistRegex.test(query)) {
            try {
                const { queryType, id } = this.parse(query);
                if (queryType !== "playlist") throw "err";
                
                const spotifyPlaylist = await this.internal.getPlaylist(id);
                if (!spotifyPlaylist) throw "err";
    
                const playlist = this.buildPlaylist(spotifyPlaylist, context, "playlist");
                console.log(playlist);
                return { playlist, tracks: playlist.tracks };
            } catch (err) {
                const spotifyPlaylist = await this._lib
                    .getData(query, context.requestOptions as unknown as RequestInit)
                    .catch(Util.noop);
                if (!spotifyPlaylist) return { playlist: null, tracks: [] };
    
                const playlist = this.buildPlaylist(spotifyPlaylist, context, "playlist");
                return { playlist, tracks: playlist.tracks };
            }
        }
    
        if (spotifyAlbumRegex.test(query)) {
            try {
                const { queryType, id } = this.parse(query);
                if (queryType !== "album") throw "err";
    
                const spotifyAlbum = await this.internal.getAlbum(id);
                if (!spotifyAlbum) throw "err";
    
                const playlist = this.buildPlaylist(spotifyAlbum, context, "album");
                return { playlist, tracks: playlist.tracks };
            } catch {
                const album = await this._lib
                    .getData(query, context.requestOptions as unknown as RequestInit)
                    .catch(Util.noop);
                if (!album) return { playlist: null, tracks: [] };
    
                const playlist = this.buildPlaylist(album, context, "album");
                return { playlist, tracks: playlist.tracks };
            }
        }

        const data = await this.internal.search(query);
        if (!data) return this.createResponse();
    
        return this.createResponse(
            null,
            data.map((spotifyData) => {
                const track = this.buildTrack(spotifyData, context);
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
  
    public parse(q: string) {
        const [, , , queryType, id] = re.exec(q) || [];
  
        return { queryType, id };
    }
}