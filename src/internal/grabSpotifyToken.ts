import { parse } from "node-html-parser";
import * as acorn from "acorn"
import { TOTP, Secret } from "otpauth";

const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

const SPOTIFY_URLS = [
    "https://open.spotify.com/album/7vI4iTxDmgEN63liQHPEX1",
    "https://open.spotify.com/album/7kFyd5oyJdVX2pIi6P4iHE",
    "https://open.spotify.com/album/6s84u2TUpR3wdUv4NgKA2j"
]

function transformSecret(secret: string) {
    const shuffle = secret.split("").map((char, index) => char.charCodeAt(0) ^ index % 33 + 9);
    const hex = Buffer.from(shuffle.join(""), "utf8").toString("hex");

    return hex;
}

export interface AnonymousSpotifyTokenResponse {
    clientId: string;
    accessToken: string;
    accessTokenExpirationTimestampMs: number;
    isAnonymous: true;
}

function jsLiteralToObject(str: string) {
    const ast = acorn.parse(str, { ecmaVersion: "latest" });
    const arrays: { secret: string, version: number }[] = [];

    const converter = (node: acorn.Node) => {
        switch (node.type) {
            case "ObjectExpression": {
                const obj: Record<string, unknown> = {};
                // @ts-expect-error properties does exist
                for (const prop of node.properties) {
                    if (prop.type === "Property" && prop.key.type === "Identifier") {
                        obj[prop.key.name] = converter(prop.value);
                    }
                }
                return obj;
            }
            case "ArrayExpression": {
                // @ts-expect-error element does exists
                return node.elements.map(converter);
            }
            case "Literal": {
                // @ts-expect-error value does exists
                return node.value;
            }
            default:
                return null;
        }
    }

    const astWalker = (node?: acorn.Node) => {
        if (!node || typeof node !== "object") return;
        if (node.type === "ArrayExpression") {
            arrays.push(converter(node));
        }

        for (const key in node) {
            const value = node[key as keyof acorn.Node];
            // @ts-ignore we know this is an array of nodes, but acorn's types don't reflect that
            if (Array.isArray(value)) value.forEach(astWalker);
            // @ts-ignore we know this is an array of nodes, but acorn's types don't reflect that
            else astWalker(value);
        }
    }

    astWalker(ast);

    return arrays[0] as unknown as { secret: string, version: number }[];
}

export async function grabSpotifyAnonToken() {
    const spotifyHTML = await fetch(SPOTIFY_URLS[Math.floor(Math.random() * SPOTIFY_URLS.length)], {
        headers: {
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36"
        }
    })
        .then(res => {
            if (!res.ok) throw new Error(`Failed to fetch Spotify page: ${res.statusText}`);
            return res.text();
        });

    const parsed = parse(spotifyHTML);

    const scriptTags = parsed.querySelectorAll("script");

    const webPlayer = scriptTags.find(tag => tag.attributes.src?.includes("web-player."));

    if (!webPlayer) {
        throw new Error("Unable to extract web player script");
    }

    const webPlayerUrl = webPlayer.attributes.src;
    const webPlayerScript = await fetch(webPlayerUrl, {
        headers: {
            "User-Agent": USER_AGENT
        }
    }).then(res => {
        if (!res.ok) throw new Error(`Failed to fetch web player script: ${res.statusText}`);
        return res.text();
    });

    const arrayWithObjectRegex = /\[(?:[^\[\]]|\[[^\[\]]*\])*\]/gm;

    const allArrays = webPlayerScript.match(arrayWithObjectRegex)?.filter(v => v.includes("secret"))
    const secret = allArrays?.[0];

    if (!secret) throw new Error("Unable to extract secret");

    const parsedSecret = jsLiteralToObject(secret).map(v => ({ secret: transformSecret(v.secret), version: v.version }));

    const totp = new TOTP({
        algorithm: "SHA1",
        digits: 6,
        period: 30,
        secret: Secret.fromHex(parsedSecret[0].secret)
    });

    const serverTime = Math.floor(Date.now() / 1000);
    const totpClient = totp.generate();
    const totpServer = totp.generate({
        timestamp: serverTime
    });

    const url = new URL("https://open.spotify.com/api/token");
    const searchParams = url.searchParams;

    searchParams.set("reason", "init");
    searchParams.set("productType", "web-player");
    searchParams.set("totp", totpClient);
    searchParams.set("totpServer", totpServer);
    searchParams.set("totpVer", parsedSecret[0].version.toString());

    console.log("SPOTIFY TOKEN URL", url.toString());

    const tokenResponse = await fetch(url.toString(), {
        headers: {
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36"
        }
    }).then(res => {
        if (!res.ok) throw new Error(`Failed to fetch Spotify token: ${res.statusText}`);
        return res.json();
    });

    return {
        tokens: tokenResponse as AnonymousSpotifyTokenResponse,
        secrets: parsedSecret // cache this for around 6 hours
    }
}