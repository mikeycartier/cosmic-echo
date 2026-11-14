"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import AladinSkyViewer from "@/components/AladinSkyViewer";
import {
  TARGET_PRESETS,
  type Detector,
  type Observation,
  type SearchCriteria,
  type TargetPreset,
} from "@/lib/spherex";

interface ObservationResponse {
  observations: Observation[];
  count: number;
  warning: string | null;
}

interface CosmicEchoAppProps {
  initialCriteria: SearchCriteria | null;
}

type SkyStatus = "waiting" | "loading" | "ready" | "error";
const MAX_PLAYBACK_FRAMES = 5;
const CUTOUT_PREFETCH_CONCURRENCY = 2;
const PLAYBACK_FRAME_DELAY_MS = 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const J2000_MJD = 51544.5;
const REFERENCE_EPOCH_MJD = 61041;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isObservation(value: unknown): value is Observation {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.accessUrl === "string" &&
    (typeof value.observedAt === "string" || value.observedAt === null) &&
    typeof value.detector === "string" &&
    typeof value.release === "string" &&
    (typeof value.exposureSeconds === "number" || value.exposureSeconds === null)
  );
}

function isDetector(value: string): value is Detector {
  return ["all", "D1", "D2", "D3", "D4", "D5", "D6"].some(
    (detector) => detector === value,
  );
}

function formatCoordinate(value: number): string {
  return value.toFixed(6).replace(/\.?0+$/, "");
}

function formatDate(value: string | null): string {
  if (!value) return "Date not reported";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Date not reported";
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(date);
}

function formatTimestamp(value: string | null): string {
  if (!value) return "Select an observation";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Date not reported";
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(date);
}

function addReferenceCenter(
  criteria: SearchCriteria,
  target: TargetPreset | null,
): SearchCriteria {
  const properMotionRa = target?.properMotionRaCosDecMasPerYear;
  const properMotionDec = target?.properMotionDecMasPerYear;
  if (properMotionRa === undefined || properMotionDec === undefined) return criteria;

  const years = (REFERENCE_EPOCH_MJD - J2000_MJD) / 365.25;
  const cosDec = Math.cos((criteria.dec * Math.PI) / 180);
  return {
    ...criteria,
    centerRa:
      (criteria.ra +
        (properMotionRa / 3_600_000 / cosDec) * years +
        360) %
      360,
    centerDec: criteria.dec + (properMotionDec / 3_600_000) * years,
  };
}

function getWeeklyFrames(observations: Observation[]): Observation[] {
  const byWeek = new Map<string, Observation>();
  for (const observation of observations) {
    const timestamp = observation.observedAt
      ? Date.parse(observation.observedAt)
      : Number.NaN;
    const key = Number.isFinite(timestamp)
      ? String(Math.floor(timestamp / WEEK_MS))
      : observation.accessUrl;
    if (!byWeek.has(key)) byWeek.set(key, observation);
  }
  return [...byWeek.values()];
}

function selectRepresentativeFrames(
  observations: Observation[],
  requestedDetector: Detector,
): { observations: Observation[]; detector: string | null } {
  const framesByDetector = new Map<string, Observation[]>();
  for (const observation of observations) {
    const frames = framesByDetector.get(observation.detector) ?? [];
    frames.push(observation);
    framesByDetector.set(observation.detector, frames);
  }

  const detectorEntries = [...framesByDetector.entries()].map(([detector, frames]) => ({
    detector,
    frames: getWeeklyFrames(frames),
  }));
  detectorEntries.sort(
    (left, right) =>
      right.frames.length - left.frames.length ||
      left.detector.localeCompare(right.detector),
  );
  const selected = requestedDetector === "all"
    ? detectorEntries[0]
    : detectorEntries.find((entry) => entry.detector === requestedDetector);
  const weeklyFrames = selected?.frames ?? [];

  if (weeklyFrames.length <= MAX_PLAYBACK_FRAMES) {
    return { observations: weeklyFrames, detector: selected?.detector ?? null };
  }

  const observationsToShow = Array.from({ length: MAX_PLAYBACK_FRAMES }, (_, index) => {
    const position = Math.round(
      (index * (weeklyFrames.length - 1)) / (MAX_PLAYBACK_FRAMES - 1),
    );
    return weeklyFrames[position];
  });
  return { observations: observationsToShow, detector: selected?.detector ?? null };
}

function makeCutoutUrl(observation: Observation, criteria: SearchCriteria): string {
  const params = new URLSearchParams({
    url: observation.accessUrl,
    ra: String(criteria.centerRa ?? criteria.ra),
    dec: String(criteria.centerDec ?? criteria.dec),
    fov: String(criteria.fov),
  });
  return `/api/cutout?${params.toString()}`;
}

function OrbitMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <ellipse
        cx="16"
        cy="16"
        rx="13.2"
        ry="5.6"
        transform="rotate(-34 16 16)"
        stroke="currentColor"
        strokeWidth="1.7"
      />
      <ellipse
        cx="16"
        cy="16"
        rx="7.5"
        ry="3.1"
        transform="rotate(-34 16 16)"
        stroke="currentColor"
        strokeWidth="1.4"
        opacity=".65"
      />
      <circle cx="23.3" cy="8.6" r="2.1" fill="currentColor" />
    </svg>
  );
}

function ArrowRight() {
  return (
    <svg viewBox="0 0 20 20" width="17" height="17" fill="none" aria-hidden="true">
      <path d="M3.5 10h12m-5-5 5 5-5 5" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function PlayIcon({ pause = false }: { pause?: boolean }) {
  return pause ? (
    <svg viewBox="0 0 20 20" width="15" height="15" fill="currentColor" aria-hidden="true">
      <path d="M5.5 4.5h3v11h-3zm6 0h3v11h-3z" />
    </svg>
  ) : (
    <svg viewBox="0 0 20 20" width="15" height="15" fill="currentColor" aria-hidden="true">
      <path d="m6 3.8 10.1 6.2L6 16.2V3.8Z" />
    </svg>
  );
}

function StepIcon({ direction }: { direction: "back" | "forward" }) {
  return (
    <svg viewBox="0 0 20 20" width="15" height="15" fill="none" aria-hidden="true">
      {direction === "back" ? (
        <>
          <path d="M5 4v12M15 5l-7 5 7 5V5Z" stroke="currentColor" strokeWidth="1.4" />
        </>
      ) : (
        <>
          <path d="M15 4v12M5 5l7 5-7 5V5Z" stroke="currentColor" strokeWidth="1.4" />
        </>
      )}
    </svg>
  );
}

async function requestObservations(criteria: SearchCriteria): Promise<ObservationResponse> {
  const params = new URLSearchParams({
    ra: String(criteria.centerRa ?? criteria.ra),
    dec: String(criteria.centerDec ?? criteria.dec),
    fov: String(criteria.fov),
    detector: criteria.detector,
  });
  const response = await fetch(`/api/observations?${params.toString()}`);
  const payload: unknown = await response.json();

  if (!response.ok) {
    const message =
      isRecord(payload) && typeof payload.error === "string"
        ? payload.error
        : "The archive search failed. Please try again.";
    throw new Error(message);
  }

  if (
    !isRecord(payload) ||
    !Array.isArray(payload.observations) ||
    !payload.observations.every(isObservation)
  ) {
    throw new Error("The archive returned observations in an unexpected format.");
  }

  return {
    observations: payload.observations,
    count:
      typeof payload.count === "number" && Number.isFinite(payload.count)
        ? payload.count
        : payload.observations.length,
    warning: typeof payload.warning === "string" ? payload.warning : null,
  };
}

export default function CosmicEchoApp({ initialCriteria }: CosmicEchoAppProps) {
  const initialPreset = initialCriteria
    ? TARGET_PRESETS.find(
        (target) =>
          Math.abs(target.ra - initialCriteria.ra) < 0.00001 &&
          Math.abs(target.dec - initialCriteria.dec) < 0.00001,
      )?.id ?? null
    : "wise-0855";
  const initialSearchCriteria = useMemo(() => {
    if (!initialCriteria) return null;
    const target = TARGET_PRESETS.find((candidate) => candidate.id === initialPreset) ?? null;
    return addReferenceCenter(initialCriteria, target);
  }, [initialCriteria, initialPreset]);
  const [ra, setRa] = useState(
    formatCoordinate(initialCriteria?.ra ?? TARGET_PRESETS[2].ra),
  );
  const [dec, setDec] = useState(
    formatCoordinate(initialCriteria?.dec ?? TARGET_PRESETS[2].dec),
  );
  const [fov, setFov] = useState(String(initialCriteria?.fov ?? 0.12));
  const [detector, setDetector] = useState<Detector>(
    initialCriteria?.detector ?? "all",
  );
  const [selectedPreset, setSelectedPreset] = useState<string | null>(initialPreset);
  const [observations, setObservations] = useState<Observation[]>([]);
  const [availableObservationCount, setAvailableObservationCount] = useState(0);
  const [sampledDetector, setSampledDetector] = useState<string | null>(null);
  const [failedFrameUrls, setFailedFrameUrls] = useState<Set<string>>(() => new Set());
  const [activeIndex, setActiveIndex] = useState(0);
  const [searchCriteria, setSearchCriteria] =
    useState<SearchCriteria | null>(initialSearchCriteria);
  const [loading, setLoading] = useState(initialCriteria !== null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [readyPlaybackBufferKey, setReadyPlaybackBufferKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [archiveWarning, setArchiveWarning] = useState<string | null>(null);
  const [skyStatus, setSkyStatus] = useState<SkyStatus>("waiting");
  const [hasDisplayedImage, setHasDisplayedImage] = useState(false);
  const [viewerGeneration, setViewerGeneration] = useState(0);
  const selectedTarget =
    TARGET_PRESETS.find((target) => target.id === selectedPreset) ?? null;
  const activeObservation = observations[activeIndex] ?? null;
  const activeObservationRef = useRef<Observation | null>(null);
  useLayoutEffect(() => {
    activeObservationRef.current = activeObservation;
  }, [activeObservation]);
  const activeImageUrl =
    activeObservation && searchCriteria
      ? makeCutoutUrl(activeObservation, searchCriteria)
      : null;
  const viewerRa =
    searchCriteria?.centerRa ??
    searchCriteria?.ra ??
    (Number.isFinite(Number(ra)) ? Number(ra) : TARGET_PRESETS[2].ra);
  const viewerDec =
    searchCriteria?.centerDec ??
    searchCriteria?.dec ??
    (Number.isFinite(Number(dec)) ? Number(dec) : TARGET_PRESETS[2].dec);
  const viewerFov =
    searchCriteria?.fov ?? (Number.isFinite(Number(fov)) ? Number(fov) : 0.12);
  const activeDate = useMemo(
    () => formatTimestamp(activeObservation?.observedAt ?? null),
    [activeObservation],
  );
  const playbackBufferKey = useMemo(() => {
    if (!searchCriteria || observations.length < 2) return null;
    return observations
      .slice(1)
      .map((observation) => makeCutoutUrl(observation, searchCriteria))
      .join("\n");
  }, [observations, searchCriteria]);
  const playbackBufferReady =
    playbackBufferKey === null || readyPlaybackBufferKey === playbackBufferKey;
  const isBufferingPlayback =
    observations.length > 1 && !playbackBufferReady;
  const handleSkyStatusChange = useCallback((status: SkyStatus) => {
    setSkyStatus(status);
    if (status === "ready") setHasDisplayedImage(true);
    const observation = activeObservationRef.current;
    if (!observation) return;

    setFailedFrameUrls((failed) => {
      if (status === "error" && !failed.has(observation.accessUrl)) {
        return new Set(failed).add(observation.accessUrl);
      }
      if (status === "ready" && failed.has(observation.accessUrl)) {
        const next = new Set(failed);
        next.delete(observation.accessUrl);
        return next;
      }
      return failed;
    });
  }, []);

  const runSearch = useCallback(async (criteria: SearchCriteria) => {
    setLoading(true);
    setError(null);
    setArchiveWarning(null);
    setIsPlaying(false);
    setObservations([]);
    setAvailableObservationCount(0);
    setSampledDetector(null);
    setFailedFrameUrls(new Set());
    setActiveIndex(0);
    setSkyStatus("waiting");
    setHasDisplayedImage(false);
    setReadyPlaybackBufferKey(null);
    setSearchCriteria(criteria);
    setViewerGeneration((generation) => generation + 1);

    const url = new URL(window.location.href);
    url.searchParams.set("ra", formatCoordinate(criteria.ra));
    url.searchParams.set("dec", formatCoordinate(criteria.dec));
    url.searchParams.set("fov", String(criteria.fov));
    if (criteria.detector === "all") {
      url.searchParams.delete("detector");
    } else {
      url.searchParams.set("detector", criteria.detector);
    }
    window.history.replaceState({}, "", url);

    try {
      const result = await requestObservations(criteria);
      const selection = selectRepresentativeFrames(result.observations, criteria.detector);
      setObservations(selection.observations);
      setAvailableObservationCount(result.count);
      setSampledDetector(selection.detector);
      setArchiveWarning(result.warning);
      if (selection.observations.length === 0) {
        setError("No matching SPHEREx images were found for this field and detector.");
      } else {
        setSkyStatus("loading");
      }
    } catch (requestError) {
      setArchiveWarning(null);
      const message =
        requestError instanceof Error
          ? requestError.message
          : "The archive search failed. Please try again.";
      setError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!initialSearchCriteria) return;
    let cancelled = false;

    requestObservations(initialSearchCriteria)
      .then((result) => {
        if (cancelled) return;
        const selection = selectRepresentativeFrames(
          result.observations,
          initialSearchCriteria.detector,
        );
        setObservations(selection.observations);
        setAvailableObservationCount(result.count);
        setSampledDetector(selection.detector);
        setArchiveWarning(result.warning);
        setError(
          selection.observations.length === 0
            ? "No matching SPHEREx images were found for this field and detector."
            : null,
        );
        if (selection.observations.length > 0) setSkyStatus("loading");
      })
      .catch((requestError: unknown) => {
        if (cancelled) return;
        setArchiveWarning(null);
        setError(
          requestError instanceof Error
            ? requestError.message
            : "The archive search failed. Please try again.",
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [initialSearchCriteria]);

  useEffect(() => {
    if (!searchCriteria || !playbackBufferKey) return;

    const controller = new AbortController();
    let cancelled = false;
    const imageUrls = observations
      .slice(1)
      .map((observation) => makeCutoutUrl(observation, searchCriteria));

    const preload = async () => {
      for (let index = 0; index < imageUrls.length; index += CUTOUT_PREFETCH_CONCURRENCY) {
        const batch = imageUrls.slice(index, index + CUTOUT_PREFETCH_CONCURRENCY);
        const results = await Promise.allSettled(
          batch.map(async (url) => {
            const response = await fetch(url, {
              cache: "default",
              signal: controller.signal,
            });
            if (!response.ok) {
              throw new Error(`The image request failed (HTTP ${response.status}).`);
            }
            await response.arrayBuffer();
          }),
        );
        if (cancelled) return;

        const failedPreloadUrls: string[] = [];
        results.forEach((result, batchIndex) => {
          if (result.status === "rejected") {
            const observation = observations[index + batchIndex + 1];
            if (observation) failedPreloadUrls.push(observation.accessUrl);
            console.warn(`Could not preload observation ${index + batchIndex + 2}.`, result.reason);
          }
        });
        if (failedPreloadUrls.length > 0) {
          setFailedFrameUrls((failed) => {
            const next = new Set(failed);
            failedPreloadUrls.forEach((url) => next.add(url));
            return next;
          });
        }
      }
      setReadyPlaybackBufferKey(playbackBufferKey);
    };

    void preload();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [observations, playbackBufferKey, searchCriteria]);

  useEffect(() => {
    if (
      !isPlaying ||
      observations.length < 2 ||
      skyStatus === "loading" ||
      skyStatus === "waiting"
    ) {
      return;
    }

    const timeout = window.setTimeout(() => {
      for (let offset = 1; offset < observations.length; offset += 1) {
        const nextIndex = (activeIndex + offset) % observations.length;
        if (!failedFrameUrls.has(observations[nextIndex].accessUrl)) {
          setActiveIndex(nextIndex);
          return;
        }
      }
      setIsPlaying(false);
    }, PLAYBACK_FRAME_DELAY_MS);

    return () => window.clearTimeout(timeout);
  }, [activeIndex, failedFrameUrls, isPlaying, observations, skyStatus]);

  const handleSearch = () => {
    const raValue = Number(ra);
    const decValue = Number(dec);
    const fovValue = Number(fov);

    if (
      !ra.trim() ||
      !dec.trim() ||
      !fov.trim() ||
      !Number.isFinite(raValue) ||
      !Number.isFinite(decValue) ||
      !Number.isFinite(fovValue) ||
      raValue < 0 ||
      raValue >= 360 ||
      decValue < -90 ||
      decValue > 90 ||
      fovValue < 0.005 ||
      fovValue > 0.5
    ) {
      setError("Enter RA from 0 to under 360 degrees, Dec from -90 to 90, and a field size from 0.005 to 0.5 degrees.");
      return;
    }

    void runSearch(
      addReferenceCenter(
        { ra: raValue, dec: decValue, fov: fovValue, detector },
        selectedTarget,
      ),
    );
  };

  const choosePreset = (target: TargetPreset) => {
    setRa(formatCoordinate(target.ra));
    setDec(formatCoordinate(target.dec));
    setSelectedPreset(target.id);
    setError(null);
    setArchiveWarning(null);
    setObservations([]);
    setAvailableObservationCount(0);
    setSampledDetector(null);
    setFailedFrameUrls(new Set());
    setSearchCriteria(null);
    setActiveIndex(0);
    setIsPlaying(false);
    setSkyStatus("waiting");
    setViewerGeneration((generation) => generation + 1);
  };

  const goToExplore = () => {
    document.getElementById("explore")?.scrollIntoView({ behavior: "smooth" });
    handleSearch();
  };

  const moveFrame = (amount: number) => {
    if (observations.length === 0) return;
    setIsPlaying(false);
    setActiveIndex((index) => (index + amount + observations.length) % observations.length);
  };

  return (
    <>
      <header className="site-header">
        <a className="brand" href="#" aria-label="Cosmic Echo home">
          <OrbitMark />
          <span>COSMIC ECHO</span>
        </a>
        <nav className="header-nav" aria-label="Main navigation">
          <a href="#explore" aria-current="page">
            Explore
          </a>
          <a href="#how-it-works">How it works</a>
        </nav>
      </header>

      <main>
        <section className="hero" aria-labelledby="hero-title">
          <div className="hero-content">
            <div className="eyebrow">
              <span className="eyebrow-dot" />
              A new window into the universe
            </div>
            <h1 id="hero-title">
              The sky is moving.
              <span>Look closer.</span>
            </h1>
            <p className="hero-copy">
              Explore the universe in a different light. Compare images from NASA&apos;s
              SPHEREx mission, follow what moves, and find the extraordinary hiding
              in plain sight.
            </p>
            <div className="hero-actions">
              <button className="primary-button" onClick={goToExplore} type="button">
                Start exploring <ArrowRight />
              </button>
              <a className="text-button" href="#how-it-works">
                Meet the mission <span aria-hidden="true">↗</span>
              </a>
            </div>
            <p className="hero-footnote">No telescope required. Just curiosity.</p>
          </div>
        </section>

        <div className="section-rule" />

        <section className="explore-section" id="explore" aria-labelledby="explore-title">
          <div className="content-shell">
            <div className="section-heading">
              <div>
                <span className="section-kicker">Your window to the infrared sky</span>
                <h2 id="explore-title">Find a field. Follow the change.</h2>
                <p>
                  Search the archive by coordinates, then move through real SPHEREx
                  observations one frame at a time.
                </p>
              </div>
              <span className="live-pill">
                <span /> IRSA archive
              </span>
            </div>

            <div className="explore-grid">
              <aside className="panel search-panel" aria-label="Observation search">
                <div className="panel-heading">
                  <h3>Choose a field</h3>
                  <span className="panel-step">01 / SEARCH</span>
                </div>

                <div className="preset-list" aria-label="Challenge targets">
                  {TARGET_PRESETS.map((target) => (
                    <button
                      className={`preset-button${selectedPreset === target.id ? " is-selected" : ""}`}
                      key={target.id}
                      onClick={() => choosePreset(target)}
                      type="button"
                      aria-pressed={selectedPreset === target.id}
                      title={target.kind}
                    >
                      <span>{target.shortName}</span>
                      <span>{target.kind}</span>
                    </button>
                  ))}
                </div>

                <div className="field-grid">
                  <label className="field-wrap">
                    <span className="field-label">Right ascension</span>
                    <span className="input-shell">
                      <input
                        aria-label="Right ascension in degrees"
                        type="number"
                        inputMode="decimal"
                        min="0"
                        max="359.999999"
                        step="any"
                        value={ra}
                        onChange={(event) => {
                          setRa(event.target.value);
                          setSelectedPreset(null);
                        }}
                      />
                    </span>
                  </label>
                  <label className="field-wrap">
                    <span className="field-label">Declination</span>
                    <span className="input-shell">
                      <input
                        aria-label="Declination in degrees"
                        type="number"
                        inputMode="decimal"
                        min="-90"
                        max="90"
                        step="any"
                        value={dec}
                        onChange={(event) => {
                          setDec(event.target.value);
                          setSelectedPreset(null);
                        }}
                      />
                    </span>
                  </label>
                  <label className="field-wrap">
                    <span className="field-label">Field size (deg)</span>
                    <span className="input-shell">
                      <input
                        aria-label="Field size in degrees"
                        type="number"
                        inputMode="decimal"
                        min="0.005"
                        max="0.5"
                        step="any"
                        value={fov}
                        onChange={(event) => setFov(event.target.value)}
                      />
                    </span>
                  </label>
                  <label className="field-wrap">
                    <span className="field-label">Detector</span>
                    <span className="input-shell">
                      <select
                        aria-label="SPHEREx detector"
                        value={detector}
                        onChange={(event) => {
                          if (isDetector(event.target.value)) {
                            setDetector(event.target.value);
                          }
                        }}
                      >
                        <option value="all">All arrays</option>
                        <option value="D1">Array 1</option>
                        <option value="D2">Array 2</option>
                        <option value="D3">Array 3</option>
                        <option value="D4">Array 4</option>
                        <option value="D5">Array 5</option>
                        <option value="D6">Array 6</option>
                      </select>
                      <svg className="select-arrow" viewBox="0 0 12 12" width="12" height="12" fill="none" aria-hidden="true">
                        <path d="m2 4 4 4 4-4" stroke="currentColor" strokeWidth="1.3" />
                      </svg>
                    </span>
                  </label>
                </div>
                <p className="form-help">
                  Coordinates use ICRS degrees. Known preset motion is applied to a 2026 reference center.
                </p>
                <button
                  className="search-button"
                  disabled={loading}
                  onClick={handleSearch}
                  type="button"
                >
                  {loading ? (
                    <>
                      <span className="loader" /> Searching IRSA...
                    </>
                  ) : (
                    <>
                      Search observations <ArrowRight />
                    </>
                  )}
                </button>
                {error ? (
                  <p className="form-error" role="alert">
                    {error}
                  </p>
                ) : null}
                {archiveWarning ? (
                  <p className="form-warning" role="status">
                    {archiveWarning}
                  </p>
                ) : null}
                <div className="form-note">
                  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
                    <circle cx="8" cy="8" r="6" stroke="currentColor" />
                    <path d="M8 7v4m0-6h.01" stroke="currentColor" strokeLinecap="round" />
                  </svg>
                  DR1 and QR3 images are queried live from NASA/IPAC IRSA.
                </div>
              </aside>

              <div className="viewer-column">
                <section className="panel viewer-panel" aria-label="SPHEREx image viewer">
                  <div className="viewer-toolbar">
                    <div className="viewer-title">
                      <strong>{selectedTarget?.name ?? "Custom sky field"}</strong>
                      <span>
                        {formatCoordinate(viewerRa)}° &nbsp; {viewerDec >= 0 ? "+" : ""}
                        {formatCoordinate(viewerDec)}°
                      </span>
                    </div>
                    <span className={`viewer-badge${hasDisplayedImage ? " is-loaded" : ""}`}>
                      {hasDisplayedImage ? "SPHEREx image" : "Sky preview"}
                    </span>
                  </div>
                  <div className="sky-frame">
                    <AladinSkyViewer
                      key={viewerGeneration}
                      ra={viewerRa}
                      dec={viewerDec}
                      fov={viewerFov}
                      imageUrl={activeImageUrl}
                      isPlaying={isPlaying}
                      onStatusChange={handleSkyStatusChange}
                    />
                    {loading || (skyStatus === "loading" && !hasDisplayedImage) ? (
                      <div className="sky-waiting" role="status">
                        <span className="loader" />
                        <strong>{loading ? "Searching the archive" : "Loading SPHEREx image"}</strong>
                        <span>
                          {loading
                            ? "Checking DR1 and Quick Release 3 observations for this field."
                            : "Fetching a cutout for the selected observation."}
                        </span>
                      </div>
                    ) : null}
                    {!loading && !activeObservation && skyStatus !== "error" ? (
                      <div className="sky-waiting">
                        <strong>Ready to explore</strong>
                        <span>Choose a target and search for real SPHEREx observations.</span>
                      </div>
                    ) : null}
                    <span className="sky-status">
                      <span className="sky-status-dot" />
                      {isBufferingPlayback
                        ? "Preparing playback"
                        : hasDisplayedImage
                        ? skyStatus === "loading"
                          ? "Loading next frame"
                          : "IRSA FITS cutout"
                        : "Coordinate view"}
                    </span>
                  </div>
                  <div className="viewer-footer">
                    <span>
                      {activeObservation
                        ? `${activeObservation.detector} · ${activeObservation.release}`
                        : "SPHEREx 0.75–5 μm"}
                    </span>
                    <a href="https://aladin.cds.unistra.fr/AladinLite/" target="_blank" rel="noreferrer">
                      Sky map by Aladin Lite
                    </a>
                  </div>
                </section>

                <div className="panel player-panel" aria-label="Observation playback controls">
                  <div className="player-controls">
                    <button
                      className="icon-button"
                      onClick={() => moveFrame(-1)}
                      disabled={observations.length < 2}
                      type="button"
                      aria-label="Previous observation"
                    >
                      <StepIcon direction="back" />
                    </button>
                    <button
                      className="icon-button play-button"
                      onClick={() => setIsPlaying((playing) => !playing)}
                      disabled={observations.length < 2 || !playbackBufferReady}
                      type="button"
                      aria-label={isPlaying ? "Pause observations" : "Play observations"}
                      title={
                        playbackBufferReady
                          ? undefined
                          : "Preparing frames for smooth playback"
                      }
                    >
                      <PlayIcon pause={isPlaying} />
                    </button>
                    <button
                      className="icon-button"
                      onClick={() => moveFrame(1)}
                      disabled={observations.length < 2}
                      type="button"
                      aria-label="Next observation"
                    >
                      <StepIcon direction="forward" />
                    </button>
                  </div>
                  <div className="timeline-wrap">
                    <div className="timeline-meta">
                      <span>{activeDate}</span>
                      <span>
                        {isBufferingPlayback
                          ? "Preparing video frames"
                          : observations.length > 0
                          ? availableObservationCount > observations.length
                            ? `${observations.length} representative frames`
                            : `${observations.length} archive frames`
                          : "No frames loaded"}
                      </span>
                    </div>
                    <input
                      className="timeline"
                      type="range"
                      min="0"
                      max={Math.max(0, observations.length - 1)}
                      step="1"
                      value={Math.min(activeIndex, Math.max(0, observations.length - 1))}
                      onChange={(event) => {
                        setIsPlaying(false);
                        setActiveIndex(Number(event.target.value));
                      }}
                      disabled={observations.length < 2}
                      aria-label="Observation timeline"
                    />
                  </div>
                  <span className="frame-count">
                    {observations.length > 0
                      ? `${String(activeIndex + 1).padStart(2, "0")} / ${String(observations.length).padStart(2, "0")}`
                      : "-- / --"}
                  </span>
                </div>

                <section className="panel results-panel" aria-label="Matching observations">
                  <div className="results-head">
                    <h3>Observation timeline</h3>
                    <span>
                      {availableObservationCount > observations.length
                        ? `${observations.length} OF ${availableObservationCount} · ${sampledDetector ?? "SAMPLED"}`
                        : `${observations.length} MATCHES`}
                    </span>
                  </div>
                  {observations.length > 0 ? (
                    <div className="observation-list">
                      {observations.map((observation, index) => (
                        <button
                          className={`observation-row${activeIndex === index ? " is-active" : ""}`}
                          key={`${observation.id}-${index}`}
                          onClick={() => {
                            setIsPlaying(false);
                            setActiveIndex(index);
                          }}
                          type="button"
                          aria-current={activeIndex === index ? "true" : undefined}
                        >
                          <span className="observation-index">
                            {String(index + 1).padStart(2, "0")}
                          </span>
                          <span className="observation-date">
                            {formatDate(observation.observedAt)}
                          </span>
                          <span className="observation-release">{observation.release}</span>
                          <span className="observation-band">
                            {observation.detector.replace("SPHEREx-", "")}
                          </span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="empty-results">
                      <strong>
                        {loading ? "Looking for coverage..." : "Your observations will appear here"}
                      </strong>
                      <span>
                        {error
                          ? "Check the search message above, adjust the field, or try again."
                          : "Search a target to build a time-ordered sequence from the archive."}
                      </span>
                    </div>
                  )}
                </section>
              </div>
            </div>
          </div>
        </section>

        <section className="how-section" id="how-it-works" aria-labelledby="how-title">
          <div className="content-shell">
            <span className="section-kicker">A mission built for discovery</span>
            <h2 id="how-title" className="sr-only">
              How Cosmic Echo works
            </h2>
            <div className="how-grid">
              <article className="how-card">
                <span className="how-card-number">01 / SEARCH</span>
                <h3>Pick a patch of sky</h3>
                <p>Start with a challenge target or enter any ICRS coordinates and field size.</p>
              </article>
              <article className="how-card">
                <span className="how-card-number">02 / COMPARE</span>
                <h3>Watch the epochs</h3>
                <p>Browse real IRSA image cutouts in date order, or play them like a short movie.</p>
              </article>
              <article className="how-card">
                <span className="how-card-number">03 / NOTICE</span>
                <h3>Look for a change</h3>
                <p>Moving points of light and changing brightness can reveal new objects.</p>
              </article>
            </div>
            <footer className="site-footer">
              <span>Cosmic Echo · A public-facing SPHEREx exploration concept</span>
              <a href="https://irsa.ipac.caltech.edu/Missions/spherex.html" target="_blank" rel="noreferrer">
                Data: NASA/IPAC IRSA
              </a>
            </footer>
          </div>
        </section>
      </main>
    </>
  );
}
