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
  MATERIAL_BASE_RGB,
  classifyMelamineMaterial,
  classifyMelamineMaterialFromRgb,
  clusterCarcassVsFronts,
  deltaE76,
  inferMaterialOverrideLab,
  isWarmWoodLab,
  rgbDeltaE,
  rgbToLab,
} from './colorClassifier';
export type { BicolorClusterResult, LabColor } from './colorClassifier';
export {
  boxBlur2D,
  boxBlur3x3,
  clamp,
  computeSobelField,
  computeSobelMag,
  edgeInwardUnitNormal,
  extractLuminanceBuffer,
  gaussianBlur3x3,
  interiorToExteriorPoint,
  interiorToExteriorRect,
  isConvexQuad,
  mad,
  median,
  pointInQuad,
  quadArea,
  rgbaLuminance,
  sampleExteriorBgRgb,
  sampleLumSafe,
  sampleRgbaSafe,
  sobel3x3At,
  sobel3x3AtRgba,
} from './imageOps';
export type { ExteriorPixelRect } from './imageOps';
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
export {
  classifyPartitionedZonesFromPhoto,
  partitionCellsFromVectors,
  snapPointToStrongEdge,
  vectorizeUserStroke,
} from './userVectorTrace';
export type { PartitionRectCell, TracedStrokeResult, UserStrokeMode } from './userVectorTrace';
export {
  evaluate3DvsPhotoSimilarity,
  evaluateMarginsAgainstPhoto,
  extractStructuralVectorLines,
  reconstructStructureFromVectors,
  runIterativePhotoTo3D,
} from './vectorLines';
export type {
  IterativePhoto3DOptions,
  IterativePhoto3DResult,
  MarginEvaluationResult,
  VectorLine2D,
  VectorLineExtractionResult,
  VectorLineOrientation,
  VectorLineRole,
  VectorStructureReconstruction,
  Visual3DSimilarityResult,
} from './vectorLines';
export { findLocalPeaks1D, runRecursiveXYCut } from './xyCut';
export type {
  FindPeaksOptions,
  Peak1D,
  XYCutCandidate,
  XYCutConfig,
  XYCutRegion,
  XYCutResult,
} from './xyCut';
export {
  classifyZonesUnified,
  detectBaseSupportHint,
  detectBasketPattern,
  detectHandlesLocalContrast,
  isGlassDoorFromStats,
  measureCellStats,
  suppressShelvesInsideDrawers,
} from './zoneClassifier';
export type {
  BaseSupportHintResult,
  BasketPatternEstimate,
  CellPixelStats,
  CellRect,
  ZoneClassificationContext,
} from './zoneClassifier';
