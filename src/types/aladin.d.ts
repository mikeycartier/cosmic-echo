interface AladinDisplayOptions {
  name: string;
  colormap: string;
  imgFormat?: string;
  stretch?: string;
}

interface AladinImageLayer {
  setCuts(minCut: number, maxCut: number, cutFormat?: string): void;
}

interface AladinInstance {
  createImageFITS(
    url: string,
    options: AladinDisplayOptions,
    onSuccess?: (ra: number, dec: number, fov: number[]) => void,
    onError?: (error: unknown) => void,
  ): AladinImageLayer;
  setImageLayer(layer: AladinImageLayer): void;
  removeOverlays(): void;
  gotoRaDec(ra: number, dec: number): void;
  setFoV(fov: number | number[]): void;
}

interface AladinApi {
  init: Promise<unknown>;
  aladin(
    element: HTMLElement,
    options: {
      target: string;
      fov: number;
      survey: string | string[];
      cooFrame: string;
      showCooGridControl: boolean;
      showSimbadPointerControl: boolean;
      showReticle: boolean;
      showShareControl: boolean;
      showLayersControl: boolean;
      mode: string;
      log: boolean;
    },
  ): AladinInstance;
}

declare module "aladin-lite" {
  const aladin: AladinApi;
  export default aladin;
}
