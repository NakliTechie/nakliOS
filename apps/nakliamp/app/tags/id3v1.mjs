// NakliAmp tags: keep a trailing ID3v1 tag in step with an ID3v2 edit.
//
// Many MP3s end with a 128-byte ID3v1 tag after the audio. A player that reads
// only ID3v1 would show the old title after an edit, so the fields the patch
// changes are written into the ID3v1 tag too. Fields the patch does not name
// stay byte for byte. ID3v1 holds 30 Latin-1 bytes per text field: longer text
// is cut, and a character outside Latin-1 becomes "?".
//
// Pure: bytes in, bytes out.

export const ID3V1_SIZE = 128;

// The 80 genres of the original ID3v1 list, by number.
const GENRES = [
  'Blues', 'Classic Rock', 'Country', 'Dance', 'Disco', 'Funk', 'Grunge', 'Hip-Hop', 'Jazz', 'Metal',
  'New Age', 'Oldies', 'Other', 'Pop', 'R&B', 'Rap', 'Reggae', 'Rock', 'Techno', 'Industrial',
  'Alternative', 'Ska', 'Death Metal', 'Pranks', 'Soundtrack', 'Euro-Techno', 'Ambient', 'Trip-Hop', 'Vocal', 'Jazz+Funk',
  'Fusion', 'Trance', 'Classical', 'Instrumental', 'Acid', 'House', 'Game', 'Sound Clip', 'Gospel', 'Noise',
  'AlternRock', 'Bass', 'Soul', 'Punk', 'Space', 'Meditative', 'Instrumental Pop', 'Instrumental Rock', 'Ethnic', 'Gothic',
  'Darkwave', 'Techno-Industrial', 'Electronic', 'Pop-Folk', 'Eurodance', 'Dream', 'Southern Rock', 'Comedy', 'Cult', 'Gangsta',
  'Top 40', 'Christian Rap', 'Pop/Funk', 'Jungle', 'Native American', 'Cabaret', 'New Wave', 'Psychadelic', 'Rave', 'Showtunes',
  'Trailer', 'Lo-Fi', 'Tribal', 'Acid Punk', 'Acid Jazz', 'Polka', 'Retro', 'Musical', 'Rock & Roll', 'Hard Rock',
];

/** True when `tail` (the last 128 bytes of a file) is an ID3v1 tag. */
export function isId3v1(tail) {
  return tail?.length === ID3V1_SIZE && tail[0] === 0x54 && tail[1] === 0x41 && tail[2] === 0x47;
}

function writeText(out, offset, length, text) {
  out.fill(0, offset, offset + length);
  if (text === null || text === undefined) return;
  const value = String(text);
  for (let index = 0; index < Math.min(length, value.length); index += 1) {
    const code = value.charCodeAt(index);
    out[offset + index] = code <= 0xff ? code : 0x3f;
  }
}

function genreIndex(genre) {
  if (genre === null) return 255;
  const index = GENRES.findIndex((name) => name.toLowerCase() === String(genre).toLowerCase());
  return index < 0 ? 255 : index;
}

/**
 * Apply a normalised NakliAmp patch to an ID3v1 tag. Returns the new 128
 * bytes. Only title, artist, album, year, genre and track number change.
 * A track number is stored only in the ID3v1.1 layout, where comment byte 29
 * is zero; an ID3v1.0 comment that fills all 30 bytes is left alone.
 */
export function patchId3v1(tail, clean) {
  const out = new Uint8Array(tail);
  if ('title' in clean) writeText(out, 3, 30, clean.title);
  if ('artist' in clean) writeText(out, 33, 30, clean.artist);
  if ('album' in clean) writeText(out, 63, 30, clean.album);
  if ('year' in clean) writeText(out, 93, 4, clean.year === null ? null : String(clean.year).padStart(4, '0'));
  if ('genre' in clean) out[127] = genreIndex(clean.genre);
  if ('trackNo' in clean && (out[125] === 0)) out[126] = clean.trackNo === null ? 0 : Math.min(255, clean.trackNo);
  return out;
}

/** True when the patch names a field ID3v1 holds. */
export function touchesId3v1(clean) {
  return ['title', 'artist', 'album', 'year', 'genre', 'trackNo'].some((field) => field in clean);
}
