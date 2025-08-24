/* eslint-disable @typescript-eslint/no-explicit-any */
import { Secret, TOTP } from "otpauth";
import { UA, market } from "./helper";
import { parse } from "node-html-parser";
import { Buffer } from "node:buffer";

const SP_BASE = "https://api.spotify.com/v1";

interface SP_ACCESS_TOKEN {
    token: string;
    expiresAfter: number;
    type: "Bearer";
}

interface SpotifySecret {
    version: number;
    secret: number[];
}

export class SpotifyAPI {
    public accessToken: SP_ACCESS_TOKEN | null = null;
    private clientId: string | undefined;
    private clientSecret: string | undefined;
    private market: string;
    public useCredentials: boolean = false;

    /**
     * Secrets URL from https://github.com/Thereallo1026/spotify-secrets
     */
    private readonly SECRETS_URL = 'https://github.com/Thereallo1026/spotify-secrets/blob/main/secrets/secretBytes.json?raw=true';
    private readonly CACHE_DURATION = 30 * 60 * 1000;   // 30 minutes

    private cachedSecrets: SpotifySecret[] | null = null;
    private secretsCacheTime: number = 0;

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

    public async requestToken() {
        try {
            const accessTokenUrl = await this.getAccessTokenUrl();

            const fetchOptions: RequestInit = !this.useCredentials
                ? {
                    headers: {
                        Referer: "https://open.spotify.com/",
                        Origin: "https://open.spotify.com",
                    },
                }
                : {
                    method: "POST",
                    headers: {
                        "User-Agent": UA,
                        Authorization: `Basic ${this.authorizationKey}`,
                        "Content-Type": "application/x-www-form-urlencoded",
                    },
                    body: "grant_type=client_credentials",
                };

            const tokenData = await fetch(accessTokenUrl, fetchOptions).then((v) => v.json());
            if (!tokenData) throw new Error("Failed to retrieve access token.");

            this.accessToken = {
                token: !this.useCredentials ? tokenData.accessToken : tokenData.access_token,
                expiresAfter: !this.useCredentials ? tokenData.accessTokenExpirationTimestampMs : Date.now() + tokenData.expires_in * 1000,
                type: "Bearer",
            };
        } catch (error) {
            await this.getTokenFallback();
        }
    }

    private isTokenExpired() {
        return !this.accessToken || Date.now() > this.accessToken.expiresAfter;
    }

    private async ensureValidToken() {
        if (this.isTokenExpired()) await this.requestToken();
    }

    private async fetchData(apiUrl: string) {
        await this.ensureValidToken();
        const res = await fetch(apiUrl, {
            headers: {
                Authorization: `Bearer ${this.accessToken?.token}`,
                Referer: "https://open.spotify.com/",
                Origin: "https://open.spotify.com",
            },
        });

        if (!res.ok) throw new Error("Failed to fetch Spotify data.");
        return res;
    }

    public async search(query: string) {
        try {
            const res = await this.fetchData(`${SP_BASE}/search/?q=${encodeURIComponent(query)}&type=track${this.market ? `&market=${this.market}` : ""}`);
            const data: { tracks: { items: SpotifyTrack[] } } = await res.json();

            return data.tracks.items.map((m) => ({
                title: m.name,
                duration: m.duration_ms,
                artist: m.artists.map((artist) => artist.name).join(", "),
                url: m.external_urls?.spotify || `https://open.spotify.com/track/${m.id}`,
                thumbnail: m.album.images?.[0]?.url || null,
            }));
        } catch {
            return null;
        }
    }

    public async getPlaylist(id: string) {
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
                    album: {
                        images: m.album.images,
                    },
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
        } catch (err) {
            return null;
        }
    }

    public async getAlbum(id: string) {
        // if (!this.clientId || !this.clientSecret) throw new Error("Spotify clientId and clientSecret are required.");

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
                    album: {
                        images: data.images || [],
                    },
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
            const res = await this.fetchData(`${SP_BASE}/tracks/${id}${this.market ? `?market=${this.market}` : ""}`);
            if (!res) return null;

            const track: SpotifyTrack = await res.json();
            return {
                name: track.name,
                duration_ms: track.duration_ms,
                artists: track.artists,
                external_urls: track.external_urls,
                id: track.id,
                album: {
                    images: track.album.images,
                },
            };
        } catch {
            return null;
        }
    }

    public async getRecommendations(trackIds: Array<string>, limit?: number) {
        try {
            if (this.useCredentials) throw new Error("getRecommendations endpoint is not supported when using credentials.");

            const res = await this.fetchData(
                `${SP_BASE}/recommendations/?seed_tracks=${trackIds.join(",")}&limit=${limit || "100"}${this.market ? `&market=${this.market}` : ""}`,
            );
            if (!res) return null;
            const data: { tracks: SpotifyTrack[] } = await res.json();

            return data.tracks.map((m) => ({
                title: m.name,
                duration: m.duration_ms,
                artist: m.artists.map((artist) => artist.name).join(", "),
                url: m.external_urls?.spotify || `https://open.spotify.com/track/${m.id}`,
                thumbnail: m.album.images?.[0]?.url || null,
            }));
        } catch {
            return null;
        }
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
        // Optionally remove or replace console.log in production
        // console.log(embedUrl);
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
        // Optionally remove or replace console.log in production
        // console.log(jsonData);

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

    private buildTokenUrl() {
        const baseUrl = new URL("https://open.spotify.com/api/token");
        baseUrl.searchParams.set("reason", "init");
        baseUrl.searchParams.set("productType", "web-player");
        return baseUrl;
    }

    private calculateToken(hex: Array<number>, version: number = 33) {
        const token = hex.map((v, i) => v ^ ((i % version) + 9));
        const bufferToken = Buffer.from(token.join(""), "utf8").toString("hex");
        return Secret.fromHex(bufferToken);
    }

    private async getTokenFallback() {
        try {
            const response = await fetch("https://open.spotify.com/", {
                headers: {
                    "User-Agent": UA,
                    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
                    "Accept-Language": "en-US,en;q=0.5",
                    "Accept-Encoding": "gzip, deflate, br",
                    "DNT": "1",
                    "Connection": "keep-alive",
                    "Upgrade-Insecure-Requests": "1"
                }
            });

            const body = await response.text();

            // Trying multiple patterns to extract the token
            let token = body.match(/"accessToken":"([^"]+)"/)?.[1];

            if (!token) {
                token = body.match(/accessToken["']?\s*:\s*["']([^"']+)["']/)?.[1];
            }
            if (!token) {
                token = body.match(/token["']?\s*:\s*["']([^"']+)["']/)?.[1];
            }

            // Trying multiple patterns to extract the expiration time
            let expiresAfter = Number(body.match(/"accessTokenExpirationTimestampMs":(\d+)/)?.[1]);
            if (!expiresAfter) {
                expiresAfter = Number(body.match(/accessTokenExpirationTimestampMs["']?\s*:\s*(\d+)/)?.[1]);
            }
            if (!expiresAfter) {
                // Default to 1 hour
                expiresAfter = Date.now() + 1000 * 60 * 60;
            }

            if (!token) throw new Error("Could not extract access token from Spotify homepage");

            this.accessToken = {
                token,
                expiresAfter: expiresAfter - 5000,
                type: "Bearer",
            };
        } catch (error) {
            throw new Error("Failed to retrieve access token from Spotify.");
        }
    }

    /**
     * Fetch the latest secrets from remote URL
     */
    private async fetchSecretsFromRemote(): Promise<SpotifySecret[]> {
        try {
            const response = await fetch(this.SECRETS_URL, {
                headers: {
                    'User-Agent': UA,
                    'Accept': 'application/json',
                    'Cache-Control': 'no-cache'
                }
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const secrets = await response.json() as unknown;

            if (!Array.isArray(secrets) || secrets.length === 0) {
                throw new Error('Invalid secrets format received');
            }

            // Validate secrets format
            const validatedSecrets: SpotifySecret[] = [];

            for (const secret of secrets) {
                if (
                    typeof secret === 'object'
                    && secret !== null
                    && typeof (secret as any).version === 'number'
                    && Array.isArray((secret as any).secret)
                ) {
                    validatedSecrets.push(secret as SpotifySecret);
                } else {
                    throw new Error('Invalid secret format');
                }
            }

            return validatedSecrets;
        } catch (error) {
            // console.log(`[Spotify] Failed to fetch secrets from remote: ${error}`);
            throw error;
        }
    }

    /**
     * Get secrets (prioritize cache, re-fetch when expired)
     */
    private async getSecrets(): Promise<SpotifySecret[]> {
        const now = Date.now();

        // Check if cache is valid
        if (this.cachedSecrets && (now - this.secretsCacheTime) < this.CACHE_DURATION) {
            // console.log('[Spotify] Using cached secrets');
            return this.cachedSecrets;
        }

        try {
            // Try to fetch from remote
            const secrets = await this.fetchSecretsFromRemote();

            // Update cache
            this.cachedSecrets = secrets;
            this.secretsCacheTime = now;

            // console.log(`[Spotify] Successfully fetched ${secrets.length} secrets from remote`);
            return secrets;
        } catch (error) {
            // console.log(`[Spotify] Failed to fetch remote secrets: ${error}`);

            // If there's old cache, use old cache
            if (this.cachedSecrets) {
                // console.log('[Spotify] Using expired cache as fallback');
                return this.cachedSecrets;
            }

            // No available secrets, throw error
            throw new Error('No secrets available and unable to fetch from remote');
        }
    }

    /**
     * Get the first available secret
     */
    private async getFirstSecret(): Promise<SpotifySecret> {
        const secrets = await this.getSecrets();

        if (secrets.length === 0) {
            throw new Error('No secrets available');
        }

        return secrets[0];
    }

    /**
     * Remove a failed secret from the cache
     */
    private removeFailedSecret(failedSecret: SpotifySecret): void {
        if (this.cachedSecrets) {
            this.cachedSecrets = this.cachedSecrets.filter(
                secret => !(secret.version === failedSecret.version &&
                    JSON.stringify(secret.secret) === JSON.stringify(failedSecret.secret))
            );
            // console.log(`[Spotify] Removed failed secret version ${failedSecret.version}`);
        }
    }

    /**
     * Force refresh secrets cache
     */
    private async refreshSecrets(): Promise<SpotifySecret[]> {
        try {
            const secrets = await this.fetchSecretsFromRemote();
            this.cachedSecrets = secrets;
            this.secretsCacheTime = Date.now();
            // console.log('[Spotify] Successfully refreshed secrets cache');
            return secrets;
        } catch (error) {
            // console.log(`[Spotify] Failed to refresh secrets: ${error}`);
            throw error;
        }
    }

    private async getAccessTokenUrl() {
        if (this.useCredentials) return "https://accounts.spotify.com/api/token?grant_type=client_credentials";

        let hasRefreshedSecrets = false;

        while (true) {
            try {
                // Try to get the first available secret
                const selectedSecret = await this.getFirstSecret();
                const token = this.calculateToken(selectedSecret.secret, selectedSecret.version);
                // console.log(`[Spotify] Using secret version ${selectedSecret.version}`);

                const url = this.buildTokenUrl();
                const { searchParams } = url;

                const cTime = Date.now();
                const sTime = await fetch("https://open.spotify.com/api/server-time/", {
                    headers: {
                        Referer: "https://open.spotify.com/",
                        Origin: "https://open.spotify.com",
                        "User-Agent": UA,
                    },
                })
                    .then((v) => v.json())
                    .then((v: any) => v.serverTime);

                const totp = new TOTP({
                    secret: token,
                    period: 30,
                    digits: 6,
                    algorithm: "SHA1",
                });

                const totpServer = totp.generate({
                    timestamp: sTime * 1e3,
                });
                const totpClient = totp.generate({
                    timestamp: cTime,
                });

                searchParams.set("sTime", String(sTime));
                searchParams.set("cTime", String(cTime));
                searchParams.set("totp", totpClient);
                searchParams.set("totpServer", totpServer);
                searchParams.set("totpVer", "5");
                searchParams.set("buildVer", String(selectedSecret.version));
                // searchParams.set("buildDate", new Date().toISOString().split('T')[0].replace(/-/g, ''));

                return url;
            } catch (error) {
                // console.log(`[Spotify] Secret failed: ${error}`);

                // If we have cached secrets, try to remove the failed one and continue
                if (this.cachedSecrets && this.cachedSecrets.length > 0) {
                    const failedSecret = this.cachedSecrets[0];
                    this.removeFailedSecret(failedSecret);

                    // If there are still secrets left, continue the loop
                    if (this.cachedSecrets.length > 0) {
                        // console.log(`[Spotify] ${this.cachedSecrets.length} secrets remaining, trying next one...`);
                        continue;
                    }
                }

                // No more secrets available
                if (!hasRefreshedSecrets) {
                    // Try refreshing secrets once
                    // console.log('[Spotify] No more secrets available, refreshing cache and retrying...');
                    try {
                        await this.refreshSecrets();
                        hasRefreshedSecrets = true;
                        continue;
                    } catch (refreshError) {
                        // console.log(`[Spotify] Failed to refresh secrets: ${refreshError}`);
                    }
                }

                // All attempts failed, throw error
                // console.log('[Spotify] All secrets exhausted and refresh failed, using fallback');
                throw new Error('Failed to generate access token URL with all available secrets');
            }
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
