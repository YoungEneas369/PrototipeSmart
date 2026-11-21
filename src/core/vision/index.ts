/**
 * Punto de entrada del módulo de Visión Computacional 100% Offline (`src/core/vision/`).
 */
export {
  analyzeRectifiedFurniture,
  detectLowerGapHint,
} from './bandDetector';
export type {
  BandDetectionResult,
  BandDetectorOptions,
  DetectedCavity,
  DetectedHandlePoint,
  LowerGapHintResult,
} from './bandDetector';
export {
  autoDetectFurnitureQuad,
  computeRectifiedSize,
  computeSobelEdgeOverlayRGBA,
  estimateAspectRatioFixedFocal,
  estimateCameraPoseMeters,
  extrapolateDimensionsFromSingleMeasure,
  rectifyImageRGBA,
} from './rectify';
export type { AutoQuadResult, CameraPoseEstimate } from './rectify';
