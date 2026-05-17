export type StopQrScanner = () => void;

export function qrScannerUnavailableMessage(): string | null {
  if (typeof window === 'undefined') return 'QR scanning is not available here.';
  if (!('BarcodeDetector' in window)) return 'QR scanning is not available in this WebView yet.';
  if (!navigator.mediaDevices?.getUserMedia) return 'Camera access is not available in this WebView.';
  return null;
}

export async function startVideoQrScanner(
  videoEl: HTMLVideoElement,
  onValue: (value: string) => void | Promise<void>,
): Promise<StopQrScanner> {
  const unavailable = qrScannerUnavailableMessage();
  if (unavailable) throw new Error(unavailable);

  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' } },
  });
  const Detector = window.BarcodeDetector;
  if (!Detector) {
    stream.getTracks().forEach((track) => track.stop());
    throw new Error('QR scanning is not available in this WebView yet.');
  }

  let stopped = false;
  let frame = 0;
  const stop = () => {
    stopped = true;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    stream.getTracks().forEach((track) => track.stop());
    if (videoEl.srcObject === stream) videoEl.srcObject = null;
  };

  videoEl.srcObject = stream;
  await videoEl.play();

  const detector = new Detector({ formats: ['qr_code'] });
  const loop = async () => {
    if (stopped) return;
    try {
      const codes = await detector.detect(videoEl);
      const value = codes[0]?.rawValue;
      if (value) {
        stop();
        await onValue(value);
        return;
      }
    } catch {
      // Some frames fail while the camera is warming; keep scanning.
    }
    frame = requestAnimationFrame(loop);
  };
  frame = requestAnimationFrame(loop);

  return stop;
}
