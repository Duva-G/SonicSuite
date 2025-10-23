type Props = {
  renderAndExport: () => Promise<void> | void;
  downloadUrl: string;
  renderDifference?: () => Promise<void> | void;
  differenceUrl?: string;
};

export default function ExportBar({ renderAndExport, downloadUrl, renderDifference, differenceUrl }: Props) {
  return (
    <section className="panel export-panel">
      <div className="panel-header">
        <div>
          <h2 className="panel-title">Render & export</h2>
          <p className="panel-desc">Bounce an RMS-matched WAV ready for delivery or archiving.</p>
        </div>
        <div className="export-panel__downloads">
          {downloadUrl && (
            <a className="button-link" href={downloadUrl} download="convolved_A.wav">
              Download mix
            </a>
          )}
          {differenceUrl && (
            <a className="button-link" href={differenceUrl} download="difference.wav">
              Download difference
            </a>
          )}
        </div>
      </div>
      <div className="export-panel__actions">
        <button
          type="button"
          className="control-button button-primary export-button"
          onClick={renderAndExport}
        >
          Render mix
        </button>
        {renderDifference && (
          <button
            type="button"
            className="control-button button-ghost export-button"
            onClick={renderDifference}
          >
            Render difference WAV
          </button>
        )}
      </div>
    </section>
  );
}