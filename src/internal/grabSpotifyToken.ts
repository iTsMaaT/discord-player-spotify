import { parse } from "node-html-parser";
import * as acorn from "acorn";
import { TOTP, Secret } from "otpauth";
import { Buffer } from "node:buffer";

const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

const SPOTIFY_URLS = [
    "https://open.spotify.com/album/7vI4iTxDmgEN63liQHPEX1",
    "https://open.spotify.com/album/7kFyd5oyJdVX2pIi6P4iHE",
    "https://open.spotify.com/album/6s84u2TUpR3wdUv4NgKA2j",
];

function transformSecret(secret: string): string {
    const shuffle = secret.split("").map((char, index) => char.charCodeAt(0) ^ index % 33 + 9);
    return Buffer.from(shuffle.join(""), "utf8").toString("hex");
}

export interface AnonymousSpotifyTokenResponse {
    clientId: string;
    accessToken: string;
    accessTokenExpirationTimestampMs: number;
    isAnonymous: true;
}

export interface AnonTokenData {
    tokens: AnonymousSpotifyTokenResponse;
    clientToken: string;
    clientVersion: string;
    secrets: SpotifySecret[];
}

export type SpotifySecret = { secret: string; version: number };

interface SPClientTokenResponse {
    granted_token: { token: string };
}

function jsLiteralToObject(str: string): SpotifySecret[] {
    const ast = acorn.parse(str, { ecmaVersion: "latest" });
    const arrays: unknown[] = [];

    const converter = (node: acorn.Node): unknown => {
        switch (node.type) {
            case "ObjectExpression": {
                const obj: Record<string, unknown> = {};
                // @ts-expect-error properties does exist
                for (const prop of node.properties) {
                    if (prop.type === "Property" && prop.key.type === "Identifier") 
                        obj[prop.key.name] = converter(prop.value);
                    
                }
                return obj;
            }
            case "ArrayExpression":
                // @ts-expect-error elements does exist
                return node.elements.map(converter);
            case "Literal":
                // @ts-expect-error value does exist
                return node.value;
            default:
                return null;
        }
    };

    const astWalker = (node?: acorn.Node): void => {
        if (!node || typeof node !== "object") return;
        if (node.type === "ArrayExpression") arrays.push(converter(node));
        for (const key in node) {
            const value = node[key as keyof acorn.Node];
            // @ts-expect-error we know this is an array of nodes, but acorn's types don't reflect that
            if (Array.isArray(value)) value.forEach(astWalker);
            // @ts-expect-error we know this is an array of nodes, but acorn's types don't reflect that
            else astWalker(value);
        }
    };

    astWalker(ast);
    return arrays[0] as SpotifySecret[];
}

export async function grabSpotifyAnonToken(cachedSecrets?: SpotifySecret[]): Promise<AnonTokenData> {
    const spotifyHTML = await fetch(SPOTIFY_URLS[Math.floor(Math.random() * SPOTIFY_URLS.length)], {
        headers: { "User-Agent": USER_AGENT },
    }).then((res) => {
        if (!res.ok) throw new Error(`Failed to fetch Spotify page: ${res.statusText}`);
        return res.text();
    });

    const parsed = parse(spotifyHTML);

    const appConfig = parsed.getElementById("appServerConfig");
    if (!appConfig) throw new Error("Unable to retrieve app config");
    const appConfJson = JSON.parse(Buffer.from(appConfig.textContent, "base64").toString()) as { clientVersion: string };
    const clientVersion = appConfJson.clientVersion;

    let secrets = cachedSecrets;

    if (!secrets) {
        const scriptTags = parsed.querySelectorAll("script");
        const webPlayer = scriptTags.find((tag) => tag.attributes.src?.includes("web-player."));
        if (!webPlayer) throw new Error("Unable to extract web player script");

        const webPlayerScript = await fetch(webPlayer.attributes.src, {
            headers: { "User-Agent": USER_AGENT },
        }).then((res) => {
            if (!res.ok) throw new Error(`Failed to fetch web player script: ${res.statusText}`);
            return res.text();
        });

        const arrayWithObjectRegex = /\[(?:[^[\]]|\[[^[\]]*\])*\]/gm;
        const allArrays = webPlayerScript.match(arrayWithObjectRegex)?.filter((v) => v.includes("secret"));
        const secretRaw = allArrays?.[0];
        if (!secretRaw) throw new Error("Unable to extract secret");

        secrets = jsLiteralToObject(secretRaw).map((v) => ({
            secret: transformSecret(v.secret),
            version: v.version,
        }));
    }

    const totp = new TOTP({
        algorithm: "SHA1",
        digits: 6,
        period: 30,
        secret: Secret.fromHex(secrets[0].secret),
    });

    const serverTime = Math.floor(Date.now() / 1000);
    const totpClient = totp.generate();
    const totpServer = totp.generate({ timestamp: serverTime });

    const tokenUrl = new URL("https://open.spotify.com/api/token");
    tokenUrl.searchParams.set("reason", "init");
    tokenUrl.searchParams.set("productType", "web-player");
    tokenUrl.searchParams.set("totp", totpClient);
    tokenUrl.searchParams.set("totpServer", totpServer);
    tokenUrl.searchParams.set("totpVer", secrets[0].version.toString());

    const tokens = await fetch(tokenUrl.toString(), {
        headers: { "User-Agent": USER_AGENT },
    }).then((res) => {
        if (!res.ok) throw new Error(`Failed to fetch Spotify token: ${res.statusText}`);
        return res.json();
    }) as AnonymousSpotifyTokenResponse;

    const clientTokenResponse = await fetch("https://clienttoken.spotify.com/v1/clienttoken", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
            "Origin": "https://open.spotify.com",
            "Referer": "https://open.spotify.com",
            "Accept": "application/json",
        },
        body: JSON.stringify({
            client_data: {
                client_version: clientVersion,
                client_id: tokens.clientId,
                js_sdk_data: {
                    device_brand: "unknown",
                    device_model: "unknown",
                    os: "linux",
                    os_version: "unknown",
                    device_id: crypto.randomUUID(),
                    device_type: "computer",
                },
            },
        }),
    }).then((res) => res.json()) as SPClientTokenResponse;

    return {
        tokens,
        clientToken: clientTokenResponse.granted_token.token,
        clientVersion,
        secrets, // cache for ~6 hours (re-use on subsequent token refreshes)
    };
}
