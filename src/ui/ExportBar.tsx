type Props = {
  renderAndExport: () => Promise<void> | void;
  downloadUrl: string;
};

export default function ExportBar({ renderAndExport, downloadUrl }: Props) {
  return (
    <section className="panel export-panel">
      <div className="panel-header">
        <div>
          <h2 className="panel-title">Render &amp; export</h2>
          <p className="panel-desc">Bounce an RMS-matched WAV ready for delivery or archiving.</p>
        </div>
        {downloadUrl && (
          <a className="button-link" href={downloadUrl} download="convolved_A.wav">
            Download mix
          </a>
        )}
      </div>
      <button
        type="button"
        className="control-button button-primary export-button"
        onClick={renderAndExport}
      >
        Render mix
      </button>
    </section>
  );
}