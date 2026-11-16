import { IMAGE_MAX_EDGE, IMAGE_QUALITY } from './constants';

/**
 * 이미지 리사이즈 (전송 전 클라이언트에서): 긴 변 1024px, JPEG 0.8
 *  - 결과 Blob 은 메모리에만 있다. 기기 저장소(갤러리/다운로드/IndexedDB)에 쓰지 않는다.
 */
function drawToJpeg(src: CanvasImageSource, width: number, height: number): Promise<Blob> {
  const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.reject(new Error('canvas 를 사용할 수 없습니다.'));
  ctx.drawImage(src, 0, 0, w, h);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        // 캔버스 메모리 해제
        canvas.width = 0;
        canvas.height = 0;
        if (blob) resolve(blob);
        else reject(new Error('이미지를 변환하지 못했습니다.'));
      },
      'image/jpeg',
      IMAGE_QUALITY,
    );
  });
}

function loadImageElement(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('이미지를 읽을 수 없습니다.'));
    };
    img.src = url;
  });
}

/** 앨범에서 고른 파일 → 리사이즈된 JPEG (EXIF 회전 반영) */
export async function resizeFile(file: Blob): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    try {
      return await drawToJpeg(bitmap, bitmap.width, bitmap.height);
    } finally {
      bitmap.close();
    }
  } catch {
    const img = await loadImageElement(file);
    return drawToJpeg(img, img.naturalWidth, img.naturalHeight);
  }
}

/** 카메라 미리보기(video)의 현재 프레임 → 리사이즈된 JPEG. 셔터음 없음, 파일로 저장하지 않음 */
export function captureVideoFrame(video: HTMLVideoElement): Promise<Blob> {
  return drawToJpeg(video, video.videoWidth, video.videoHeight);
}
