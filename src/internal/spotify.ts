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

export class SpotifyAPI {
    public accessToken: SP_ACCESS_TOKEN | null = null;
    private clientId: string | undefined;
    private clientSecret: string | undefined;
    private market: string;
    public useCredentials: boolean = false;

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
            console.error("Error requesting Spotify access token:", error);
            throw error;
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
            const res = await this.fetchData(`${SP_BASE}/search/?q=${encodeURIComponent(query)}&type=track&market=${this.market}`);
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
            const res = await this.fetchData(`${SP_BASE}/playlists/${id}?market=${this.market}`);
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

            const tracks = t.map(({ track: m }) => ({
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
        if (!this.clientId || !this.clientSecret) throw new Error("Spotify clientId and clientSecret are required.");

        try {
            const res = await this.fetchData(`${SP_BASE}/albums/${id}?market=${this.market}`);
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

            const tracks = t.map((m) => ({
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
            const res = await this.fetchData(`${SP_BASE}/tracks/${id}?market=${this.market}`);
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
                `${SP_BASE}/recommendations/?seed_tracks=${trackIds.join(",")}&limit=${limit || "100"}&market=${this.market}`,
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

    private buildTokenUrl() {
        const baseUrl = new URL("https://open.spotify.com/get_access_token");
        baseUrl.searchParams.set("reason", "init");
        baseUrl.searchParams.set("productType", "web-player");
        return baseUrl;
    }

    private calculateToken(hex: Array<number>) {
        const token = hex.map((v, i) => v ^ ((i % 33) + 9));
        const bufferToken = Buffer.from(token.join(""), "utf8").toString("hex");
        return Secret.fromHex(bufferToken);
    }

    private async getAccessTokenUrl() {
        if (this.useCredentials) return "https://accounts.spotify.com/api/token?grant_type=client_credentials";

        const token = this.calculateToken([12, 56, 76, 33, 88, 44, 88, 33, 78, 78, 11, 66, 22, 22, 55, 69, 54]);

        const spotifyHtml = await fetch("https://open.spotify.com", {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
            },
        }).then((v) => v.text());
        const root = parse(spotifyHtml);
        const scriptTags = root.querySelectorAll("script");
        const playerSrc = scriptTags.find((v) => v.getAttribute("src")?.includes("web-player/web-player."))?.getAttribute("src");
        if (!playerSrc) throw new Error("Could not find player script source");
        const playerScript = await fetch(playerSrc, {
            headers: {
                Dnt: "1",
                Referer: "https://open.spotify.com/",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
            },
        }).then((v) => v.text());

        const playerVerSplit = playerScript.split("buildVer");
        const versionString = `{"buildVer"${playerVerSplit[1].split("}")[0].replace("buildDate", "\"buildDate\"")}}`;
        const version = JSON.parse(versionString);

        const url = this.buildTokenUrl();
        const { searchParams } = url;

        const cTime = Date.now();
        const sTime = await fetch("https://open.spotify.com/server-time", {
            headers: {
                Referer: "https://open.spotify.com/",
                Origin: "https://open.spotify.com",
            },
        })
            .then((v) => v.json())
            .then((v) => v.serverTime);

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
        searchParams.set("buildVer", version.buildVer);
        searchParams.set("buildDate", version.buildDate);

        return url;
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
