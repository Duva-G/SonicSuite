type Props = {
  renderAndExport: () => Promise<void> | void;
  downloadUrl: string;
};

export default function ExportBar({ renderAndExport, downloadUrl }: Props) {
  return (
    <section style={{ marginBottom: 12 }}>
      <button onClick={renderAndExport}>Render & Export WAV</button>
      {downloadUrl && (
        <a href={downloadUrl} download="convolved_A.wav" style={{ marginLeft: 12 }}>
          Download
        </a>
      )}
    </section>
  );
}