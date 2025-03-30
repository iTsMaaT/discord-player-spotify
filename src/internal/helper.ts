export const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36 Edg/109.0.1518.49";

export const market = "";

export const spotifyUrlRegex = 
  /^(?:https:\/\/open\.spotify\.com\/(intl-([a-z]|[A-Z]){0,3}\/)?(?:user\/[A-Za-z0-9]+\/)?|spotify:)(album|playlist|track)(?:[/:])([A-Za-z0-9]+).*$/;

export const spotifySongRegex = 
  /^https?:\/\/(?:embed\.|open\.)(?:spotify\.com\/)(intl-([a-z]|[A-Z])+\/)?(?:track\/|\?uri=spotify:track:)((\w|-){22})(\?si=.+)?$/;

export const spotifyPlaylistRegex = 
  /^https?:\/\/(?:embed\.|open\.)(?:spotify\.com\/)(intl-([a-z]|[A-Z])+\/)?(?:playlist\/|\?uri=spotify:playlist:)((\w|-){22})(\?si=.+)?$/;

export const spotifyAlbumRegex = 
  /^https?:\/\/(?:embed\.|open\.)(?:spotify\.com\/)(intl-([a-z]|[A-Z])+\/)?(?:album\/|\?uri=spotify:album:)((\w|-){22})(\?si=.+)?$/;

export interface SpotifyUrlParseResult {
    queryType: string;
    id: string;
}

export const isUrl = (query: string): boolean => {
    try {
        return ["http:", "https:"].includes(new URL(query).protocol);
    } catch {
        return false;
    }
};

export const parseSpotifyUrl = (q: string): SpotifyUrlParseResult => {
    const [, , , queryType, id] = spotifyUrlRegex.exec(q) || [];
    return { queryType, id };
};