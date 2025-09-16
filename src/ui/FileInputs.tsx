type Props = {
  onPickMusic: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onPickIR: (e: React.ChangeEvent<HTMLInputElement>) => void;
};

export default function FileInputs({ onPickMusic, onPickIR }: Props) {
  return (
    <section style={{ marginBottom: 12 }}>
      <label>
        Music WAV:
        <input type="file" accept=".wav,audio/wav" onChange={onPickMusic} />
      </label>
      <span style={{ marginLeft: 12 }} />
      <label>
        IR WAV:
        <input type="file" accept=".wav,audio/wav" onChange={onPickIR} />
      </label>
    </section>
  );
}