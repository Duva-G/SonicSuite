from pathlib import Path

path = Path("src/ui/FRPlayback.tsx")
with path.open("r", encoding="utf-8-sig", newline="") as f:
    text = f.read()

start = text.find("const traces = useMemo<PlotDataArray>(() => {")
if start == -1:
    raise ValueError("traces block start not found")
end = text.find("  }, [spectra]);", start)
if end == -1:
    raise ValueError("traces block end not found")
end += len("  }, [spectra]);")

new_lines = [
    "const traces = useMemo<PlotDataArray>(() => {",
    "    if (!spectra) return [] as PlotDataArray;",
    "    const baseHover = \"<b>%{x:.0f} Hz</b><br>%{y:.2f} dB<extra></extra>\";",
    "    const freqs = Array.from(spectra.freqs);",
    "    const series: number[][] = [Array.from(spectra.dryDb)];",
    "",
    "    if (spectra.hasIR && spectra.wetDb) {",
    "      series.push(Array.from(spectra.wetDb));",
    "    }",
    "",
    "    const { arrays } = normalizePlaybackSeries(series);",
    "    const dryNormalized = arrays[0] ?? [];",
    "    const result: PlotDatum[] = [",
    "      {",
    "        type: \"scatter\",",
    "        mode: \"lines\",",
    "        name: \"Original (music)\",",
    "        hovertemplate: baseHover,",
    "        x: freqs,",
    "        y: dryNormalized,",
    "        line: { color: \"#5ac8fa\", width: 2 },",
    "      } as PlotDatum,",
    "    ];",
    "",
    "    if (spectra.hasIR && arrays[1]) {",
    "      result.push({",
    "        type: \"scatter\",",
    "        mode: \"lines\",",
    "        name: \"Convolved\",",
    "        hovertemplate: baseHover,",
    "        x: freqs,",
    "        y: arrays[1],",
    "        line: { color: \"#ff9f0a\", width: 2 },",
    "      } as PlotDatum);",
    "    }",
    "",
    "    return result as PlotDataArray;",
    "  }, [spectra]);"
]
new_block = "\r\n".join(new_lines) + "\r\n"

text = text[:start] + new_block + text[end:]

text = text.replace("autorangeoptions: { clipmin: -30, clipmax: 30 },", "autorangeoptions: { clipmin: 0, clipmax: 60 },")

insert_target = "  return { data: mono, sampleRate: buffer.sampleRate, label };\r\n}\r\n"
if insert_target not in text:
    raise ValueError("serializeBuffer closing not found")

helper_insert = """
function normalizePlaybackSeries(series: number[][]): { arrays: number[][] } {
  if (series.length === 0) {
    return { arrays: [] };
  }

  let peak = Number.NEGATIVE_INFINITY;
  for (const arr of series) {
    for (let i = 0; i < arr.length; i++) {
      const value = arr[i];
      if (!Number.isFinite(value)) continue;
      if (value > peak) peak = value;
    }
  }

  if (!Number.isFinite(peak)) {
    peak = 0;
  }

  let min = Number.POSITIVE_INFINITY;
  const centered = series.map((source) => {
    const normalized: number[] = new Array(source.length);
    for (let i = 0; i < source.length; i++) {
      const value = source[i];
      const normalizedValue = Number.isFinite(value) ? value - peak : Number.NaN;
      normalized[i] = normalizedValue;
      if (Number.isFinite(normalizedValue) && normalizedValue < min) {
        min = normalizedValue;
      }
    }
    return normalized;
  });

  const offset = Number.isFinite(min) ? -min : 0;

  return {
    arrays: centered.map((source) => {
      const shifted: number[] = new Array(source.length);
      for (let i = 0; i < source.length; i++) {
        const value = source[i];
        shifted[i] = Number.isFinite(value) ? Math.max(0, value + offset) : Number.NaN;
      }
      return shifted;
    }),
  };
}
"""

text = text.replace(insert_target, insert_target + helper_insert)

with path.open("w", encoding="utf-8", newline="") as f:
    f.write(text)
