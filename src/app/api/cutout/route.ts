import { NextRequest, NextResponse } from "next/server";
import { hasFitsImageHdu, normalizeFitsImageHdu } from "@/lib/fits";

function parseNumber(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const source = params.get("url");
  const ra = parseNumber(params.get("ra"));
  const dec = parseNumber(params.get("dec"));
  const fov = parseNumber(params.get("fov"));

  if (!source || ra === null || dec === null || fov === null) {
    return NextResponse.json({ error: "A valid image URL and sky position are required." }, { status: 400 });
  }

  let imageUrl: URL;
  try {
    imageUrl = new URL(source);
  } catch {
    return NextResponse.json({ error: "The image URL is invalid." }, { status: 400 });
  }

  if (
    imageUrl.protocol !== "https:" ||
    imageUrl.hostname !== "irsa.ipac.caltech.edu" ||
    !/^\/ibe\/data\/spherex\/(dr1|qr3)\/level2\//.test(imageUrl.pathname) ||
    dec < -90 ||
    dec > 90 ||
    ra < 0 ||
    ra >= 360 ||
    fov < 0.005 ||
    fov > 0.5
  ) {
    return NextResponse.json({ error: "The requested SPHEREx cutout parameters are invalid." }, { status: 400 });
  }

  imageUrl.search = "";
  imageUrl.searchParams.set("center", `${ra},${dec}`);
  imageUrl.searchParams.set("size", String(fov));

  try {
    const upstream = await fetch(imageUrl, {
      cache: "no-store",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(90_000)]),
    });

    if (!upstream.ok) {
      await upstream.body?.cancel();
      return NextResponse.json(
        { error: `IRSA returned HTTP ${upstream.status} for this image.` },
        { status: upstream.status === 504 ? 504 : 502 },
      );
    }

    const data = await upstream.arrayBuffer();
    if (!hasFitsImageHdu(data)) {
      return NextResponse.json(
        { error: "IRSA did not return a FITS file with an IMAGE extension." },
        { status: 502 },
      );
    }

    return new Response(normalizeFitsImageHdu(data, { ra, dec }) ?? data, {
      headers: {
        "Cache-Control": "private, max-age=300",
        "Content-Type": "application/fits",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    const timedOut =
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError");
    const message = timedOut
      ? "IRSA timed out while retrieving this image."
      : error instanceof Error
        ? error.message
        : "The request could not be completed.";

    return NextResponse.json(
      { error: `Could not retrieve the SPHEREx image cutout: ${message}` },
      { status: timedOut ? 504 : 502 },
    );
  }
}
