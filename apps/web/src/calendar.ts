/** Build an iCalendar (.ics) file of monthly bonus reminders and one-off dates. */

export interface IcsEvent {
  uid: string;
  /** YYYY-MM-DD (all-day). */
  date: string;
  summary: string;
  description: string;
  /** Repeat every month. */
  monthly?: boolean;
}

function escape(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** Fold lines longer than 75 octets, as RFC 5545 asks. */
function fold(line: string): string {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let current = '';
  let size = 0;
  for (const ch of line) {
    const n = new TextEncoder().encode(ch).length;
    if (size + n > (out.length ? 74 : 75)) {
      out.push(current);
      current = '';
      size = 0;
    }
    current += ch;
    size += n;
  }
  out.push(current);
  return out.join('\r\n ');
}

export function buildIcs(events: IcsEvent[], now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Savings compare//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  for (const e of events) {
    const d = e.date.replace(/-/g, '');
    lines.push(
      'BEGIN:VEVENT',
      `UID:${e.uid}@savings-compare`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${d}`,
      ...(e.monthly ? ['RRULE:FREQ=MONTHLY'] : []),
      `SUMMARY:${escape(e.summary)}`,
      `DESCRIPTION:${escape(e.description)}`,
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `DESCRIPTION:${escape(e.summary)}`,
      'TRIGGER:PT9H',
      'END:VALARM',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

export function download(filename: string, text: string, type = 'text/calendar') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
