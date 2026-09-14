export interface NormalizedCameraRoi {
  slot: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ContainMediaGeometry {
  containerWidth: number;
  containerHeight: number;
  renderedWidth: number;
  renderedHeight: number;
  offsetX: number;
  offsetY: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function mediaGeometry(
  containerWidth: number,
  containerHeight: number,
  mediaWidth: number,
  mediaHeight: number,
  fit: 'contain' | 'cover',
): ContainMediaGeometry {
  const safeContainerWidth = Math.max(1, containerWidth);
  const safeContainerHeight = Math.max(1, containerHeight);
  const safeMediaWidth = Math.max(1, mediaWidth);
  const safeMediaHeight = Math.max(1, mediaHeight);
  const widthScale = safeContainerWidth / safeMediaWidth;
  const heightScale = safeContainerHeight / safeMediaHeight;
  const scale = fit === 'cover' ? Math.max(widthScale, heightScale) : Math.min(widthScale, heightScale);
  const renderedWidth = safeMediaWidth * scale;
  const renderedHeight = safeMediaHeight * scale;
  return {
    containerWidth: safeContainerWidth,
    containerHeight: safeContainerHeight,
    renderedWidth,
    renderedHeight,
    offsetX: (safeContainerWidth - renderedWidth) / 2,
    offsetY: (safeContainerHeight - renderedHeight) / 2,
  };
}

export function containMediaGeometry(
  containerWidth: number,
  containerHeight: number,
  mediaWidth: number,
  mediaHeight: number,
): ContainMediaGeometry {
  return mediaGeometry(containerWidth, containerHeight, mediaWidth, mediaHeight, 'contain');
}

export function coverMediaGeometry(
  containerWidth: number,
  containerHeight: number,
  mediaWidth: number,
  mediaHeight: number,
): ContainMediaGeometry {
  return mediaGeometry(containerWidth, containerHeight, mediaWidth, mediaHeight, 'cover');
}

export function viewportRoiToSourceRoi(
  roi: NormalizedCameraRoi,
  geometry: ContainMediaGeometry,
): NormalizedCameraRoi {
  const left = roi.x * geometry.containerWidth;
  const top = roi.y * geometry.containerHeight;
  const width = roi.width * geometry.containerWidth;
  const height = roi.height * geometry.containerHeight;
  const sourceWidth = clamp(width / geometry.renderedWidth, 0, 1);
  const sourceHeight = clamp(height / geometry.renderedHeight, 0, 1);
  const sourceX = clamp((left - geometry.offsetX) / geometry.renderedWidth, 0, 1 - sourceWidth);
  const sourceY = clamp((top - geometry.offsetY) / geometry.renderedHeight, 0, 1 - sourceHeight);
  return {
    slot: roi.slot,
    x: sourceX,
    y: sourceY,
    width: sourceWidth,
    height: sourceHeight,
  };
}

export function sourceRoiToViewportRoi(
  roi: NormalizedCameraRoi,
  geometry: ContainMediaGeometry,
): NormalizedCameraRoi {
  const left = geometry.offsetX + roi.x * geometry.renderedWidth;
  const top = geometry.offsetY + roi.y * geometry.renderedHeight;
  const width = roi.width * geometry.renderedWidth;
  const height = roi.height * geometry.renderedHeight;
  return {
    slot: roi.slot,
    x: left / geometry.containerWidth,
    y: top / geometry.containerHeight,
    width: width / geometry.containerWidth,
    height: height / geometry.containerHeight,
  };
}
