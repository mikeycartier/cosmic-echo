"use client";

import { useEffect, useRef, useState } from "react";
import { getFitsPercentileCuts } from "@/lib/fits";

interface AladinSkyViewerProps {
  ra: number;
  dec: number;
  fov: number;
  imageUrl: string | null;
  isPlaying: boolean;
  onStatusChange: (status: "waiting" | "loading" | "ready" | "error") => void;
}

export default function AladinSkyViewer({
  ra,
  dec,
  fov,
  imageUrl,
  isPlaying,
  onStatusChange,
}: AladinSkyViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<AladinInstance | null>(null);
  const initialViewRef = useRef({ ra, dec, fov });
  const [viewerReady, setViewerReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const initialize = async () => {
      const container = containerRef.current;
      if (!container) {
        setError("The sky viewer did not initialize. Please reload the page.");
        onStatusChange("error");
        return;
      }

      try {
        const { default: aladin } = await import("aladin-lite");
        await aladin.init;
        if (cancelled || !containerRef.current) return;
        const initialView = initialViewRef.current;
        viewerRef.current = aladin.aladin(containerRef.current, {
          target: `${initialView.ra} ${initialView.dec}`,
          fov: initialView.fov,
          survey: [],
          cooFrame: "ICRS",
          showCooGridControl: false,
          showSimbadPointerControl: false,
          showReticle: true,
          showShareControl: false,
          showLayersControl: false,
          mode: "dark",
          log: false,
        });
        setViewerReady(true);
      } catch {
        if (cancelled) return;
        setError("The Aladin sky viewer could not be loaded.");
        onStatusChange("error");
      }
    };

    void initialize();

    return () => {
      cancelled = true;
    };
  }, [onStatusChange]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !viewerReady) return;
    viewer.gotoRaDec(ra, dec);
    viewer.setFoV(fov);
  }, [dec, fov, ra, viewerReady]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !viewerReady || !imageUrl) return;

    let cancelled = false;
    let settled = false;
    let objectUrl: string | null = null;
    let displayTimer: number | null = null;
    let requestTimer: number | null = null;
    const controller = new AbortController();

    const revokeObjectUrl = () => {
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
        objectUrl = null;
      }
    };

    const finishWithError = (message: string) => {
      if (cancelled || settled) return;
      settled = true;
      if (displayTimer !== null) window.clearTimeout(displayTimer);
      revokeObjectUrl();
      setError(message);
      onStatusChange("error");
    };

    setError(null);
    onStatusChange("loading");
    viewer.removeOverlays();

    requestTimer = window.setTimeout(
      () => controller.abort(new DOMException("IRSA request timed out.", "TimeoutError")),
      95_000,
    );

    const loadImage = async () => {
      try {
        const response = await fetch(imageUrl, {
          signal: controller.signal,
          cache: "default",
        });
        if (requestTimer !== null) window.clearTimeout(requestTimer);
        if (!response.ok) {
          let message = `The image request failed (HTTP ${response.status}).`;
          try {
            const payload: unknown = await response.json();
            if (
              typeof payload === "object" &&
              payload !== null &&
              "error" in payload &&
              typeof payload.error === "string"
            ) {
              message = payload.error;
            }
          } catch {
            // Keep the HTTP status message when the server response is not JSON.
          }
          throw new Error(message);
        }

        const imageData = await response.arrayBuffer();
        if (cancelled) return;
        const cuts = getFitsPercentileCuts(imageData);
        const image = new Blob([imageData], { type: "application/fits" });
        objectUrl = URL.createObjectURL(image);
        displayTimer = window.setTimeout(
          () => finishWithError("Aladin timed out while displaying this image."),
          30_000,
        );

        let imageLayer: AladinImageLayer | null = null;
        imageLayer = viewer.createImageFITS(
          objectUrl,
          {
            name: "SPHEREx observation",
            colormap: "grayscale",
            imgFormat: "fits",
            stretch: "linear",
          },
          () => {
            if (cancelled || settled) return;
            settled = true;
            if (displayTimer !== null) window.clearTimeout(displayTimer);
            if (cuts) imageLayer?.setCuts(cuts[0], cuts[1], "fits");
            onStatusChange("ready");
          },
          (loadError) => {
            const message =
              loadError instanceof Error
                ? loadError.message
                : typeof loadError === "string"
                  ? loadError
                  : "This image could not be displayed.";
            finishWithError(message);
          },
        );
        if (cuts) imageLayer.setCuts(cuts[0], cuts[1], "fits");
        viewer.setImageLayer(imageLayer);
      } catch (loadError) {
        if (cancelled) return;
        const message =
          loadError instanceof Error
            ? loadError.message
            : "This image could not be retrieved.";
        finishWithError(message);
      }
    };

    void loadImage();

    return () => {
      cancelled = true;
      controller.abort();
      if (requestTimer !== null) window.clearTimeout(requestTimer);
      if (displayTimer !== null) window.clearTimeout(displayTimer);
      revokeObjectUrl();
    };
  }, [dec, fov, imageUrl, onStatusChange, ra, viewerReady]);

  return (
    <>
      <div ref={containerRef} className="sky-viewer" aria-label="Interactive sky map" />
      {error && !isPlaying ? (
        <div className="sky-waiting" role="status">
          <strong>Image unavailable</strong>
          <span>{error}</span>
        </div>
      ) : null}
    </>
  );
}
