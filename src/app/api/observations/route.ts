import { NextRequest, NextResponse } from "next/server";
import { XMLParser } from "fast-xml-parser";
import type { Detector, Observation } from "@/lib/spherex";

const SEARCH_RADIUS_DEG = 0.01;

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  parseTagValue: false,
  trimValues: true,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function asText(value: unknown): string | null {
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  if (isRecord(value) && typeof value["#text"] === "string") {
    return value["#text"];
  }
  return null;
}

function getField(record: Record<string, unknown>, name: string): unknown {
  const key = Object.keys(record).find((candidate) => candidate.toLowerCase() === name);
  return key ? record[key] : undefined;
}

function toRows(xml: string): Record<string, unknown>[] {
  let payload: unknown;
  try {
    payload = xmlParser.parse(xml);
  } catch {
    throw new Error("IRSA returned an invalid VOTable response.");
  }

  if (!isRecord(payload)) {
    throw new Error("IRSA returned an unexpected VOTable response.");
  }

  const votable = payload.VOTABLE;
  if (!isRecord(votable)) {
    throw new Error("IRSA returned an unexpected VOTable response.");
  }

  const resources = asArray(votable.RESOURCE).filter(isRecord);
  const tableResource = resources.find((resource) => isRecord(resource.TABLE));
  const queryStatus = resources
    .flatMap((resource) => asArray(resource.INFO))
    .find(
      (info) =>
        isRecord(info) &&
        info.name === "QUERY_STATUS" &&
        String(info.value).toUpperCase() === "ERROR",
    );

  if (queryStatus) {
    const message = asText(queryStatus) ?? "IRSA reported an archive query error.";
    throw new Error(message);
  }

  if (!tableResource || !isRecord(tableResource.TABLE)) {
    throw new Error("IRSA returned no observation table.");
  }

  const table = tableResource.TABLE;
  const fields = asArray(table.FIELD)
    .filter(isRecord)
    .map((field) => (typeof field.name === "string" ? field.name.toLowerCase() : ""));
  const data = isRecord(table.DATA) && isRecord(table.DATA.TABLEDATA)
    ? asArray(table.DATA.TABLEDATA.TR)
    : [];

  if (data.length === 0) return [];

  if (fields.length === 0 || !data.every(isRecord)) {
    throw new Error("IRSA returned observation data in an unsupported VOTable format.");
  }

  return data.map((row) => {
    const cells = asArray(row.TD);
    return Object.fromEntries(
      fields.flatMap((field, index) =>
        field ? [[field, asText(cells[index])]] : [],
      ),
    );
  });
}

function parseObservationTime(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date((value - 40587) * 86_400_000).toISOString();
  }

  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 30_000 && numeric < 100_000) {
      return new Date((numeric - 40587) * 86_400_000).toISOString();
    }

    const timestamp = Date.parse(value);
    return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
  }

  return null;
}

function parseObservation(record: Record<string, unknown>, index: number): Observation | null {
  const accessUrl = getField(record, "access_url");
  if (typeof accessUrl !== "string") return null;
  const detectorMatch = /D([1-6])_spx/i.exec(accessUrl);
  if (!detectorMatch) return null;

  try {
    const parsedUrl = new URL(accessUrl);
    if (
      parsedUrl.hostname !== "irsa.ipac.caltech.edu" ||
      !parsedUrl.pathname.startsWith("/ibe/data/spherex/")
    ) {
      return null;
    }
  } catch {
    return null;
  }

  const id = getField(record, "obs_id");
  const collection = getField(record, "obs_collection");
  const exposure = Number(getField(record, "t_exptime"));

  return {
    id: typeof id === "string" ? id : `spherex-observation-${index + 1}`,
    accessUrl,
    observedAt: parseObservationTime(
      getField(record, "t_min") ?? getField(record, "date_obs"),
    ),
    detector: `D${detectorMatch[1]}`,
    release: typeof collection === "string" ? collection : "SPHEREx",
    exposureSeconds: Number.isFinite(exposure) ? exposure : null,
  };
}

function parseNumber(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isDetector(value: string): value is Detector {
  return ["all", "D1", "D2", "D3", "D4", "D5", "D6"].some(
    (detector) => detector === value,
  );
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const ra = parseNumber(params.get("ra"));
  const dec = parseNumber(params.get("dec"));
  const fov = parseNumber(params.get("fov"));
  const detectorValue = params.get("detector") ?? "all";
  if (
    ra === null ||
    dec === null ||
    fov === null ||
    ra < 0 ||
    ra >= 360 ||
    dec < -90 ||
    dec > 90 ||
    fov < 0.005 ||
    fov > 0.5 ||
    !isDetector(detectorValue)
  ) {
    return NextResponse.json(
      { error: "Enter valid coordinates and a field of view between 0.005 and 0.5 degrees." },
      { status: 400 },
    );
  }

  try {
    const queryCollection = async (collection: string) => {
      const serviceUrl = new URL("https://irsa.ipac.caltech.edu/SIA");
      serviceUrl.searchParams.set("COLLECTION", collection);
      serviceUrl.searchParams.set(
        "POS",
        `CIRCLE ${ra} ${dec} ${SEARCH_RADIUS_DEG}`,
      );

      const upstream = await fetch(serviceUrl, {
        cache: "no-store",
        signal: AbortSignal.timeout(90_000),
      });

      if (!upstream.ok) {
        throw new Error(`IRSA returned HTTP ${upstream.status} while searching ${collection}.`);
      }

      return toRows(await upstream.text());
    };

    const collections = ["spherex_dr1", "spherex_qr3"];
    const queryResults = await Promise.allSettled(
      collections.map((collection) => queryCollection(collection)),
    );
    const rowSets: Record<string, unknown>[][] = [];
    const failedCollections: string[] = [];

    queryResults.forEach((result, index) => {
      if (result.status === "fulfilled") {
        rowSets.push(result.value);
      } else {
        const detail =
          result.reason instanceof Error
            ? result.reason.message
            : "The request could not be completed.";
        failedCollections.push(`${collections[index]}: ${detail}`);
      }
    });

    if (rowSets.length === 0) {
      throw new Error(failedCollections.join(" "));
    }

    const observationsByUrl = new Map<string, Observation>();
    let index = 0;
    for (const row of rowSets.flat()) {
      const observation = parseObservation(row, index++);
      if (
        observation &&
        (detectorValue === "all" || observation.detector === detectorValue)
      ) {
        observationsByUrl.set(observation.accessUrl, observation);
      }
    }

    const observations = [...observationsByUrl.values()].sort((a, b) =>
      (a.observedAt ?? "").localeCompare(b.observedAt ?? ""),
    );

    return NextResponse.json(
      {
        observations,
        count: observations.length,
        warning:
          failedCollections.length > 0
            ? `Partial archive results; ${failedCollections.join(" ")}`
            : null,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "The request could not be completed.";
    return NextResponse.json(
      { error: `Could not query the IRSA SPHEREx archive: ${message}` },
      { status: 502 },
    );
  }
}
