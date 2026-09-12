import { describe, expect, it } from 'vitest';
import { groupExportConfigSchema } from './exportConfig';

describe('groupExportConfigSchema', () => {
  it('accepts a notion-only config', () => {
    const result = groupExportConfigSchema.parse({ notion: { databaseId: 'abc123' } });
    expect(result).toEqual({ notion: { databaseId: 'abc123' } });
  });

  it('accepts a googleSheets-only config, with and without sheetName', () => {
    expect(groupExportConfigSchema.parse({ googleSheets: { spreadsheetId: 'sheet1' } })).toEqual({
      googleSheets: { spreadsheetId: 'sheet1' },
    });
    expect(
      groupExportConfigSchema.parse({ googleSheets: { spreadsheetId: 'sheet1', sheetName: 'Tickets' } }),
    ).toEqual({ googleSheets: { spreadsheetId: 'sheet1', sheetName: 'Tickets' } });
  });

  it('accepts both targets enabled at once', () => {
    const result = groupExportConfigSchema.parse({
      notion: { databaseId: 'abc123' },
      googleSheets: { spreadsheetId: 'sheet1' },
    });
    expect(result.notion?.databaseId).toBe('abc123');
    expect(result.googleSheets?.spreadsheetId).toBe('sheet1');
  });

  it('rejects an object with neither target set', () => {
    expect(() => groupExportConfigSchema.parse({})).toThrow();
  });

  it('rejects an empty databaseId', () => {
    expect(() => groupExportConfigSchema.parse({ notion: { databaseId: '' } })).toThrow();
  });

  it('rejects an empty spreadsheetId', () => {
    expect(() => groupExportConfigSchema.parse({ googleSheets: { spreadsheetId: '' } })).toThrow();
  });
});
