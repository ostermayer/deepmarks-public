import QRCode from 'qrcode';

const QR_MARGIN = 4;

export function nsecAsciiQr(nsec: string): string {
  const qr = QRCode.create(nsec, { errorCorrectionLevel: 'M' });
  const size = qr.modules.size;
  const rows: string[] = [];

  for (let row = -QR_MARGIN; row < size + QR_MARGIN; row += 1) {
    let line = '';
    for (let col = -QR_MARGIN; col < size + QR_MARGIN; col += 1) {
      const dark =
        row >= 0 &&
        col >= 0 &&
        row < size &&
        col < size &&
        qr.modules.get(row, col) === 1;
      line += dark ? '##' : '  ';
    }
    rows.push(line);
  }

  return rows.join('\n');
}

export async function nsecQrDataUrl(nsec: string): Promise<string> {
  return QRCode.toDataURL(nsec, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 180,
    color: {
      dark: '#102f4b',
      light: '#ffffff',
    },
  });
}

export function buildNsecBackupText({
  nsec,
  npub,
  createdAt = new Date(),
  timestampLabel = 'Generated',
  title = 'Deepmarks identity recovery key',
}: {
  nsec: string;
  npub?: string;
  createdAt?: Date;
  timestampLabel?: string;
  title?: string;
}): string {
  const publicIdentity = npub
    ? [
        `# Public identity. Safe to share.`,
        `npub: ${npub}`,
        ``,
      ]
    : [];

  return [
    `# ${title}`,
    `# ${timestampLabel} ${createdAt.toISOString()}`,
    ``,
    ...publicIdentity,
    `# Recovery key. Keep private. Anyone holding it controls this account forever.`,
    `# Deepmarks cannot reset or recover it for you.`,
    `nsec: ${nsec}`,
    ``,
    `# Scan this QR with the Deepmarks mobile app or another trusted Nostr app.`,
    `# It encodes the same private recovery key shown above.`,
    nsecAsciiQr(nsec),
    ``,
    `# You can import this nsec into any Nostr client: Damus, Primal, Amethyst,`,
    `# Alby, nsec.app, Amber, and other compatible signers. The same identity`,
    `# works across every Nostr app.`,
  ].join('\n');
}
