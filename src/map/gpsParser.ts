export interface GpsCoordinate {
  latitude: number;
  longitude: number;
}

const LABELED_LAT_REGEX = /(?:LAT|LATITUDE)[:\s]*([-+]?\d{1,2}\.\d{4,8})\s*([NS])?/i;
const LABELED_LON_REGEX = /(?:LON|LONG|LONGITUDE|LNG)[:\s]*([-+]?\d{1,3}\.\d{4,8})\s*([EW])?/i;
const CARDINAL_LAT_REGEX = /([NS])\s*([-+]?\d{1,2}\.\d{4,8})|([-+]?\d{1,2}\.\d{4,8})\s*([NS])/i;
const CARDINAL_LON_REGEX = /([EW])\s*([-+]?\d{1,3}\.\d{4,8})|([-+]?\d{1,3}\.\d{4,8})\s*([EW])/i;
const GENERIC_COORD_REGEX = /[-+]?\d{1,3}\.\d{4,8}/g;

function isValidPair(lat: number | null, lon: number | null): boolean {
  if (lat === null || lon === null || Number.isNaN(lat) || Number.isNaN(lon)) return false;
  if (Math.abs(lat) > 90.0) return false;
  if (Math.abs(lon) > 180.0) return false;
  if (Math.abs(lat) < 0.0001 && Math.abs(lon) < 0.0001) return false;
  return Math.abs(lat - lon) > 0.0001;
}

export function parseGpsFromOsdText(osdText: string): GpsCoordinate | null {
  if (!osdText) return null;

  const mLat = osdText.match(LABELED_LAT_REGEX);
  const mLon = osdText.match(LABELED_LON_REGEX);
  if (mLat && mLon) {
    let lat = parseFloat(mLat[1]);
    if (mLat[2] && mLat[2].toUpperCase() === 'S') {
      lat = -Math.abs(lat);
    }
    let lon = parseFloat(mLon[1]);
    if (mLon[2] && mLon[2].toUpperCase() === 'W') {
      lon = -Math.abs(lon);
    }
    if (isValidPair(lat, lon)) {
      return { latitude: lat, longitude: lon };
    }
  }

  const cLat = osdText.match(CARDINAL_LAT_REGEX);
  const cLon = osdText.match(CARDINAL_LON_REGEX);
  if (cLat && cLon) {
    const latNumStr = cLat[2] ?? cLat[3];
    const latDir = cLat[1] ?? cLat[4];
    let lat = parseFloat(latNumStr);
    if (latDir && latDir.toUpperCase() === 'S') {
      lat = -Math.abs(lat);
    }

    const lonNumStr = cLon[2] ?? cLon[3];
    const lonDir = cLon[1] ?? cLon[4];
    let lon = parseFloat(lonNumStr);
    if (lonDir && lonDir.toUpperCase() === 'W') {
      lon = -Math.abs(lon);
    }

    if (isValidPair(lat, lon)) {
      return { latitude: lat, longitude: lon };
    }
  }

  const matches = osdText.match(GENERIC_COORD_REGEX);
  if (matches && matches.length >= 2) {
    const numbers = matches.map((s) => parseFloat(s)).filter((n) => !Number.isNaN(n));
    for (let i = 0; i < numbers.length; i++) {
      for (let j = i + 1; j < numbers.length; j++) {
        if (isValidPair(numbers[i], numbers[j])) {
          return { latitude: numbers[i], longitude: numbers[j] };
        }
      }
    }
  }

  return null;
}
