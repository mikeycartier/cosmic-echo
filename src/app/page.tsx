import { Suspense } from "react";
import CosmicEchoApp from "@/components/CosmicEchoApp";
import type { Detector, SearchCriteria } from "@/lib/spherex";

interface HomePageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function singleValue(value: string | string[] | undefined): string | null {
  return typeof value === "string" ? value : null;
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

async function SearchParamsView({ searchParams }: HomePageProps) {
  const params = await searchParams;
  const ra = parseNumber(singleValue(params.ra));
  const dec = parseNumber(singleValue(params.dec));
  const fov = parseNumber(singleValue(params.fov));
  const detectorValue = singleValue(params.detector) ?? "all";
  let initialCriteria: SearchCriteria | null = null;

  if (
    ra !== null &&
    dec !== null &&
    fov !== null &&
    ra >= 0 &&
    ra < 360 &&
    dec >= -90 &&
    dec <= 90 &&
    fov >= 0.005 &&
    fov <= 0.5 &&
    isDetector(detectorValue)
  ) {
    initialCriteria = { ra, dec, fov, detector: detectorValue };
  }

  return <CosmicEchoApp initialCriteria={initialCriteria} />;
}

export default function Home({ searchParams }: HomePageProps) {
  return (
    <Suspense fallback={<CosmicEchoApp initialCriteria={null} />}>
      <SearchParamsView searchParams={searchParams} />
    </Suspense>
  );
}
