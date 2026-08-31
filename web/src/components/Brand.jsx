export function Brand({ compact = false }) {
  return (
    <span className={`brand${compact ? ' compact' : ''}`} aria-label="职路">
      职路
    </span>
  );
}
