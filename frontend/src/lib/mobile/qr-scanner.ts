import jsQR from 'jsqr';

export type StopQrScanner = () => void;

export function qrScannerUnavailableMessage(): string | null {
  if (typeof window === 'undefined') return 'QR scanning is not available here.';
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

  const detector = Detector ? new Detector({ formats: ['qr_code'] }) : null;
  const canvas = detector ? null : document.createElement('canvas');
  const ctx = canvas?.getContext('2d', { willReadFrequently: true });
  const loop = async () => {
    if (stopped) return;
    try {
      let value = '';
      if (detector) {
        const codes = await detector.detect(videoEl);
        value = codes[0]?.rawValue ?? '';
      } else if (canvas && ctx && videoEl.videoWidth > 0 && videoEl.videoHeight > 0) {
        canvas.width = videoEl.videoWidth;
        canvas.height = videoEl.videoHeight;
        ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
        const frameData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        value = jsQR(frameData.data, frameData.width, frameData.height)?.data ?? '';
      }
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
