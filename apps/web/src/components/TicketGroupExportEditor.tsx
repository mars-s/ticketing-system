'use client';

import { useState } from 'react';
import type { GroupExportConfig } from '@ticketing/shared';
import {
  buttonGhost,
  buttonPrimary,
  card,
  errorText,
  input,
  label as labelClass,
  mutedText,
} from '@/lib/styles';

type JobStatus = {
  sentAt: Date | null;
  lastError: string | null;
  attempts: number;
} | null;

interface TicketGroupExportEditorProps {
  groupId: string;
  groupName: string;
  initialExportConfig: GroupExportConfig | null;
  notionAvailable: boolean;
  notionIntegrationName: string | null;
  googleSheetsAvailable: boolean;
  googleServiceAccountEmail: string | null;
  lastNotionJob: JobStatus;
  lastSheetsJob: JobStatus;
}

export function TicketGroupExportEditor({
  groupId,
  groupName,
  initialExportConfig,
  notionAvailable,
  notionIntegrationName,
  googleSheetsAvailable,
  googleServiceAccountEmail,
  lastNotionJob,
  lastSheetsJob,
}: TicketGroupExportEditorProps) {
  const [notionEnabled, setNotionEnabled] = useState(initialExportConfig?.notion !== undefined);
  const [databaseId, setDatabaseId] = useState(initialExportConfig?.notion?.databaseId ?? '');
  const [sheetsEnabled, setSheetsEnabled] = useState(initialExportConfig?.googleSheets !== undefined);
  const [spreadsheetId, setSpreadsheetId] = useState(initialExportConfig?.googleSheets?.spreadsheetId ?? '');
  const [sheetName, setSheetName] = useState(initialExportConfig?.googleSheets?.sheetName ?? '');

  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  async function handleSave() {
    setIsSaving(true);
    setError(null);

    const exportConfig: GroupExportConfig | null =
      notionEnabled || sheetsEnabled
        ? {
            ...(notionEnabled ? { notion: { databaseId: databaseId.trim() } } : {}),
            ...(sheetsEnabled
              ? { googleSheets: { spreadsheetId: spreadsheetId.trim(), sheetName: sheetName.trim() || undefined } }
              : {}),
          }
        : null;

    const res = await fetch(`/api/ticket-groups/${groupId}/export-config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ exportConfig }),
    });
    setIsSaving(false);
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setError(body?.error ?? 'Failed to save');
      return;
    }
    setSavedAt(new Date());
  }

  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-text-tertiary">Export</h2>

      <ExportTargetCard
        title="Notion"
        available={notionAvailable}
        unavailableMessage="NOTION_INTEGRATION_TOKEN isn't configured for this deployment -- ask an admin to set it up."
        enabled={notionEnabled}
        onToggle={setNotionEnabled}
        setupCopy={
          notionIntegrationName
            ? `Share your Notion database with the "${notionIntegrationName}" integration, then paste its database ID below.`
            : 'Share your Notion database with this app’s Notion integration, then paste its database ID below.'
        }
        lastJob={lastNotionJob}
        target="notion"
        groupId={groupId}
        canTest={notionEnabled && databaseId.trim().length > 0}
      >
        <label className={labelClass}>
          Database ID
          <input
            className={input}
            value={databaseId}
            onChange={(e) => setDatabaseId(e.target.value)}
            placeholder="e.g. a1b2c3d4e5f6..."
          />
        </label>
      </ExportTargetCard>

      <ExportTargetCard
        title="Google Sheets"
        available={googleSheetsAvailable}
        unavailableMessage="GOOGLE_SERVICE_ACCOUNT_JSON isn't configured for this deployment -- ask an admin to set it up."
        enabled={sheetsEnabled}
        onToggle={setSheetsEnabled}
        setupCopy={
          googleServiceAccountEmail
            ? `Share your Google Sheet with ${googleServiceAccountEmail} as an Editor, then paste the spreadsheet ID below (from its URL).`
            : 'Share your Google Sheet with this app’s service account as an Editor, then paste the spreadsheet ID below.'
        }
        lastJob={lastSheetsJob}
        target="google_sheets"
        groupId={groupId}
        canTest={sheetsEnabled && spreadsheetId.trim().length > 0}
      >
        <label className={labelClass}>
          Spreadsheet ID
          <input
            className={input}
            value={spreadsheetId}
            onChange={(e) => setSpreadsheetId(e.target.value)}
            placeholder="e.g. 1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms"
          />
        </label>
        <label className={labelClass}>
          Sheet/tab name (optional)
          <input className={input} value={sheetName} onChange={(e) => setSheetName(e.target.value)} placeholder="Sheet1" />
        </label>
      </ExportTargetCard>

      <div className="flex items-center gap-3">
        <button type="button" className={buttonPrimary} onClick={handleSave} disabled={isSaving}>
          {isSaving ? 'Saving…' : 'Save changes'}
        </button>
        {savedAt && <span className={mutedText}>Saved</span>}
        {error && <p className={errorText}>{error}</p>}
      </div>
      <p className={mutedText}>Test a target after saving it -- the button below sends one row using {groupName}&apos;s saved config.</p>
    </div>
  );
}

function ExportTargetCard({
  title,
  available,
  unavailableMessage,
  enabled,
  onToggle,
  setupCopy,
  children,
  lastJob,
  target,
  groupId,
  canTest,
}: {
  title: string;
  available: boolean;
  unavailableMessage: string;
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  setupCopy: string;
  children: React.ReactNode;
  lastJob: JobStatus;
  target: 'notion' | 'google_sheets';
  groupId: string;
  canTest: boolean;
}) {
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  async function handleTest() {
    setIsTesting(true);
    setTestResult(null);
    const res = await fetch(`/api/ticket-groups/${groupId}/export-config/test-send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target }),
    });
    setIsTesting(false);
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setTestResult({ ok: false, message: body?.error ?? 'Test send failed' });
      return;
    }
    setTestResult({ ok: true, message: 'Test row sent' });
  }

  return (
    <section className={`${card} flex flex-col gap-3`}>
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-text">{title}</h3>
        <label className="inline-flex items-center gap-2 text-sm text-text-secondary">
          <input
            type="checkbox"
            checked={enabled}
            disabled={!available}
            onChange={(e) => onToggle(e.target.checked)}
            className="h-4 w-4 rounded border-border accent-accent"
          />
          Enabled
        </label>
      </div>
      {!available && <p className={errorText}>{unavailableMessage}</p>}
      {available && enabled && (
        <>
          <p className={mutedText}>{setupCopy}</p>
          {children}
          <div className="flex items-center gap-3 pt-1">
            <button type="button" className={buttonGhost} onClick={handleTest} disabled={!canTest || isTesting}>
              {isTesting ? 'Sending…' : 'Send a test row'}
            </button>
            {testResult && (
              <span className={testResult.ok ? 'text-sm text-success' : errorText}>{testResult.message}</span>
            )}
          </div>
          <JobStatusLine lastJob={lastJob} />
        </>
      )}
    </section>
  );
}

function JobStatusLine({ lastJob }: { lastJob: JobStatus }) {
  if (!lastJob) return <p className={mutedText}>Not synced yet -- delivery runs on a periodic schedule.</p>;
  if (lastJob.sentAt) return <p className={mutedText}>Last synced {lastJob.sentAt.toLocaleString()}.</p>;
  if (lastJob.lastError) return <p className={errorText}>Last attempt failed ({lastJob.attempts}x): {lastJob.lastError}</p>;
  return <p className={mutedText}>Waiting to sync.</p>;
}
