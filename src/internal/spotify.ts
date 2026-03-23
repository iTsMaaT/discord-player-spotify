/* eslint-disable @typescript-eslint/no-explicit-any */
import { UA, market } from "./helper";
import { parse } from "node-html-parser";
import { Buffer } from "node:buffer";
import { grabSpotifyAnonToken, type SpotifySecret } from "./grabSpotifyToken";

const SP_BASE = "https://api.spotify.com/v1";
const SP_PARTNER_GRAPHQL = "https://api-partner.spotify.com/pathfinder/v2/query";

// Persisted query hashes from Spotify's JS bundle — may need updating if Spotify rotates them
const GRAPHQL_SEARCH_HASH = "3c9d3f60dac5dea3876b6db3f534192b1c1d90032c4233c1bbaba526db41eb31";
const GRAPHQL_PLAYLIST_HASH = "346811f856fb0b7e4f6c59f8ebea78dd081c6e2fb01b77c954b26259d5fc6763";
const GRAPHQL_ALBUM_HASH = "b9bfabef66ed756e5e13f68a942deb60bd4125ec1f1be8cc42769dc0259b4b10";

interface SP_ACCESS_TOKEN {
    token: string;
    expiresAfter: number;
    type: "Bearer";
    clientToken?: string;
    clientVersion?: string;
}

interface SPTrackMetadata {
    name: string;
    artist: { name: string }[];
    album: {
        cover_group: {
            image: { file_id: string; size: string; width: number; height: number }[];
        };
    };
    duration: number;
}

interface SPGraphQLSearchResponse {
    data: {
        searchV2: {
            tracksV2: {
                items: Array<{
                    item: {
                        data: {
                            id: string;
                            name: string;
                            duration: { totalMilliseconds: number };
                            artists: { items: Array<{ profile: { name: string } }> };
                            albumOfTrack: { coverArt: { sources: Array<{ url: string }> } };
                        };
                    };
                }>;
            };
        };
    };
}

interface SPGraphQLPlaylistResponse {
    data: {
        playlistV2: {
            __typename: string;
            // metadata — present with fetchPlaylist, absent with fetchPlaylistContents
            name?: string;
            ownerV2?: { data: { name: string } };
            images?: { items: Array<{ sources: Array<{ height: number; url: string; width: number }> }> };
            content: {
                __typename: string;
                totalCount?: number;
                items: Array<{
                    uid: string;
                    itemV2: {
                        __typename: string; // "TrackResponseWrapper" for tracks
                        data: {
                            __typename: string;
                            uri: string; // "spotify:track:{id}"
                            name: string;
                            trackDuration: { totalMilliseconds: number };
                            artists: { items: Array<{ profile: { name: string } }> };
                            albumOfTrack: {
                                coverArt: {
                                    sources: Array<{ height: number; url: string; width: number }>;
                                };
                            };
                        };
                    };
                }>;
            };
        };
    };
}

interface SPGraphQLAlbumResponse {
    data: {
        albumUnion: {
            __typename: string;
            name: string;
            uri: string;
            artists: {
                items: Array<{
                    id: string;
                    uri: string;
                    profile: { name: string };
                }>;
            };
            coverArt: {
                sources: Array<{ height: number; url: string; width: number }>;
            };
            tracksV2: {
                totalCount: number;
                items: Array<{
                    uid: string;
                    track: {
                        name: string;
                        uri: string;
                        duration: { totalMilliseconds: number };
                        artists: {
                            items: Array<{
                                uri: string;
                                profile: { name: string };
                            }>;
                        };
                        playability: { playable: boolean };
                    };
                }>;
            };
        };
    };
}


function spotifyBase62ToHex(base62Id: string): string {
    const alphabet = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
    let value = 0n;
    for (const char of base62Id) {
        const index = BigInt(alphabet.indexOf(char));
        if (index === -1n) throw new Error(`Invalid character in ID: ${char}`);
        value = value * 62n + index;
    }
    return value.toString(16).padStart(32, "0");
}

export class SpotifyAPI {
    public accessToken: SP_ACCESS_TOKEN | null = null;
    private clientId: string | undefined;
    private clientSecret: string | undefined;
    private market: string;
    public useCredentials: boolean = false;
    private _cachedSecrets: SpotifySecret[] | undefined;

    constructor(credentials: { clientId?: string; clientSecret?: string; market?: string }) {
        if (credentials.clientId && credentials.clientSecret) {
            this.useCredentials = true;
            this.clientId = credentials.clientId;
            this.clientSecret = credentials.clientSecret;
        }
        this.market = credentials.market || market;
    }

    private get authorizationKey() {
        return Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64");
    }

    private async fetchWithRetry(url: string, payload: any, attempt = 0): Promise<Response> {
        try {
            const res = await this.fetchData(url, {
                method: "POST",
                body: JSON.stringify(payload),
                headers: { "Content-Type": "application/json" },
            });

            if (res.status === 429) {
                const retryAfter = Number(res.headers.get("retry-after")) || 1;
                await this.sleep(retryAfter * 1000 + Math.random() * 500);
                return this.fetchWithRetry(url, payload, attempt + 1);
            }

            if (!res.ok && attempt < 3) {
                await this.sleep(300 * Math.pow(2, attempt));
                return this.fetchWithRetry(url, payload, attempt + 1);
            }

            return res;
        } catch {
            if (attempt < 3) {
                await this.sleep(300 * Math.pow(2, attempt));
                return this.fetchWithRetry(url, payload, attempt + 1);
            }
            throw new Error("Request failed");
        }
    }

    private sleep(ms: number) {
        return new Promise((r) => setTimeout(r, ms));
    }

    public async requestToken() {
        try {
            if (this.useCredentials) {
                const tokenData = await fetch("https://accounts.spotify.com/api/token", {
                    method: "POST",
                    headers: {
                        "User-Agent": UA,
                        Authorization: `Basic ${this.authorizationKey}`,
                        "Content-Type": "application/x-www-form-urlencoded",
                    },
                    body: "grant_type=client_credentials",
                }).then((v) => v.json());

                if (!tokenData) throw new Error("Failed to retrieve access token.");
                this.accessToken = {
                    token: tokenData.access_token,
                    expiresAfter: Date.now() + tokenData.expires_in * 1000,
                    type: "Bearer",
                };
            } else {
                const anonData = await grabSpotifyAnonToken(this._cachedSecrets);
                this._cachedSecrets = anonData.secrets;
                this.accessToken = {
                    token: anonData.tokens.accessToken,
                    expiresAfter: anonData.tokens.accessTokenExpirationTimestampMs,
                    type: "Bearer",
                    clientToken: anonData.clientToken,
                    clientVersion: anonData.clientVersion,
                };
            }
        } catch {
            throw new Error("Failed to retrieve access token from Spotify.");
        }
    }

    private isTokenExpired() {
        return !this.accessToken || Date.now() > this.accessToken.expiresAfter;
    }

    private async ensureValidToken() {
        if (this.isTokenExpired()) await this.requestToken();
    }

    private async fetchData(apiUrl: string, options?: RequestInit) {
        await this.ensureValidToken();
        const headers: Record<string, string> = {
            Authorization: `Bearer ${this.accessToken?.token}`,
            Referer: "https://open.spotify.com/",
            Origin: "https://open.spotify.com",
            "User-Agent": UA,
            Accept: "application/json",
        };
        if (!this.useCredentials && this.accessToken?.clientToken) {
            headers["client-token"] = this.accessToken.clientToken;
            headers["spotify-app-version"] = this.accessToken.clientVersion || "";
            headers["app-platform"] = "WebPlayer";
        }
        const res = await fetch(apiUrl, {
            ...options,
            headers: { ...headers, ...(options?.headers as Record<string, string> ?? {}) },
        });
        if (!res.ok) throw new Error(`Failed to fetch Spotify data: ${res.status}`);
        return res;
    }

    public async search(query: string) {
        try {
            if (this.useCredentials) {
                const res = await this.fetchData(
                    `${SP_BASE}/search/?q=${encodeURIComponent(query)}&type=track${this.market ? `&market=${this.market}` : ""}`,
                );
                const data: { tracks: { items: SpotifyTrack[] } } = await res.json();
                return data.tracks.items.map((m) => ({
                    title: m.name,
                    duration: m.duration_ms,
                    artist: m.artists.map((artist) => artist.name).join(", "),
                    url: m.external_urls?.spotify || `https://open.spotify.com/track/${m.id}`,
                    thumbnail: m.album.images?.[0]?.url || null,
                }));
            }

            // Anon: use partner GraphQL API
            const payload = {
                extensions: {
                    persistedQuery: { sha256Hash: GRAPHQL_SEARCH_HASH, version: 1 },
                },
                operationName: "searchDesktop",
                variables: {
                    searchTerm: query,
                    includeArtistHasConcertsField: false,
                    includeAudiobooks: false,
                    includeAuthors: false,
                    includePreReleases: false,
                    limit: 10,
                    numberOfTopResults: 5,
                    offset: 0,
                },
            };

            const res = await this.fetchData(SP_PARTNER_GRAPHQL, {
                method: "POST",
                body: JSON.stringify(payload),
                headers: { "Content-Type": "application/json" },
            });
            const data: SPGraphQLSearchResponse = await res.json();
            return data.data.searchV2.tracksV2.items.map((item) => ({
                title: item.item.data.name,
                duration: item.item.data.duration.totalMilliseconds,
                artist: item.item.data.artists.items.map((a) => a.profile.name).join(", "),
                url: `https://open.spotify.com/track/${item.item.data.id}`,
                thumbnail: item.item.data.albumOfTrack?.coverArt?.sources?.[0]?.url || null,
            }));
        } catch {
            return null;
        }
    }

    public async getPlaylist(id: string) {
        if (!this.useCredentials) {
            try {
                const limit = 50; // matches Spotify web client behavior
                let offset = 0;

                const allTracks: any[] = [];
                let playlistData: SPGraphQLPlaylistResponse["data"]["playlistV2"] | null = null;
                let total: number | null = null;

                // hard cap just in case (prevents infinite loops if API changes)
                const MAX_PAGES = 200; // 50 * 200 = 10k tracks max

                for (let page = 0; page < MAX_PAGES; page++) {
                    const payload = {
                        extensions: {
                            persistedQuery: {
                                sha256Hash: GRAPHQL_PLAYLIST_HASH,
                                version: 1,
                            },
                        },
                        operationName: "fetchPlaylist",
                        variables: {
                            uri: `spotify:playlist:${id}`,
                            offset,
                            limit,
                            enableWatchFeedEntrypoint: true,
                        },
                    };

                    const res = await this.fetchWithRetry(SP_PARTNER_GRAPHQL, payload);

                    const data: SPGraphQLPlaylistResponse = await res.json();
                    const current = data.data.playlistV2;

                    playlistData ??= current;

                    const items = current.content.items;
                    if (!items?.length) break;

                    // total count (if exposed)
                    total ??= current.content.totalCount ?? null;

                    const trackItems = items.filter(
                        (item) =>
                            item.itemV2?.__typename === "TrackResponseWrapper" &&
                        item.itemV2.data.__typename !== "NotFound",
                    );

                    const tracks = trackItems.map((item) => {
                        const track = item.itemV2.data;
                        const trackId = track.uri.split(":").pop() || "";

                        return {
                            name: track.name,
                            duration_ms: track.trackDuration.totalMilliseconds,
                            artists: track.artists.items.map((a) => ({
                                id: "",
                                name: a.profile.name,
                            })),
                            external_urls: {
                                spotify: `https://open.spotify.com/track/${trackId}`,
                            },
                            id: trackId,
                            album: {
                                images: (track.albumOfTrack?.coverArt?.sources ?? [])
                                    .sort((a, b) => (b.height || 0) - (a.height || 0))
                                    .map((s) => ({
                                        url: s.url,
                                        height: s.height || 0,
                                        width: s.width || 0,
                                    })),
                            },
                        };
                    });

                    allTracks.push(...tracks);

                    offset += limit;

                    if (items.length < limit) break;
                    if (total !== null && offset >= total) break;

                    await this.sleep(120 + Math.random() * 180);
                }

                if (!allTracks.length || !playlistData) return null;

                const playlistThumbnail =
                playlistData.images?.items?.[0]?.sources
                    ?.sort((a, b) => (b.height || 0) - (a.height || 0))?.[0]?.url ||
                playlistData.content.items?.[0]?.itemV2?.data?.albumOfTrack?.coverArt?.sources
                    ?.sort((a, b) => (b.height || 0) - (a.height || 0))?.[0]?.url ||
                null;

                return {
                    name: playlistData.name ?? "",
                    author: playlistData.ownerV2?.data?.name || "",
                    thumbnail: playlistThumbnail,
                    id,
                    url: `https://open.spotify.com/playlist/${id}`,
                    tracks: allTracks,
                };
            } catch {
                return null;
            }
        }

        try {
            const res = await this.fetchData(`${SP_BASE}/playlists/${id}${this.market ? `?market=${this.market}` : ""}`);
            if (!res) return null;

            const data: {
                external_urls: { spotify: string };
                owner: { display_name: string };
                id: string;
                name: string;
                images: { url: string }[];
                tracks: {
                    items: { track: SpotifyTrack }[];
                    next?: string;
                };
            } = await res.json();

            if (!data.tracks.items.length) return null;

            const t: { track: SpotifyTrack }[] = data.tracks.items;
            let next: string | undefined = data.tracks.next;

            while (typeof next === "string") {
                try {
                    const nextRes = await this.fetchData(next);
                    if (!nextRes) break;
                    const nextPage: { items: { track: SpotifyTrack }[]; next?: string } = await nextRes.json();
                    t.push(...nextPage.items);
                    next = nextPage.next;
                    if (!next) break;
                } catch {
                    break;
                }
            }

            const tracks = t
                .filter(({ track: m }) => m?.name && m?.artists)
                .map(({ track: m }) => ({
                    name: m.name,
                    duration_ms: m.duration_ms,
                    artists: m.artists,
                    external_urls: m.external_urls,
                    id: m.id,
                    album: { images: m.album.images },
                }));

            if (!tracks.length) return null;
            return {
                name: data.name,
                author: data.owner.display_name,
                thumbnail: data.images?.[0]?.url || null,
                id: data.id,
                url: data.external_urls.spotify || `https://open.spotify.com/playlist/${id}`,
                tracks,
            };
        } catch {
            return null;
        }
    }

    public async getAlbum(id: string) {
        if (!this.useCredentials) {
            // Anon: use partner GraphQL API
            try {
                const fetchPage = async (offset: number): Promise<SPGraphQLAlbumResponse> => {
                    const payload = {
                        extensions: {
                            persistedQuery: { sha256Hash: GRAPHQL_ALBUM_HASH, version: 1 },
                        },
                        operationName: "getAlbum",
                        variables: {
                            uri: `spotify:album:${id}`,
                            locale: "",
                            offset,
                            limit: 50,
                        },
                    };
                    const res = await this.fetchData(SP_PARTNER_GRAPHQL, {
                        method: "POST",
                        body: JSON.stringify(payload),
                        headers: { "Content-Type": "application/json" },
                    });
                    return res.json();
                };

                const firstPage = await fetchPage(0);
                const albumData = firstPage.data.albumUnion;
                const allItems = [...albumData.tracksV2.items];
                const totalCount = albumData.tracksV2.totalCount;

                while (allItems.length < totalCount) {
                    try {
                        const nextPage = await fetchPage(allItems.length);
                        const newItems = nextPage.data.albumUnion.tracksV2.items;
                        if (!newItems.length) break;
                        allItems.push(...newItems);
                    } catch {
                        break;
                    }
                }

                const albumImages = albumData.coverArt.sources
                    .sort((a, b) => (b.height || 0) - (a.height || 0))
                    .map((s) => ({ url: s.url, height: s.height || 0, width: s.width || 0 }));

                const tracks = allItems
                    .filter((item) => item.track?.name)
                    .map((item) => {
                        const track = item.track;
                        const trackId = track.uri.split(":").pop() || "";
                        return {
                            name: track.name,
                            duration_ms: track.duration.totalMilliseconds,
                            artists: track.artists.items.map((a) => ({ id: "", name: a.profile.name })),
                            external_urls: { spotify: `https://open.spotify.com/track/${trackId}` },
                            id: trackId,
                            album: { images: albumImages },
                        };
                    });

                if (!tracks.length) return null;
                return {
                    name: albumData.name,
                    author: albumData.artists.items.map((a) => a.profile.name).join(", "),
                    thumbnail: albumImages[0]?.url || null,
                    id,
                    url: `https://open.spotify.com/album/${id}`,
                    tracks,
                };
            } catch {
                return null;
            }
        }

        try {
            const res = await this.fetchData(`${SP_BASE}/albums/${id}${this.market ? `?market=${this.market}` : ""}`);
            if (!res) return null;

            const data: {
                external_urls: { spotify: string };
                artists: { name: string }[];
                id: string;
                name: string;
                images: { url: string }[];
                tracks: {
                    items: SpotifyTrack[];
                    next?: string;
                };
            } = await res.json();

            if (!data.tracks.items.length) return null;

            const t: SpotifyTrack[] = data.tracks.items;
            let next: string | undefined = data.tracks.next;

            while (typeof next === "string") {
                try {
                    const nextRes = await this.fetchData(next);
                    if (!nextRes) break;
                    const nextPage: { items: SpotifyTrack[]; next?: string } = await nextRes.json();
                    t.push(...nextPage.items);
                    next = nextPage.next;
                    if (!next) break;
                } catch {
                    break;
                }
            }

            const tracks = t
                .filter((m) => m?.name && m?.artists)
                .map((m) => ({
                    name: m.name,
                    duration_ms: m.duration_ms,
                    artists: m.artists,
                    external_urls: m.external_urls,
                    id: m.id,
                    album: { images: data.images || [] },
                }));

            if (!tracks.length) return null;
            return {
                name: data.name,
                author: data.artists.map((m) => m.name).join(", "),
                thumbnail: data.images?.[0]?.url || null,
                id: data.id,
                url: data.external_urls.spotify || `https://open.spotify.com/album/${id}`,
                tracks,
            };
        } catch {
            return null;
        }
    }

    public async getTrack(id: string) {
        try {
            if (this.useCredentials) {
                const res = await this.fetchData(`${SP_BASE}/tracks/${id}${this.market ? `?market=${this.market}` : ""}`);
                if (!res) return null;
                const track: SpotifyTrack = await res.json();
                return {
                    name: track.name,
                    duration_ms: track.duration_ms,
                    artists: track.artists,
                    external_urls: track.external_urls,
                    id: track.id,
                    album: { images: track.album.images },
                };
            }

            // Anon: use private SP Client API
            const hexId = spotifyBase62ToHex(id);
            const res = await this.fetchData(`https://spclient.wg.spotify.com/metadata/4/track/${hexId}?market=from_token`);
            const metadata: SPTrackMetadata = await res.json();

            return {
                name: metadata.name,
                duration_ms: metadata.duration,
                artists: (metadata.artist ?? []).map((a) => ({ id: "", name: a.name })),
                external_urls: { spotify: `https://open.spotify.com/track/${id}` },
                id,
                album: {
                    images: (metadata.album?.cover_group?.image ?? [])
                        .sort((a, b) => (b.width || 0) - (a.width || 0))
                        .map((img) => ({
                            url: `https://i.scdn.co/image/${img.file_id}`,
                            height: img.height || 0,
                            width: img.width || 0,
                        })),
                },
            };
        } catch {
            return null;
        }
    }

    public async getRecommendations(trackIds: string[]) {
        // Credentials: unsupported via SP Public API - could add option to use private SPclient API separately
        // TODO: implement a way to fetch recommendations using anonymous token
        return [];
    }

    /**
     * Returns the Spotify embed link for a given url and type.
     */
    public static getEmbedLink(url: string, type: "track" | "playlist" | "album"): string {
        const urlObject = new URL(url);
        const id = urlObject.pathname.split("/").pop();
        return `https://open.spotify.com/embed/${type}/${id}?utm_source=generator`;
    }

    /**
     * Fetches and parses track/playlist/album info from the Spotify embed page.
     */
    public static async getTracksFromEmbed(
        url: string,
        type: "track" | "playlist" | "album" = "track",
    ): Promise<any | null> {
        const embedUrl = SpotifyAPI.getEmbedLink(url, type);
        const html = await fetch(embedUrl).then(r => r.text());
        const root = parse(html);
        let jsonData: any;
        const track: any = {};
        const playlist: any = {};

        const scriptTag = root.querySelector("script#__NEXT_DATA__");
        if (scriptTag)
            jsonData = JSON.parse(scriptTag.text);
        else
            return null;

        switch (type) {
            case "track": {
                track.title = jsonData.props.pageProps.state.data.entity.name;
                track.artist = jsonData.props.pageProps.state.data.entity.artists[0].name;
                track.url = `https://open.spotify.com/track/${jsonData.props.pageProps.state.data.entity.uri.split(":").pop()}`;
                track.thumbnail = jsonData.props.pageProps.state.data.entity.visualIdentity.image[0].url;
                track.duration = jsonData.props.pageProps.state.data.entity.duration;
                return track;
            }
            case "playlist": {
                playlist.title = jsonData.props.pageProps.state.data.entity.name;
                playlist.artist = jsonData.props.pageProps.state.data.entity.subtitle;
                playlist.url = `https://open.spotify.com/playlist/${jsonData.props.pageProps.state.data.entity.uri.split(":").pop()}`;
                playlist.thumbnail = jsonData.props.pageProps.state.data.entity.coverArt.sources[0].url;
                playlist.tracks = jsonData.props.pageProps.state.data.entity.trackList.map((item: any) => {
                    const t: any = {};
                    t.title = item.title;
                    t.artist = item.subtitle || "Unknown Artist";
                    t.url = `https://open.spotify.com/track/${item.uri.split(":").pop()}`;
                    t.thumbnail = jsonData.props.pageProps.state.data.entity.coverArt.sources[0].url;
                    t.duration = item.duration;
                    return t;
                });
                return playlist;
            }
            case "album": {
                playlist.title = jsonData.props.pageProps.state.data.entity.name;
                playlist.artist = jsonData.props.pageProps.state.data.entity.subtitle;
                playlist.url = `https://open.spotify.com/album/${jsonData.props.pageProps.state.data.entity.uri.split(":").pop()}`;
                playlist.thumbnail = jsonData.props.pageProps.state.data.entity.visualIdentity.image[0].url;
                playlist.tracks = jsonData.props.pageProps.state.data.entity.trackList.map((item: any) => {
                    const t: any = {};
                    t.title = item.title;
                    t.artist = item.subtitle || "Unknown Artist";
                    t.url = `https://open.spotify.com/track/${item.uri.split(":").pop()}`;
                    t.thumbnail = jsonData.props.pageProps.state.data.entity.visualIdentity.image[0].url;
                    t.duration = item.duration;
                    return t;
                });
                return playlist;
            }
            default: return null;
        }
    }
}

export interface SpotifyTrack {
    album: {
        images: {
            height: number;
            url: string;
            width: number;
        }[];
    };
    artists: {
        id: string;
        name: string;
    }[];
    duration_ms: number;
    explicit: boolean;
    external_urls: { spotify: string };
    id: string;
    name: string;
}
