import path from 'node:path';
import { CandidateImportRecord } from './contracts.js';

function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      field = '';
    } else field += char;
  }
  if (quoted) throw new Error('CSV has an unclosed quoted field');
  if (field || row.length) {
    row.push(field.replace(/\r$/, ''));
    rows.push(row);
  }
  return rows.filter((values) => values.some((value) => value.trim()));
}

function csvObjects(text: string): Record<string, unknown>[] {
  const rows = parseCsvRows(text);
  if (rows.length < 2) throw new Error('CSV must contain a header and at least one record');
  const headers = rows[0]!.map((header) => header.trim());
  if (new Set(headers).size !== headers.length || headers.some((header) => !header)) throw new Error('CSV headers must be unique and non-empty');
  return rows.slice(1).map((values, index) => {
    if (values.length > headers.length) throw new Error(`CSV row ${index + 2} has more values than headers`);
    return Object.fromEntries(headers.map((header, column) => [header, values[column]?.trim() || undefined]));
  });
}

function normalizeRecord(record: Record<string, unknown>, index: number): unknown {
  const evidence = typeof record.evidence === 'string' ? record.evidence.split('|').map((item) => item.trim()).filter(Boolean) : record.evidence;
  let raw = record.raw_source_data;
  if (typeof raw === 'string') raw = raw ? JSON.parse(raw) : {};
  return {
    ...record,
    source_record_id: record.source_record_id || `row-${index + 1}`,
    evidence: evidence ?? [],
    raw_source_data: raw ?? record,
  };
}

export function parseCandidateFile(text: string, filename: string) {
  const extension = path.extname(filename).toLowerCase();
  const raw = extension === '.csv' ? csvObjects(text) : JSON.parse(text);
  const records = Array.isArray(raw) ? raw : (raw as { records?: unknown[] }).records;
  if (!Array.isArray(records)) throw new Error('JSON input must be an array or an object with a records array');
  return records.map((record, index) => CandidateImportRecord.parse(normalizeRecord(record as Record<string, unknown>, index)));
}
