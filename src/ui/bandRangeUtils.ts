const MIN_FREQ = 20;
const MAX_FREQ = 20000;
const BAND_SLIDER_MIN = 0;
const BAND_SLIDER_MAX = 1000;
const MIN_BAND_GAP_HZ = 1;
const LOG_MIN = Math.log10(MIN_FREQ);
const LOG_MAX = Math.log10(MAX_FREQ);

export type BandPreset = {
  value: string;
  label: string;
  range: [number, number];
};

export const BAND_PRESETS: BandPreset[] = [
  { value: "full", label: "Full", range: [MIN_FREQ, MAX_FREQ] },
  { value: "bass", label: "Bass", range: [20, 200] },
  { value: "vocals", label: "Vocals", range: [200, 5000] },
  { value: "air", label: "Air", range: [8000, 20000] },
];

export function freqToSliderValue(freq: number): number {
  const clamped = Math.min(Math.max(freq, MIN_FREQ), MAX_FREQ);
  const norm = (Math.log10(clamped) - LOG_MIN) / (LOG_MAX - LOG_MIN);
  return BAND_SLIDER_MIN + norm * (BAND_SLIDER_MAX - BAND_SLIDER_MIN);
}

export function sliderValueToFreq(value: number): number {
  const norm = (value - BAND_SLIDER_MIN) / (BAND_SLIDER_MAX - BAND_SLIDER_MIN);
  const logValue = LOG_MIN + norm * (LOG_MAX - LOG_MIN);
  return Math.pow(10, logValue);
}

export function clampBandRange(minHz: number, maxHz: number): [number, number] {
  const min = Math.max(MIN_FREQ, Math.min(minHz, MAX_FREQ - MIN_BAND_GAP_HZ));
  let max = Math.max(min + MIN_BAND_GAP_HZ, Math.min(maxHz, MAX_FREQ));
  if (max - min < MIN_BAND_GAP_HZ) {
    max = Math.min(MAX_FREQ, min + MIN_BAND_GAP_HZ);
  }
  return [min, max];
}

export function formatHz(value: number): string {
  if (value >= 1000) {
    return `${(value / 1000).toFixed(value >= 10000 ? 1 : 2)} kHz`;
  }
  return `${value.toFixed(0)} Hz`;
}

const PRESET_TOLERANCE_HZ = 1;

export function derivePresetValue(
  minHz: number,
  maxHz: number,
  presets: BandPreset[] = BAND_PRESETS,
): string {
  for (const preset of presets) {
    if (
      Math.abs(preset.range[0] - minHz) <= PRESET_TOLERANCE_HZ &&
      Math.abs(preset.range[1] - maxHz) <= PRESET_TOLERANCE_HZ
    ) {
      return preset.value;
    }
  }
  return "custom";
}

export const BAND_RANGE_LIMITS = {
  MIN_FREQ,
  MAX_FREQ,
  BAND_SLIDER_MIN,
  BAND_SLIDER_MAX,
  MIN_BAND_GAP_HZ,
};

