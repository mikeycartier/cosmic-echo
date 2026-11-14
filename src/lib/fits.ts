const FITS_BLOCK_SIZE = 2880;
const FITS_CARD_SIZE = 80;
const fitsDecoder = new TextDecoder();
const MAX_STRETCH_SAMPLES = 250_000;

interface FitsImageHdu {
  dataOffset: number;
  dataByteLength: number;
  bitpix: number;
  pixelCount: number;
  axisLengths: number[];
  bscale: number;
  bzero: number;
  blank: number | null;
  compressed: boolean;
  headerCards: string[];
  header: Map<string, string>;
}

function parseCardValue(card: string): string {
  const raw = card.slice(10).trim();
  if (raw.startsWith("'")) {
    const end = raw.indexOf("'", 1);
    return (end < 0 ? raw.slice(1) : raw.slice(1, end)).trim();
  }
  return raw.split("/", 1)[0].trim();
}

function readImageHdu(data: ArrayBuffer): FitsImageHdu | null {
  const bytes = new Uint8Array(data);
  if (
    bytes.length < FITS_BLOCK_SIZE ||
    fitsDecoder.decode(bytes.subarray(0, 9)) !== "SIMPLE  ="
  ) {
    return null;
  }

  let offset = 0;
  while (offset + FITS_BLOCK_SIZE <= bytes.length) {
    const header = new Map<string, string>();
    const headerCards: string[] = [];
    let endOfHeader = -1;

    for (
      let cardOffset = offset;
      cardOffset + FITS_CARD_SIZE <= bytes.length;
      cardOffset += FITS_CARD_SIZE
    ) {
      const card = fitsDecoder.decode(bytes.subarray(cardOffset, cardOffset + FITS_CARD_SIZE));
      headerCards.push(card);
      const key = card.slice(0, 8).trim();
      if (key === "END") {
        endOfHeader = cardOffset + FITS_CARD_SIZE;
        break;
      }
      if (key && card[8] === "=") {
        header.set(key, parseCardValue(card));
      }
    }

    if (endOfHeader < 0) return null;
    const dataOffset =
      offset + Math.ceil((endOfHeader - offset) / FITS_BLOCK_SIZE) * FITS_BLOCK_SIZE;

    if (
      (offset === 0 && Number(header.get("NAXIS")) >= 2) ||
      header.get("XTENSION")?.toUpperCase() === "IMAGE" ||
      header.get("EXTNAME")?.toUpperCase() === "IMAGE"
    ) {
      const bitpix = Math.abs(Number(header.get("BITPIX")));
      const axisCount = Number(header.get("NAXIS"));
      if (
        ![8, 16, 32, 64].includes(bitpix) &&
        ![-32, -64].includes(Number(header.get("BITPIX")))
      ) {
        return null;
      }
      if (!Number.isInteger(axisCount) || axisCount < 2) return null;

      let pixelCount = 1;
      const axisLengths: number[] = [];
      for (let axis = 1; axis <= axisCount; axis += 1) {
        const length = Number(header.get(`NAXIS${axis}`));
        if (!Number.isSafeInteger(length) || length < 0) return null;
        pixelCount *= length;
        axisLengths.push(length);
      }
      const bytesPerPixel = bitpix / 8;
      const dataByteLength = pixelCount * bytesPerPixel;
      if (
        !Number.isSafeInteger(pixelCount) ||
        !Number.isSafeInteger(dataByteLength) ||
        dataOffset + dataByteLength > bytes.length
      ) {
        return null;
      }

      const bscale = Number(header.get("BSCALE") ?? "1");
      const bzero = Number(header.get("BZERO") ?? "0");
      const blankValue = header.get("BLANK");
      const blank = blankValue === undefined ? null : Number(blankValue);
      if (!Number.isFinite(bscale) || !Number.isFinite(bzero)) return null;

      return {
        dataOffset,
        dataByteLength,
        bitpix: Number(header.get("BITPIX")),
        pixelCount,
        axisLengths,
        bscale,
        bzero,
        blank: blank !== null && Number.isFinite(blank) ? blank : null,
        compressed: header.get("ZIMAGE")?.toUpperCase() === "T",
        headerCards,
        header,
      };
    }

    const bitpix = Math.abs(Number(header.get("BITPIX")));
    const axisCount = Number(header.get("NAXIS"));
    if (!Number.isFinite(bitpix) || !Number.isInteger(axisCount) || axisCount < 0) {
      return null;
    }
    let pixelCount = axisCount === 0 ? 0 : 1;
    for (let axis = 1; axis <= axisCount; axis += 1) {
      const length = Number(header.get(`NAXIS${axis}`));
      if (!Number.isSafeInteger(length) || length < 0) return null;
      pixelCount *= length;
    }

    const parameterCount = Number(header.get("PCOUNT") ?? "0");
    const groupCount = Number(header.get("GCOUNT") ?? "1");
    const dataBytes = (pixelCount * bitpix / 8 + parameterCount) * groupCount;
    if (!Number.isFinite(dataBytes) || dataBytes < 0) return null;

    const nextOffset =
      dataOffset + Math.ceil(dataBytes / FITS_BLOCK_SIZE) * FITS_BLOCK_SIZE;
    if (nextOffset <= offset || nextOffset >= bytes.length) return null;
    offset = nextOffset;
  }

  return null;
}

export function hasFitsImageHdu(data: ArrayBuffer): boolean {
  return readImageHdu(data) !== null;
}

function numberFromHeader(header: Map<string, string>, key: string, fallback?: number): number | null {
  const raw = header.get(key);
  if (raw === undefined) return fallback ?? null;
  const value = Number(raw.replace(/[dD]/, "E"));
  return Number.isFinite(value) ? value : null;
}

function getSipDistortion(
  header: Map<string, string>,
  prefix: "A" | "B",
  u: number,
  v: number,
): number {
  let distortion = 0;
  for (const [key, raw] of header) {
    const match = new RegExp(`^${prefix}_(\\d+)_(\\d+)$`).exec(key);
    if (!match) continue;
    const coefficient = Number(raw.replace(/[dD]/, "E"));
    if (Number.isFinite(coefficient)) {
      distortion += coefficient * u ** Number(match[1]) * v ** Number(match[2]);
    }
  }
  return distortion;
}

function getPixelForCoordinate(
  hdu: FitsImageHdu,
  ra: number,
  dec: number,
): [number, number] | null {
  const crval1 = numberFromHeader(hdu.header, "CRVAL1");
  const crval2 = numberFromHeader(hdu.header, "CRVAL2");
  const crpix1 = numberFromHeader(hdu.header, "CRPIX1");
  const crpix2 = numberFromHeader(hdu.header, "CRPIX2");
  const cdelt1 = numberFromHeader(hdu.header, "CDELT1", 1);
  const cdelt2 = numberFromHeader(hdu.header, "CDELT2", 1);
  if (
    crval1 === null ||
    crval2 === null ||
    crpix1 === null ||
    crpix2 === null ||
    cdelt1 === null ||
    cdelt2 === null
  ) {
    return null;
  }

  const cd11 = numberFromHeader(
    hdu.header,
    "CD1_1",
    cdelt1 * (numberFromHeader(hdu.header, "PC1_1", 1) ?? 1),
  );
  const cd12 = numberFromHeader(
    hdu.header,
    "CD1_2",
    cdelt1 * (numberFromHeader(hdu.header, "PC1_2", 0) ?? 0),
  );
  const cd21 = numberFromHeader(
    hdu.header,
    "CD2_1",
    cdelt2 * (numberFromHeader(hdu.header, "PC2_1", 0) ?? 0),
  );
  const cd22 = numberFromHeader(
    hdu.header,
    "CD2_2",
    cdelt2 * (numberFromHeader(hdu.header, "PC2_2", 1) ?? 1),
  );
  if (cd11 === null || cd12 === null || cd21 === null || cd22 === null) return null;

  const radians = Math.PI / 180;
  const ra0 = crval1 * radians;
  const dec0 = crval2 * radians;
  const targetRa = ra * radians;
  const targetDec = dec * radians;
  const deltaRa = ((targetRa - ra0 + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  const denominator =
    Math.sin(dec0) * Math.sin(targetDec) +
    Math.cos(dec0) * Math.cos(targetDec) * Math.cos(deltaRa);
  if (denominator <= 0) return null;

  const xi =
    (Math.cos(targetDec) * Math.sin(deltaRa) / denominator) / radians;
  const eta =
    (
      Math.cos(dec0) * Math.sin(targetDec) -
      Math.sin(dec0) * Math.cos(targetDec) * Math.cos(deltaRa)
    ) /
    denominator /
    radians;
  const determinant = cd11 * cd22 - cd12 * cd21;
  if (!Number.isFinite(determinant) || determinant === 0) return null;

  const distortedU = (xi * cd22 - cd12 * eta) / determinant;
  const distortedV = (cd11 * eta - cd21 * xi) / determinant;
  let u = distortedU;
  let v = distortedV;
  for (let iteration = 0; iteration < 8; iteration += 1) {
    u = distortedU - getSipDistortion(hdu.header, "A", u, v);
    v = distortedV - getSipDistortion(hdu.header, "B", u, v);
  }
  const x = crpix1 + u;
  const y = crpix2 + v;
  return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
}

function updateFitsCard(card: string, value: string | number): string {
  const commentOffset = card.indexOf("/", 10);
  const comment = commentOffset < 0 ? "" : ` ${card.slice(commentOffset)}`;
  const formatted = typeof value === "number" ? String(value) : `'${value}'`;
  return `${card.slice(0, 10)}${formatted.padStart(20)}${comment}`
    .padEnd(FITS_CARD_SIZE, " ")
    .slice(0, FITS_CARD_SIZE);
}

export function normalizeFitsImageHdu(
  data: ArrayBuffer,
  center?: { ra: number; dec: number },
): ArrayBuffer | null {
  const hdu = readImageHdu(data);
  if (!hdu || hdu.compressed || hdu.axisLengths.length !== 2) return null;
  const targetPixel = center
    ? getPixelForCoordinate(hdu, center.ra, center.dec)
    : null;
  const updatedValues = new Map<string, string | number>();
  if (center && targetPixel) {
    updatedValues.set("CRPIX1", targetPixel[0]);
    updatedValues.set("CRPIX2", targetPixel[1]);
    updatedValues.set("CRVAL1", center.ra);
    updatedValues.set("CRVAL2", center.dec);
    updatedValues.set("CTYPE1", "RA---TAN");
    updatedValues.set("CTYPE2", "DEC--TAN");
  }

  const structuralKeys = new Set([
    "SIMPLE",
    "XTENSION",
    "BITPIX",
    "NAXIS",
    "PCOUNT",
    "GCOUNT",
    "EXTEND",
    "EXTNAME",
    "EXTTYPE",
    "END",
  ]);
  const cards = [
    "SIMPLE  =                    T",
    `BITPIX  = ${String(hdu.bitpix).padStart(20)}`,
    "NAXIS   =                    2",
    ...hdu.axisLengths.map(
      (length, index) => `NAXIS${index + 1}  = ${String(length).padStart(20)}`,
    ),
    "EXTEND  =                    T",
    ...hdu.headerCards.filter((card) => {
      const key = card.slice(0, 8).trim();
      return (
        !structuralKeys.has(key) &&
        !/^NAXIS\d+$/.test(key) &&
        !/^(A|B|AP|BP)_(ORDER|\d+_\d+)$/.test(key)
      );
    }).map((card) => {
      const key = card.slice(0, 8).trim();
      const value = updatedValues.get(key);
      return value === undefined ? card : updateFitsCard(card, value);
    }),
    "END",
  ];
  const headerByteLength =
    Math.ceil((cards.length * FITS_CARD_SIZE) / FITS_BLOCK_SIZE) * FITS_BLOCK_SIZE;
  const dataByteLength =
    Math.ceil(hdu.dataByteLength / FITS_BLOCK_SIZE) * FITS_BLOCK_SIZE;
  const normalized = new Uint8Array(headerByteLength + dataByteLength);
  normalized.fill(0x20, 0, headerByteLength);
  const encoder = new TextEncoder();
  cards.forEach((card, index) => {
    normalized.set(
      encoder.encode(card.padEnd(FITS_CARD_SIZE, " ").slice(0, FITS_CARD_SIZE)),
      index * FITS_CARD_SIZE,
    );
  });
  normalized.set(
    new Uint8Array(data, hdu.dataOffset, hdu.dataByteLength),
    headerByteLength,
  );
  return normalized.buffer;
}

function readPixel(view: DataView, offset: number, bitpix: number): number {
  switch (bitpix) {
    case 8:
      return view.getUint8(offset);
    case 16:
      return view.getInt16(offset, false);
    case 32:
      return view.getInt32(offset, false);
    case 64:
      return view.getInt32(offset, false) * 4_294_967_296 +
        view.getUint32(offset + 4, false);
    case -32:
      return view.getFloat32(offset, false);
    case -64:
      return view.getFloat64(offset, false);
    default:
      return Number.NaN;
  }
}

export function getFitsPercentileCuts(
  data: ArrayBuffer,
  lowPercentile = 5,
  highPercentile = 99.5,
): [number, number] | null {
  if (
    lowPercentile < 0 ||
    highPercentile > 100 ||
    lowPercentile >= highPercentile
  ) {
    return null;
  }

  const hdu = readImageHdu(data);
  if (!hdu || hdu.compressed) return null;

  const bytesPerPixel = Math.abs(hdu.bitpix) / 8;
  const step = Math.max(1, Math.ceil(hdu.pixelCount / MAX_STRETCH_SAMPLES));
  const samples = new Float64Array(Math.ceil(hdu.pixelCount / step));
  const view = new DataView(data);
  let count = 0;

  for (let index = 0; index < hdu.pixelCount; index += step) {
    const offset = hdu.dataOffset + index * bytesPerPixel;
    const raw = readPixel(view, offset, hdu.bitpix);
    if (!Number.isFinite(raw) || (hdu.blank !== null && raw === hdu.blank)) continue;
    const value = raw * hdu.bscale + hdu.bzero;
    if (Number.isFinite(value)) samples[count++] = value;
  }
  if (count === 0) return null;

  const sorted = samples.subarray(0, count).sort();
  const percentile = (position: number) => {
    const index = (count - 1) * (position / 100);
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
  };
  const low = percentile(lowPercentile);
  const high = percentile(highPercentile);
  return high > low ? [low, high] : [low, low + 1];
}
