// Minimal RFC 4180-ish CSV parser. Handles quoted fields, embedded
// quotes ("") and commas, CR/LF line endings. Returns an array of
// objects keyed by the header row (lowercased, trimmed).

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }

    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ",") { row.push(field); field = ""; i++; continue; }
    if (c === "\r") { i++; continue; }
    if (c === "\n") {
      row.push(field); field = "";
      rows.push(row); row = [];
      i++; continue;
    }
    field += c; i++;
  }
  // Flush trailing field/row
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  if (rows.length === 0) return [];
  const headers = rows[0].map((h) => String(h).trim().toLowerCase());
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    // Skip fully empty lines
    if (cells.every((c) => c.trim() === "")) continue;
    const obj = {};
    for (let c = 0; c < headers.length; c++) {
      obj[headers[c]] = (cells[c] ?? "").trim();
    }
    out.push(obj);
  }
  return out;
}
