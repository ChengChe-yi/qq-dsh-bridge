export function clockOf(seconds) {
  const d = new Date((Number(seconds) || 0) * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function summarize(value) {
  if (value === undefined || value === null) return String(value);
  try {
    const s = JSON.stringify(value);
    return s.length > 200 ? `${s.slice(0, 200)}…` : s;
  } catch {
    return typeof value;
  }
}
