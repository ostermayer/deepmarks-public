// Minimal RFC 4180-ish CSV parser. Handles quoted fields, escaped quotes
// ("" → "), CR/LF line endings. We avoid pulling in a full CSV library since
// our needs are tiny and predictable, and isolated parsers test cleanly.

export interface CsvRow {
  [column: string]: string;
}

export function parseCsv(text: string): CsvRow[] {
  const rows = readRows(text);
  if (rows.length === 0) return [];
  const headers = rows[0]!.map((h) => h.trim());
  return rows.slice(1).map((cells) => {
    const row: CsvRow = {};
    headers.forEach((h, i) => {
      row[h] = cells[i] ?? '';
    });
    return row;
  });
}

function readRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      // Treat \r\n as a single newline.
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      // Skip blank trailing lines.
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else {
      cell += c;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    if (row.length > 1 || row[0] !== '') rows.push(row);
  }
  return rows;
}
