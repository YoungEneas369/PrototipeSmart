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
export {
  classifyPartitionedZonesFromPhoto,
  partitionCellsFromVectors,
  snapPointToStrongEdge,
  vectorizeUserStroke,
} from './userVectorTrace';
export type { PartitionRectCell, TracedStrokeResult, UserStrokeMode } from './userVectorTrace';
