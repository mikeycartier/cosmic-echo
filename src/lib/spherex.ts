export type Detector = "all" | "D1" | "D2" | "D3" | "D4" | "D5" | "D6";

export interface TargetPreset {
  id: string;
  name: string;
  shortName: string;
  ra: number;
  dec: number;
  kind: string;
  properMotionRaCosDecMasPerYear?: number;
  properMotionDecMasPerYear?: number;
}

export interface Observation {
  id: string;
  accessUrl: string;
  observedAt: string | null;
  detector: string;
  release: string;
  exposureSeconds: number | null;
}

export interface SearchCriteria {
  ra: number;
  dec: number;
  fov: number;
  detector: Detector;
  centerRa?: number;
  centerDec?: number;
}

export const TARGET_PRESETS: TargetPreset[] = [
  {
    id: "barnards-star",
    name: "Barnard's Star",
    shortName: "Barnard's",
    ra: 269.452075,
    dec: 4.693391,
    kind: "Nearby star",
    properMotionRaCosDecMasPerYear: -803,
    properMotionDecMasPerYear: 10362,
  },
  {
    id: "epsilon-indi-b",
    name: "Epsilon Indi B",
    shortName: "Epsilon Indi B",
    ra: 331.04375,
    dec: -56.7828,
    kind: "Brown dwarf pair",
  },
  {
    id: "wise-0855",
    name: "WISE 0855",
    shortName: "WISE 0855",
    ra: 133.79512917,
    dec: -7.24514722,
    kind: "Fast-moving brown dwarf",
  },
  {
    id: "rw-aurigae",
    name: "RW Aurigae",
    shortName: "RW Aurigae",
    ra: 76.956542,
    dec: 30.401444,
    kind: "Variable star",
  },
  {
    id: "r-draconis",
    name: "R Draconis",
    shortName: "R Draconis",
    ra: 248.166667,
    dec: 66.7536,
    kind: "Variable star",
  },
];
