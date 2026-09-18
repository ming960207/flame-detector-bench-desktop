export interface IndicatorCaptureResultLike<SlotResult> {
  id: string;
  slots: readonly SlotResult[];
}

export function displayResultsForCapture<SlotResult>(
  selectedCaptureId: string | null,
  captures: readonly IndicatorCaptureResultLike<SlotResult>[],
  fallback: readonly SlotResult[],
): SlotResult[] {
  const selected = selectedCaptureId
    ? captures.find((capture) => capture.id === selectedCaptureId)
    : undefined;
  return selected ? [...selected.slots] : [...fallback];
}
