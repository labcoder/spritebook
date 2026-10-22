export interface ViewportSize {
  width: number;
  height: number;
  ratio: number;
}

/** Resizing clears the drawing buffer, so apply it only immediately before drawing. */
export function applyViewportSize(
  renderer: { setDrawingBufferSize(width: number, height: number, ratio: number): void },
  camera: { aspect: number; updateProjectionMatrix(): void },
  next: ViewportSize,
  previous?: ViewportSize,
): ViewportSize | undefined {
  if (next.width <= 0 || next.height <= 0) return previous;
  if (
    previous && next.width === previous.width && next.height === previous.height &&
    next.ratio === previous.ratio
  ) return previous;
  renderer.setDrawingBufferSize(next.width, next.height, next.ratio);
  camera.aspect = next.width / next.height;
  camera.updateProjectionMatrix();
  return next;
}
