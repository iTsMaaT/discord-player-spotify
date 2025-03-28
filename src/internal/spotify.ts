import { UA, market } from "./helper";

const SP_ACCESS_TOKEN_URL =
  "https://accounts.spotify.com/api/token?grant_type=client_credentials";
const SP_BASE = "https://api.spotify.com/v1";

interface SP_ACCESS_TOKEN {
  token: string;
  expiresAfter: number;
  type: "Bearer";
}

export class SpotifyAPI {
    public accessToken: SP_ACCESS_TOKEN | null = null;
    private clientId: string;
    private clientSecret: string;
    private market: string;

    constructor(credentials: { clientId: string; clientSecret: string, market?: string }) {
        if (!credentials.clientId || !credentials.clientSecret) 
            throw new Error("Spotify clientId and clientSecret are required.");
    
        this.clientId = credentials.clientId;
        this.clientSecret = credentials.clientSecret;
        this.market = credentials.market || market;
    }

    private get authorizationKey() {
        return Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64");
    }

    public async requestToken() {
        try {
            const res = await fetch(SP_ACCESS_TOKEN_URL, {
                method: "POST",
                headers: {
                    "User-Agent": UA,
                    Authorization: `Basic ${this.authorizationKey}`,
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                body: "grant_type=client_credentials",
            });
    
            const body = await res.json();
    
            if (!body.access_token) 
                throw new Error("Failed to retrieve access token.");
          
    
            this.accessToken = {
                token: body.access_token,
                expiresAfter: Date.now() + body.expires_in * 1000,
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
        if (this.isTokenExpired()) 
            await this.requestToken();
        
    }

    public async search(query: string) {
        await this.ensureValidToken();

        try {
            const res = await fetch(
                `${SP_BASE}/search/?q=${encodeURIComponent(query)}&type=track&market=${this.market}`,
                {
                    headers: {
                        "User-Agent": UA,
                        Authorization: `${this.accessToken!.type} ${this.accessToken!.token}`,
                        "Content-Type": "application/json",
                    },
                },
            );

            if (!res.ok) 
                throw new Error("Failed to search Spotify.");
      

            const data: { tracks: { items: SpotifyTrack[] } } = await res.json();

            return data.tracks.items.map((m) => ({
                title: m.name,
                duration: m.duration_ms,
                artist: m.artists.map((artist) => artist.name).join(", "),
                url:
          m.external_urls?.spotify || `https://open.spotify.com/track/${m.id}`,
                thumbnail: m.album.images?.[0]?.url || null,
            }));
        } catch {
            return null;
        }
    }

    public async getPlaylist(id: string) {
        if (!this.clientId || !this.clientSecret) 
            throw new Error("Spotify clientId and clientSecret are required.");

        try {
            await this.ensureValidToken();

            const res = await fetch(`${SP_BASE}/playlists/${id}?market=${this.market}`, {
                headers: {
                    "User-Agent": UA,
                    Authorization: `${this.accessToken!.type} ${this.accessToken!.token}`,
                    "Content-Type": "application/json",
                },
            });
            if (!res.ok) return null;

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
                    const nextRes = await fetch(next, {
                        headers: {
                            "User-Agent": UA,
                            Authorization: `${this.accessToken!.type} ${this.accessToken!.token}`,
                            "Content-Type": "application/json",
                        },
                    });
                    if (!nextRes.ok) break;
                    const nextPage: { items: { track: SpotifyTrack }[]; next?: string } =
            await nextRes.json();

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
                url:
          data.external_urls.spotify ||
          `https://open.spotify.com/playlist/${id}`,
                tracks,
            };
        } catch (err) {
            return null;
        }
    }

    public async getAlbum(id: string) {
        if (!this.clientId || !this.clientSecret) 
            throw new Error("Spotify clientId and clientSecret are required.");

        try {
            await this.ensureValidToken();

            const res = await fetch(`${SP_BASE}/albums/${id}?market=${this.market}`, {
                headers: {
                    "User-Agent": UA,
                    Authorization: `${this.accessToken!.type} ${this.accessToken!.token}`,
                    "Content-Type": "application/json",
                },
            });
            if (!res.ok) return null;

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
                    const nextRes = await fetch(next, {
                        headers: {
                            "User-Agent": UA,
                            Authorization: `${this.accessToken!.type} ${this.accessToken!.token}`,
                            "Content-Type": "application/json",
                        },
                    });
                    if (!nextRes.ok) break;
                    const nextPage: { items: SpotifyTrack[]; next?: string } =
            await nextRes.json();

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
                url:
          data.external_urls.spotify || `https://open.spotify.com/album/${id}`,
                tracks,
            };
        } catch {
            return null;
        }
    }

    public async getTrack(id: string) {
        if (!this.clientId || !this.clientSecret) 
            throw new Error("Spotify clientId and clientSecret are required.");

        try {
            await this.ensureValidToken();

            const res = await fetch(`${SP_BASE}/tracks/${id}?market=${this.market}`, {
                headers: {
                    "User-Agent": UA,
                    Authorization: `${this.accessToken!.type} ${this.accessToken!.token}`,
                    "Content-Type": "application/json",
                },
            });
            if (!res.ok) return null;

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