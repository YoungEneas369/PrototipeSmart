/**
 * SMARTFURNITURE — VISOR 3D PARAMÉTRICO 100% OFFLINE (v8.0)
 * - Three.js 0.162 + R3F 8.18 + Drei 9.122 (luces nativas, cero Environment/HDRI remoto).
 * - Metadatos tipados desde `BoardPiece` (`isGlassDoor`, `handleSide`, `zoneId`, `miterAngleDeg`).
 * - Texturas procedurales `THREE.CanvasTexture` bicolor con veta orientada + limpieza GPU (`dispose`).
 * - `CameraRig` estable: nunca resetea la órbita al escalar X/Y/Z, espesor o altura de patas.
 * - Sincronización bidireccional 2D ↔ 3D (`selectedZoneId`, `hoveredZoneId`, `onSelectZone`, `onHoverZone`).
 * - Bastidor completo de zócalo de 4 lados (`zocalo`), patas, ruedas giratorias, canastos y vidrios con marco.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentRef } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { Edges, Html, Line, OrbitControls } from '@react-three/drei';
import { AlertTriangle, Eye, EyeOff, Layers, RotateCcw, Trash2, X } from 'lucide-react';
import * as THREE from 'three';
import type {
  BaseSupportType,
  BoardCurveProfile,
  BoardPiece,
  DespieceResult,
  FrontModuleKind,
  FrontZone,
  FurnitureTopology,
  MelamineMaterial,
  ScaleAndBoardParams,
  WingRole,
} from '../../types/contracts';
import {
  calculateShelfDeflectionDIN,
  computeSupportLegCoordsMm,
  extractReturnWingTopology,
  resolveBaseSupport,
  resolveLShapePlan,
} from '../../core/mathEngine';
import { MELAMINE_LABELS, ZONE_LABELS } from '../vectorCanvas/geometryHelpers';
import {
  canEditPiecePositionIn3D,
  changeZoneKindFrom3D,
  compute3DEditHandlePositions,
  nudgeDividerMmIn3D,
  nudgeShelfMmIn3D,
  removeDividerIn3D,
  removeShelfIn3D,
  resolveEffectiveLShapePlan,
  splitZoneIn3D,
  updateCubiertaMaterialIn3D,
  updateZoneFrom3D,
} from './viewer3dEditHelpers';

export interface Viewer3DProps {
  despiece: DespieceResult;
  topology: FurnitureTopology;
  params: ScaleAndBoardParams;
  explodeFactor: number;
  displayUnit?: 'mm' | 'cm';
  variant?: 'default' | 'compact' | 'solo';
  modelKey?: string;
  selectedZoneId?: string | null;
  hoveredZoneId?: string | null;
  onSelectZone?: (zoneId: string | null) => void;
  onHoverZone?: (zoneId: string | null) => void;
  onExplodeChange?: (value: number) => void;
  onAddCenterDivider?: () => void;
  onUpdateTopology?: (next: FurnitureTopology) => void;
  onUpdateMaterialOnly?: (material: MelamineMaterial) => void;
  onChangeBaseSupport?: (type: BaseSupportType) => void;
  onToggleLInnerCurve?: (enabled: boolean) => void;
  blankSketchEmpty?: boolean;
}

type CameraPreset = 'iso' | 'front' | 'side';
type BaseSupportResolved = ReturnType<typeof resolveBaseSupport>;

function format3DDim(mm: number, unit: 'mm' | 'cm'): string {
  if (unit === 'cm') {
    return `${Number((mm / 10).toFixed(1))} cm`;
  }
  return `${Math.round(mm)} mm`;
}

function createProceduralTexture(
  kind: MelamineMaterial | 'durolac_3mm',
  verticalGrain = false,
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');

  if (ctx) {
    if (verticalGrain) {
      ctx.translate(128, 128);
      ctx.rotate(Math.PI / 2);
      ctx.translate(-128, -128);
    }

    if (kind === 'blanco') {
      ctx.fillStyle = '#f4f6f8';
      ctx.fillRect(0, 0, 256, 256);
      ctx.fillStyle = 'rgba(148, 163, 184, 0.08)';
      for (let i = 0; i < 256; i += 8) {
        ctx.fillRect(0, i, 256, 1);
      }
    } else if (kind === 'grafito') {
      ctx.fillStyle = '#334155';
      ctx.fillRect(0, 0, 256, 256);
      ctx.fillStyle = 'rgba(15, 23, 42, 0.18)';
      for (let y = 0; y < 256; y += 6) {
        ctx.fillRect(0, y, 256, 2);
      }
    } else if (kind === 'roble') {
      const grad = ctx.createLinearGradient(0, 0, 256, 0);
      grad.addColorStop(0, '#cfa06e');
      grad.addColorStop(0.5, '#d9ae7e');
      grad.addColorStop(1, '#c5925d');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 256, 256);
      ctx.strokeStyle = 'rgba(110, 68, 30, 0.22)';
      ctx.lineWidth = 1.5;
      for (let y = 4; y < 256; y += 9) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        for (let x = 0; x <= 256; x += 32) {
          ctx.lineTo(x, y + Math.sin(x * 0.04 + y * 0.2) * 2.5);
        }
        ctx.stroke();
      }
    } else {
      ctx.fillStyle = '#a47e58';
      ctx.fillRect(0, 0, 256, 256);
      ctx.fillStyle = 'rgba(65, 42, 20, 0.12)';
      for (let i = 0; i < 256; i += 4) {
        ctx.fillRect(i, 0, 1, 256);
      }
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function CurvedBoardMesh({
  piece,
  curveProfile,
  pos,
  tex,
  emissiveColor,
  emissiveIntensity,
  sev,
  isHighlighted,
  edgeColor,
  onClick,
  onPointerOver,
  onPointerOut,
}: {
  piece: BoardPiece;
  curveProfile: BoardCurveProfile;
  pos: [number, number, number];
  tex: THREE.CanvasTexture;
  emissiveColor: string;
  emissiveIntensity: number;
  sev?: 'warning' | 'critical';
  isHighlighted: boolean;
  edgeColor: string;
  onClick: (e: { stopPropagation: () => void }) => void;
  onPointerOver: (e: { stopPropagation: () => void }) => void;
  onPointerOut: () => void;
}) {
  const geom = useMemo(() => {
    const shape = new THREE.Shape();
    const isXZ = curveProfile.extrudePlane === 'xz';
    const isZY = curveProfile.extrudePlane === 'zy';
    curveProfile.pointsMm.forEach((pt, idx) => {
      const sx = pt.x / 1000;
      const sy = isXZ ? -pt.y / 1000 : pt.y / 1000;
      if (idx === 0) shape.moveTo(sx, sy);
      else shape.lineTo(sx, sy);
    });
    shape.closePath();

    const depthM = Math.max(0.003, curveProfile.extrudeDepthMm / 1000);
    const extruded = new THREE.ExtrudeGeometry(shape, {
      depth: depthM,
      bevelEnabled: false,
      curveSegments: 24,
    });
    extruded.translate(0, 0, -depthM / 2);
    if (isXZ) {
      extruded.rotateX(-Math.PI / 2);
    } else if (isZY) {
      extruded.rotateY(-Math.PI / 2);
    }
    extruded.computeVertexNormals();
    return extruded;
  }, [curveProfile]);

  useEffect(() => {
    return () => {
      geom.dispose();
    };
  }, [geom]);

  return (
    <mesh
      position={pos}
      rotation={piece.rotacion3D}
      geometry={geom}
      castShadow
      receiveShadow
      onClick={onClick}
      onPointerOver={onPointerOver}
      onPointerOut={onPointerOut}
    >
      {sev ? (
        <meshStandardMaterial
          color={sev === 'critical' ? '#ef4444' : '#f59e0b'}
          emissive={emissiveColor}
          emissiveIntensity={isHighlighted ? 0.35 : 0}
          roughness={0.45}
        />
      ) : (
        <meshStandardMaterial
          map={tex}
          emissive={emissiveColor}
          emissiveIntensity={emissiveIntensity}
          roughness={0.55}
          metalness={0.05}
        />
      )}
      <Edges color={edgeColor} threshold={22} />
    </mesh>
  );
}

/**
 * Controlador de cámara estable:
 * Solo mueve la cámara al montar inicialmente, cuando el usuario hace clic explícito en
 * un botón de vista (`presetTrigger`) o al cargar un mueble distinto (`modelKey`).
 * Nunca resetea la órbita al escalar X/Y/Z, espesor o altura de patas.
 */
function CameraRig({
  preset,
  presetTrigger,
  modelKey,
  camDist,
  targetY,
  furnitureDimsM,
}: {
  preset: CameraPreset;
  presetTrigger: number;
  modelKey?: string;
  camDist: number;
  targetY: number;
  furnitureDimsM: [number, number, number];
}) {
  const { camera, size } = useThree();
  const controlsRef = useRef<ComponentRef<typeof OrbitControls> | null>(null);
  const camDistRef = useRef<number>(camDist);
  const targetYRef = useRef<number>(targetY);
  const dimsRef = useRef<[number, number, number]>(furnitureDimsM);
  const aspectRef = useRef<number>(size.width / Math.max(1, size.height));

  camDistRef.current = camDist;
  targetYRef.current = targetY;
  dimsRef.current = furnitureDimsM;
  aspectRef.current = size.width / Math.max(1, size.height);

  useEffect(() => {
    const [xm, ymTotal, zm] = dimsRef.current;
    const aspect = Math.max(0.45, aspectRef.current);
    // Compensa el FOV horizontal en paneles angostos (modo Dividido) y deja margen de aire para cotas X/Y/Z
    const apparentHalfW =
      preset === 'front'
        ? xm * 0.5 + 0.16
        : preset === 'side'
          ? zm * 0.5 + 0.16
          : (xm * 0.83 + zm * 0.57) * 0.5 + 0.17;
    const horizFitDist = apparentHalfW / (0.39 * aspect);
    const vertFitDist = (ymTotal * 0.5 + 0.18) / 0.42;
    const dist = Math.max(camDistRef.current, horizFitDist, vertFitDist);
    const ty = targetYRef.current;
    const pos: [number, number, number] =
      preset === 'front'
        ? [0, ty, dist * 1.42]
        : preset === 'side'
          ? [dist * 1.42, ty * 1.05, 0.02]
          : [dist * 0.72, Math.max(ty * 1.15, dist * 0.58), dist * 1.08];

    camera.position.set(pos[0], pos[1], pos[2]);
    if (controlsRef.current) {
      controlsRef.current.target.set(0, ty, 0);
      controlsRef.current.update();
    } else {
      camera.lookAt(0, ty, 0);
    }
  }, [camera, preset, presetTrigger, modelKey]);

  return <OrbitControls ref={controlsRef} makeDefault enableDamping dampingFactor={0.08} />;
}

interface MeshGroupProps {
  despiece: DespieceResult;
  topology: FurnitureTopology;
  params: ScaleAndBoardParams;
  support: BaseSupportResolved;
  hasToeKickPieces: boolean;
  displayUnit: 'mm' | 'cm';
  explodeFactor: number;
  showDimensions: boolean;
  selectedPieceId: string | null;
  selectedZoneId?: string | null;
  hoveredZoneId?: string | null;
  onSelectPiece: (id: string | null) => void;
  onSelectZone?: (zoneId: string | null) => void;
  onHoverZone?: (zoneId: string | null) => void;
  onNudgePiece3D?: (piece: BoardPiece, deltaMm: number) => void;
}

function FurnitureMeshGroup({
  despiece,
  topology,
  params,
  support,
  hasToeKickPieces,
  displayUnit,
  explodeFactor,
  showDimensions,
  selectedPieceId,
  selectedZoneId,
  hoveredZoneId,
  onSelectPiece,
  onSelectZone,
  onHoverZone,
  onNudgePiece3D,
}: MeshGroupProps) {
  useEffect(() => {
    return () => {
      document.body.style.cursor = 'auto';
    };
  }, []);

  const { x: xf, y: yf, z: zf } = params.targetDimensions;
  const e = params.boardThickness;
  const xInt = Math.max(1, xf - 2 * e);
  const yInt = Math.max(1, yf - 2 * e);
  const legHeightMm = support.type === 'legs' || support.type === 'wheels' ? support.heightMm : 0;
  const toeKickMm = support.type === 'toe_kick' && hasToeKickPieces ? support.heightMm : 0;
  const isWheels = support.type === 'wheels';
  const legOffsetY = legHeightMm / 1000;
  const bodyOffsetY = (legHeightMm + toeKickMm) / 1000;

  // Banco completo de texturas procedurales offline (soporta muebles bicolor realistas) + dispose()
  const textureBank = useMemo(() => {
    return {
      blanco: {
        h: createProceduralTexture('blanco', false),
        v: createProceduralTexture('blanco', true),
      },
      roble: {
        h: createProceduralTexture('roble', false),
        v: createProceduralTexture('roble', true),
      },
      grafito: {
        h: createProceduralTexture('grafito', false),
        v: createProceduralTexture('grafito', true),
      },
      durolac: createProceduralTexture('durolac_3mm', false),
    };
  }, []);

  useEffect(() => {
    return () => {
      textureBank.blanco.h.dispose();
      textureBank.blanco.v.dispose();
      textureBank.roble.h.dispose();
      textureBank.roble.v.dispose();
      textureBank.grafito.h.dispose();
      textureBank.grafito.v.dispose();
      textureBank.durolac.dispose();
    };
  }, [textureBank]);

  const effectiveLPlan = useMemo(
    () => resolveEffectiveLShapePlan(topology, params, despiece.matrizDespiece),
    [topology, params, despiece.matrizDespiece],
  );

  const zoneMap = useMemo(() => {
    const map = new Map<
      string,
      { zone: NonNullable<FurnitureTopology['frontZones']>[number]; wing: 'main' | 'return' }
    >();
    for (const z of topology.frontZones ?? []) {
      map.set(z.id, { zone: z, wing: 'main' });
    }
    if (effectiveLPlan?.enabled) {
      for (const z of topology.lShape?.frontZones ?? []) {
        map.set(z.id, { zone: z, wing: 'return' });
      }
    }
    return map;
  }, [topology.frontZones, topology.lShape?.frontZones, effectiveLPlan]);

  const alertMap = useMemo(() => {
    const map = new Map<string, 'warning' | 'critical'>();
    for (const al of despiece.alerts) {
      map.set(al.piezaId, al.severidad);
    }
    return map;
  }, [despiece.alerts]);

  const totalZMm = effectiveLPlan?.enabled ? Math.max(zf, effectiveLPlan.totalLengthMm) : zf;
  const maxBodyYMm = effectiveLPlan?.enabled ? Math.max(yf, effectiveLPlan.heightMm) : yf;
  const cx0 = xf / 2;
  const cy0 = maxBodyYMm / 2;
  const cz0 = totalZMm / 2;
  const explodeDist = explodeFactor * 0.24;

  const piecePosition = (p: BoardPiece): [number, number, number] => {
    const [px, py, pz] = p.posicion3D;
    let dx = px - cx0;
    let dy = py - cy0;
    let dz = pz - cz0;
    if (p.tipo === 'fondo') {
      const rotY = p.rotacion3D[1] ?? 0;
      dx = -Math.sin(rotY);
      dy = 0;
      dz = -Math.cos(rotY);
    } else if (p.tipo === 'zocalo') {
      const xzLen = Math.hypot(dx, dz);
      const nx = xzLen > 1e-4 ? (dx / xzLen) * 0.55 : 0;
      const nz = xzLen > 1e-4 ? (dz / xzLen) * 0.55 : 0;
      dx = nx;
      dy = -0.8;
      dz = nz;
    } else {
      const len = Math.hypot(dx, dy, dz);
      if (len > 1e-4) {
        dx /= len;
        dy /= len;
        dz /= len;
      }
    }
    return [
      px / 1000 + dx * explodeDist,
      py / 1000 + dy * explodeDist,
      pz / 1000 + dz * explodeDist,
    ];
  };

  const xm = xf / 1000;
  const ym = yf / 1000;
  const zm = zf / 1000;
  const totalZm = totalZMm / 1000;

  const legCoords = useMemo<[number, number][]>(
    () =>
      computeSupportLegCoordsMm(topology, params, effectiveLPlan).map((pt) => [
        pt.x / 1000,
        pt.z / 1000,
      ]),
    [topology, params, effectiveLPlan],
  );

  // Geometría 3D procedural de canastos metálicos extraíbles (excluidos de melamina) en ambas alas
  const basketVisuals = useMemo(() => {
    const list: Array<{
      key: string;
      zoneId: string;
      cx: number;
      cy: number;
      cz: number;
      rotY: number;
      w: number;
      h: number;
      d: number;
      railOffsetX: number;
    }> = [];

    const appendWingBaskets = (
      zones: FurnitureTopology['frontZones'],
      wingXLeftStart: number,
      wingXRightEnd: number,
      wingYf: number,
      wingZf: number,
      wingSide: 'main' | 'right' | 'left',
      zStartB = 0,
      netLenB = 0,
    ) => {
      const wXInt = Math.max(1, wingXRightEnd - wingXLeftStart);
      const wYInt = Math.max(1, wingYf - 2 * e);
      for (const z of zones ?? []) {
        if (z.kind !== 'baskets') continue;
        const nb = Math.max(1, Math.min(6, Math.round(z.basketCount ?? 3)));
        const u0 = Math.min(z.uStart, z.uEnd);
        const u1 = Math.max(z.uStart, z.uEnd);
        const v0 = Math.min(z.vStart, z.vEnd);
        const v1 = Math.max(z.vStart, z.vEnd);
        const x0 = wingXLeftStart + u0 * wXInt + (u0 > 0.01 ? e / 2 : 0);
        const x1 = wingXLeftStart + u1 * wXInt - (u1 < 0.99 ? e / 2 : 0);
        const y0 = e + v0 * wYInt + (v0 > 0.01 ? e / 2 : 0);
        const y1 = e + v1 * wYInt - (v1 < 0.99 ? e / 2 : 0);
        const wIn = x1 - x0;
        const hIn = y1 - y0;
        if (wIn < 80 || hIn < 90) continue;
        const bw = Math.max(60, wIn - 24) / 1000;
        const bd = Math.max(120, wingZf - 44) / 1000;
        const slotH = hIn / nb;
        const bh = Math.max(70, Math.min(175, slotH * 0.6)) / 1000;
        const lx = (x0 + x1) / 2;
        const lz = wingZf - 12 - (bd * 1000) / 2 + explodeDist * 650;
        const railOffsetX = Math.max(0.02, wIn / 2000 - 0.005);

        for (let k = 0; k < nb; k++) {
          const cyMm = y0 + (k + 0.44) * slotH;
          const worldX =
            wingSide === 'main'
              ? lx
              : wingSide === 'right'
                ? xf - lz
                : lz;
          const worldZ =
            wingSide === 'main'
              ? lz
              : wingSide === 'right'
                ? zStartB + lx
                : zStartB + netLenB - lx;
          const rotY =
            wingSide === 'main' ? 0 : wingSide === 'right' ? -Math.PI / 2 : Math.PI / 2;
          list.push({
            key: `basket_${wingSide}_${z.id}_${k}`,
            zoneId: z.id,
            cx: worldX / 1000,
            cy: cyMm / 1000,
            cz: worldZ / 1000,
            rotY,
            w: bw,
            h: bh,
            d: bd,
            railOffsetX,
          });
        }
      }
    };

    appendWingBaskets(topology.frontZones, e, xf - e, yf, zf, 'main');
    if (effectiveLPlan?.enabled) {
      const rTop = extractReturnWingTopology(topology);
      const rLeftStart = effectiveLPlan.omitLeftLateral ? 0 : e;
      const rRightEnd = effectiveLPlan.omitRightLateral
        ? effectiveLPlan.netLengthMm
        : effectiveLPlan.netLengthMm - e;
      appendWingBaskets(
        rTop.frontZones,
        rLeftStart,
        rRightEnd,
        effectiveLPlan.heightMm,
        effectiveLPlan.depthMm,
        effectiveLPlan.side,
        effectiveLPlan.zStartB,
        effectiveLPlan.netLengthMm,
      );
    }

    return list;
  }, [topology, effectiveLPlan, e, xf, yf, zf, explodeDist]);

  // Resalte 3D suave para zonas abiertas / hueco de piernas seleccionadas o hovered desde 2D (ambas alas)
  const activeOpenZoneHighlight = useMemo(() => {
    const targetId = hoveredZoneId ?? selectedZoneId ?? null;
    if (!targetId) return null;
    const entry = zoneMap.get(targetId);
    if (!entry) return null;
    const { zone: z, wing } = entry;
    if (z.kind !== 'open' && z.kind !== 'leg_void') return null;

    const u0 = Math.min(z.uStart, z.uEnd);
    const u1 = Math.max(z.uStart, z.uEnd);
    const v0 = Math.min(z.vStart, z.vEnd);
    const v1 = Math.max(z.vStart, z.vEnd);

    if (wing === 'main' || !effectiveLPlan?.enabled) {
      const x0 = e + u0 * xInt;
      const x1 = e + u1 * xInt;
      const y0 = e + v0 * yInt;
      const y1 = e + v1 * yInt;
      const w = (x1 - x0) / 1000;
      const h = (y1 - y0) / 1000;
      const d = Math.max(0.04, (zf - 10) / 1000);
      if (w <= 0.02 || h <= 0.02) return null;
      return {
        cx: (x0 + x1) / 2000,
        cy: (y0 + y1) / 2000,
        cz: zf / 2000,
        rotY: 0,
        w,
        h,
        d,
        isHover: hoveredZoneId === targetId,
      };
    }

    const rLeftStart = effectiveLPlan.omitLeftLateral ? 0 : e;
    const rRightEnd = effectiveLPlan.omitRightLateral
      ? effectiveLPlan.netLengthMm
      : effectiveLPlan.netLengthMm - e;
    const rXInt = Math.max(1, rRightEnd - rLeftStart);
    const rYInt = Math.max(1, effectiveLPlan.heightMm - 2 * e);
    const x0 = rLeftStart + u0 * rXInt;
    const x1 = rLeftStart + u1 * rXInt;
    const y0 = e + v0 * rYInt;
    const y1 = e + v1 * rYInt;
    const w = (x1 - x0) / 1000;
    const h = (y1 - y0) / 1000;
    const d = Math.max(0.04, (effectiveLPlan.depthMm - 10) / 1000);
    if (w <= 0.02 || h <= 0.02) return null;
    const lx = (x0 + x1) / 2;
    const lz = effectiveLPlan.depthMm / 2;
    const worldX = effectiveLPlan.side === 'right' ? xf - lz : lz;
    const worldZ =
      effectiveLPlan.side === 'right'
        ? effectiveLPlan.zStartB + lx
        : effectiveLPlan.zStartB + effectiveLPlan.netLengthMm - lx;
    return {
      cx: worldX / 1000,
      cy: (y0 + y1) / 2000,
      cz: worldZ / 1000,
      rotY: effectiveLPlan.side === 'right' ? -Math.PI / 2 : Math.PI / 2,
      w,
      h,
      d,
      isHover: hoveredZoneId === targetId,
    };
  }, [hoveredZoneId, selectedZoneId, zoneMap, effectiveLPlan, e, xInt, yInt, xf, zf]);

  const renderDims = showDimensions && explodeFactor <= 0.1;
  const activeEditPiece = useMemo(
    () => (selectedPieceId ? despiece.matrizDespiece.find((p) => p.id === selectedPieceId) ?? null : null),
    [despiece.matrizDespiece, selectedPieceId],
  );
  const editHandles = useMemo(() => {
    if (!onNudgePiece3D || !activeEditPiece) return [];
    return compute3DEditHandlePositions(
      activeEditPiece,
      piecePosition(activeEditPiece),
      topology,
      params,
      despiece.matrizDespiece,
    );
  }, [onNudgePiece3D, activeEditPiece, topology, params, despiece.matrizDespiece, explodeDist, cx0, cy0, cz0]);

  return (
    <group position={[-xm / 2, 0, -totalZm / 2]}>
      {/* Patas independientes o Ruedas giratorias (NO forman parte de la melamina) */}
      {(support.type === 'legs' || support.type === 'wheels') && legHeightMm > 0 && (
        <group>
          {legCoords.map(([lx, lz], idx) => {
            if (isWheels) {
              const plateH = Math.min(0.005, legOffsetY * 0.08);
              const wheelR = Math.max(0.014, (legOffsetY - plateH) * 0.44);
              const wheelW = Math.min(0.022, wheelR * 0.8);
              const swivelAngle = idx % 2 === 0 ? 0.25 : -0.2;
              return (
                <group
                  key={`ext_wheel_${idx}`}
                  position={[lx, 0, lz]}
                  rotation={[0, swivelAngle, 0]}
                >
                  <mesh position={[0, legOffsetY - plateH / 2, 0]}>
                    <boxGeometry args={[wheelR * 1.7, plateH, wheelR * 1.7]} />
                    <meshStandardMaterial color="#94a3b8" metalness={0.75} roughness={0.3} />
                  </mesh>
                  <mesh position={[-(wheelW / 2 + 0.0025), legOffsetY - plateH - wheelR * 0.65, 0]}>
                    <boxGeometry args={[0.004, wheelR * 1.3, wheelR * 0.85]} />
                    <meshStandardMaterial color="#64748b" metalness={0.8} roughness={0.28} />
                  </mesh>
                  <mesh position={[wheelW / 2 + 0.0025, legOffsetY - plateH - wheelR * 0.65, 0]}>
                    <boxGeometry args={[0.004, wheelR * 1.3, wheelR * 0.85]} />
                    <meshStandardMaterial color="#64748b" metalness={0.8} roughness={0.28} />
                  </mesh>
                  <mesh position={[0, wheelR, 0]} rotation={[0, 0, Math.PI / 2]} castShadow>
                    <cylinderGeometry args={[wheelR, wheelR, wheelW, 20]} />
                    <meshStandardMaterial color="#f1f5f9" roughness={0.4} metalness={0.1} />
                  </mesh>
                  <mesh position={[0, wheelR, 0]} rotation={[0, 0, Math.PI / 2]}>
                    <cylinderGeometry args={[wheelR * 0.48, wheelR * 0.48, wheelW + 0.003, 14]} />
                    <meshStandardMaterial color="#334155" metalness={0.5} roughness={0.4} />
                  </mesh>
                </group>
              );
            }
            return (
              <mesh key={`ext_leg_${idx}`} position={[lx, legOffsetY / 2, lz]} castShadow>
                <cylinderGeometry args={[0.016, 0.012, legOffsetY, 16]} />
                <meshStandardMaterial color="#1e293b" metalness={0.65} roughness={0.35} />
              </mesh>
            );
          })}
        </group>
      )}

      {/* Cuerpo de Melamina + Zócalo 4 lados + Puertas/Vidrio/Cajones + Fondo Durolac */}
      <group position={[0, bodyOffsetY, 0]}>
        {despiece.matrizDespiece.map((piece) => {
          const [dx, dy, dz] = piece.dimensiones3D;
          const pos = piecePosition(piece);
          const sev = alertMap.get(piece.id);
          const isBack = piece.tipo === 'fondo' || piece.tipo === 'fondo_cajon';
          const pieceZone = piece.zoneId ? zoneMap.get(piece.zoneId)?.zone : undefined;
          const isGlassDoor = piece.isGlassDoor ?? pieceZone?.kind === 'door_glass';
          const isVertical =
            piece.tipo === 'lateral' ||
            piece.tipo === 'division_vertical' ||
            piece.tipo === 'puerta';
          const melMat: MelamineMaterial =
            piece.material === 'blanco' ||
            piece.material === 'roble' ||
            piece.material === 'grafito'
              ? piece.material
              : params.material;
          const tex = isBack
            ? textureBank.durolac
            : isVertical
              ? textureBank[melMat].v
              : textureBank[melMat].h;

          const isSelected = selectedPieceId === piece.id;
          const isZoneSelected = Boolean(selectedZoneId && piece.zoneId && piece.zoneId === selectedZoneId);
          const isZoneHovered = Boolean(hoveredZoneId && piece.zoneId && piece.zoneId === hoveredZoneId);
          const isHighlighted = isSelected || isZoneSelected || isZoneHovered;

          const emissiveColor = isSelected
            ? '#0284c7'
            : isZoneSelected
              ? '#0ea5e9'
              : isZoneHovered
                ? '#38bdf8'
                : '#000000';
          const emissiveIntensity = isSelected
            ? 0.34
            : isZoneSelected
              ? 0.28
              : isZoneHovered
                ? 0.22
                : 0;

          const pieceEdgeColor = isHighlighted
            ? '#0284c7'
            : sev
              ? '#7f1d1d'
              : melMat === 'grafito'
                ? '#94a3b8'
                : '#334155';

          const dxM = dx / 1000;
          const dyM = dy / 1000;
          const dzM = dz / 1000;

          const resolvedHandleSide =
            piece.handleSide ??
            (piece.tipo === 'frente_cajon'
              ? 'top'
              : piece.tipo === 'puerta'
                ? 'right'
                : 'none');

          const showDoorHandle =
            piece.tipo === 'puerta' &&
            resolvedHandleSide !== 'none' &&
            dxM > 0.12 &&
            dyM > 0.16;
          const showDrawerHandle =
            piece.tipo === 'frente_cajon' &&
            resolvedHandleSide !== 'none' &&
            dxM > 0.12 &&
            dyM > 0.055;

          const doorHandlePos: [number, number, number] =
            resolvedHandleSide === 'left'
              ? [-dxM / 2 + Math.min(0.042, dxM * 0.16), 0, dzM / 2 + 0.008]
              : resolvedHandleSide === 'top'
                ? [0, dyM / 2 - Math.min(0.042, dyM * 0.16), dzM / 2 + 0.008]
                : [dxM / 2 - Math.min(0.042, dxM * 0.16), 0, dzM / 2 + 0.008];

          const doorHandleSize: [number, number, number] =
            resolvedHandleSide === 'top'
              ? [Math.min(0.13, dxM * 0.32), 0.01, 0.012]
              : [0.01, Math.min(0.12, dyM * 0.24), 0.012];

          const handleClickPiece = (e: { stopPropagation: () => void }) => {
            e.stopPropagation();
            if (isSelected) {
              onSelectPiece(null);
              onSelectZone?.(null);
              return;
            }
            onSelectPiece(piece.id);
            onSelectZone?.(piece.zoneId ?? null);
          };

          const handlePointerOver = (e: { stopPropagation: () => void }) => {
            e.stopPropagation();
            document.body.style.cursor = 'pointer';
            if (piece.zoneId && onHoverZone) {
              onHoverZone(piece.zoneId);
            }
          };

          const handlePointerOut = () => {
            document.body.style.cursor = 'auto';
            if (piece.zoneId && onHoverZone) {
              onHoverZone(null);
            }
          };

          // Puerta vitrina con bastidor perimetral real de melamina + paño de vidrio translúcido
          const frameW = Math.min(0.06, Math.min(dxM, dyM) * 0.24);
          const innerGlassW = dxM - 2 * frameW;
          const innerGlassH = dyM - 2 * frameW;
          if (isGlassDoor && innerGlassW > 0.03 && innerGlassH > 0.03) {
            return (
              <group
                key={piece.id}
                position={pos}
                rotation={piece.rotacion3D}
                onClick={handleClickPiece}
                onPointerOver={handlePointerOver}
                onPointerOut={handlePointerOut}
              >
                {/* Larguero izquierdo */}
                <mesh position={[-(dxM - frameW) / 2, 0, 0]} castShadow receiveShadow>
                  <boxGeometry args={[frameW, dyM, dzM]} />
                  <meshStandardMaterial
                    map={tex}
                    emissive={emissiveColor}
                    emissiveIntensity={emissiveIntensity}
                    roughness={0.55}
                  />
                  <Edges color={pieceEdgeColor} />
                </mesh>
                {/* Larguero derecho */}
                <mesh position={[(dxM - frameW) / 2, 0, 0]} castShadow receiveShadow>
                  <boxGeometry args={[frameW, dyM, dzM]} />
                  <meshStandardMaterial
                    map={tex}
                    emissive={emissiveColor}
                    emissiveIntensity={emissiveIntensity}
                    roughness={0.55}
                  />
                  <Edges color={pieceEdgeColor} />
                </mesh>
                {/* Cabezal superior */}
                <mesh position={[0, (dyM - frameW) / 2, 0]} castShadow receiveShadow>
                  <boxGeometry args={[innerGlassW, frameW, dzM]} />
                  <meshStandardMaterial
                    map={textureBank[melMat].h}
                    emissive={emissiveColor}
                    emissiveIntensity={emissiveIntensity}
                    roughness={0.55}
                  />
                  <Edges color={pieceEdgeColor} />
                </mesh>
                {/* Cabezal inferior */}
                <mesh position={[0, -(dyM - frameW) / 2, 0]} castShadow receiveShadow>
                  <boxGeometry args={[innerGlassW, frameW, dzM]} />
                  <meshStandardMaterial
                    map={textureBank[melMat].h}
                    emissive={emissiveColor}
                    emissiveIntensity={emissiveIntensity}
                    roughness={0.55}
                  />
                  <Edges color={pieceEdgeColor} />
                </mesh>
                {/* Paño de vidrio 4 mm */}
                <mesh position={[0, 0, 0]}>
                  <boxGeometry args={[innerGlassW, innerGlassH, Math.min(0.005, dzM * 0.45)]} />
                  <meshStandardMaterial
                    color="#bae6fd"
                    transparent
                    opacity={0.42}
                    emissive={emissiveColor}
                    emissiveIntensity={emissiveIntensity * 0.8}
                    roughness={0.12}
                    metalness={0.18}
                  />
                </mesh>
                {showDoorHandle && (
                  <mesh position={doorHandlePos}>
                    <boxGeometry args={doorHandleSize} />
                    <meshStandardMaterial color="#1e293b" metalness={0.75} roughness={0.28} />
                  </mesh>
                )}
              </group>
            );
          }

          if (piece.curveProfile && !isGlassDoor) {
            return (
              <CurvedBoardMesh
                key={piece.id}
                piece={piece}
                curveProfile={piece.curveProfile}
                pos={pos}
                tex={tex}
                emissiveColor={emissiveColor}
                emissiveIntensity={emissiveIntensity}
                sev={sev}
                isHighlighted={isHighlighted}
                edgeColor={pieceEdgeColor}
                onClick={handleClickPiece}
                onPointerOver={handlePointerOver}
                onPointerOut={handlePointerOut}
              />
            );
          }

          return (
            <mesh
              key={piece.id}
              position={pos}
              rotation={piece.rotacion3D}
              castShadow={!isGlassDoor}
              receiveShadow
              onClick={handleClickPiece}
              onPointerOver={handlePointerOver}
              onPointerOut={handlePointerOut}
            >
              <boxGeometry args={[dxM, dyM, dzM]} />
              {sev ? (
                <meshStandardMaterial
                  color={sev === 'critical' ? '#ef4444' : '#f59e0b'}
                  emissive={emissiveColor}
                  emissiveIntensity={isHighlighted ? 0.35 : 0}
                  roughness={0.45}
                />
              ) : isGlassDoor ? (
                <meshStandardMaterial
                  color="#bae6fd"
                  transparent
                  opacity={0.44}
                  emissive={emissiveColor}
                  emissiveIntensity={emissiveIntensity}
                  roughness={0.14}
                  metalness={0.15}
                />
              ) : (
                <meshStandardMaterial
                  map={tex}
                  emissive={emissiveColor}
                  emissiveIntensity={emissiveIntensity}
                  roughness={isBack ? 0.85 : 0.55}
                />
              )}
              <Edges color={pieceEdgeColor} />

              {showDoorHandle && (
                <mesh position={doorHandlePos}>
                  <boxGeometry args={doorHandleSize} />
                  <meshStandardMaterial color="#1e293b" metalness={0.75} roughness={0.28} />
                </mesh>
              )}

              {showDrawerHandle && (
                <mesh
                  position={[
                    0,
                    resolvedHandleSide === 'top' ? Math.min(dyM * 0.16, 0.028) : 0,
                    dzM / 2 + 0.008,
                  ]}
                >
                  <boxGeometry args={[Math.min(0.13, dxM * 0.32), 0.01, 0.012]} />
                  <meshStandardMaterial color="#1e293b" metalness={0.75} roughness={0.28} />
                </mesh>
              )}
            </mesh>
          );
        })}

        {/* Resalte no obstructivo para zonas abiertas o hueco de piernas al pasar el mouse en 2D */}
        {activeOpenZoneHighlight && (
          <mesh
            position={[
              activeOpenZoneHighlight.cx,
              activeOpenZoneHighlight.cy,
              activeOpenZoneHighlight.cz,
            ]}
            rotation={[0, activeOpenZoneHighlight.rotY, 0]}
            raycast={() => null}
          >
            <boxGeometry
              args={[
                activeOpenZoneHighlight.w,
                activeOpenZoneHighlight.h,
                activeOpenZoneHighlight.d,
              ]}
            />
            <meshStandardMaterial
              color={activeOpenZoneHighlight.isHover ? '#38bdf8' : '#0ea5e9'}
              transparent
              opacity={activeOpenZoneHighlight.isHover ? 0.16 : 0.12}
              depthWrite={false}
            />
            <Edges color="#0284c7" />
          </mesh>
        )}

        {/* Canastos metálicos cromados extraíbles (herraje externo no-melamina) */}
        {basketVisuals.map((bk) => {
          const rodR = 0.003;
          const wireOffsets = [-0.36, -0.18, 0, 0.18, 0.36];
          const isBkHighlight =
            selectedZoneId === bk.zoneId || hoveredZoneId === bk.zoneId;
          const wireColor = isBkHighlight ? '#38bdf8' : '#cbd5e1';
          const frontWireColor = isBkHighlight ? '#7dd3fc' : '#e2e8f0';
          return (
            <group
              key={bk.key}
              position={[bk.cx, bk.cy, bk.cz]}
              rotation={[0, bk.rotY, 0]}
              onClick={(e) => {
                e.stopPropagation();
                onSelectPiece(null);
                onSelectZone?.(bk.zoneId);
              }}
              onPointerOver={(e) => {
                e.stopPropagation();
                document.body.style.cursor = 'pointer';
                onHoverZone?.(bk.zoneId);
              }}
              onPointerOut={() => {
                document.body.style.cursor = 'auto';
                onHoverZone?.(null);
              }}
            >
              <mesh position={[-bk.railOffsetX, bk.h * 0.35, 0]}>
                <boxGeometry args={[0.008, 0.012, bk.d]} />
                <meshStandardMaterial color="#64748b" metalness={0.75} roughness={0.3} />
              </mesh>
              <mesh position={[bk.railOffsetX, bk.h * 0.35, 0]}>
                <boxGeometry args={[0.008, 0.012, bk.d]} />
                <meshStandardMaterial color="#64748b" metalness={0.75} roughness={0.3} />
              </mesh>
              <group>
                <mesh position={[0, bk.h / 2, bk.d / 2]}>
                  <boxGeometry args={[bk.w, rodR * 2, rodR * 2]} />
                  <meshStandardMaterial color={wireColor} metalness={0.85} roughness={0.22} />
                </mesh>
                <mesh position={[0, -bk.h / 2, bk.d / 2]}>
                  <boxGeometry args={[bk.w, rodR * 2, rodR * 2]} />
                  <meshStandardMaterial color={wireColor} metalness={0.85} roughness={0.22} />
                </mesh>
                <mesh position={[0, bk.h / 2, -bk.d / 2]}>
                  <boxGeometry args={[bk.w, rodR * 2, rodR * 2]} />
                  <meshStandardMaterial color={wireColor} metalness={0.85} roughness={0.22} />
                </mesh>
                <mesh position={[-bk.w / 2, bk.h / 2, 0]}>
                  <boxGeometry args={[rodR * 2, rodR * 2, bk.d]} />
                  <meshStandardMaterial color={wireColor} metalness={0.85} roughness={0.22} />
                </mesh>
                <mesh position={[bk.w / 2, bk.h / 2, 0]}>
                  <boxGeometry args={[rodR * 2, rodR * 2, bk.d]} />
                  <meshStandardMaterial color={wireColor} metalness={0.85} roughness={0.22} />
                </mesh>
                <mesh position={[0, -bk.h / 2, 0]}>
                  <boxGeometry args={[bk.w, rodR * 1.4, bk.d]} />
                  <meshStandardMaterial
                    color={isBkHighlight ? '#0ea5e9' : '#94a3b8'}
                    metalness={0.7}
                    roughness={0.32}
                    transparent
                    opacity={0.72}
                  />
                </mesh>
                {wireOffsets.map((frac, wi) => (
                  <mesh key={wi} position={[bk.w * frac, 0, bk.d / 2]}>
                    <boxGeometry args={[rodR * 1.6, bk.h, rodR * 1.6]} />
                    <meshStandardMaterial color={frontWireColor} metalness={0.85} roughness={0.2} />
                  </mesh>
                ))}
                {([-1, 1] as const).map((sx) =>
                  ([-1, 1] as const).map((sz) => (
                    <mesh key={`${sx}_${sz}`} position={[(sx * bk.w) / 2, 0, (sz * bk.d) / 2]}>
                      <boxGeometry args={[rodR * 2, bk.h, rodR * 2]} />
                      <meshStandardMaterial color={wireColor} metalness={0.85} roughness={0.22} />
                    </mesh>
                  )),
                )}
              </group>
            </group>
          );
        })}

        {/* Manijas interactivas 3D sobre la repisa o divisor vertical seleccionado */}
        {onNudgePiece3D &&
          activeEditPiece &&
          editHandles.map((h) => (
            <mesh
              key={h.key}
              position={h.positionM}
              rotation={h.rotationRad}
              onClick={(e) => {
                e.stopPropagation();
                onNudgePiece3D(activeEditPiece, h.deltaMm);
              }}
              onPointerOver={(e) => {
                e.stopPropagation();
                document.body.style.cursor = 'pointer';
              }}
              onPointerOut={() => {
                document.body.style.cursor = 'auto';
              }}
            >
              <coneGeometry args={[0.022, 0.044, 16]} />
              <meshStandardMaterial
                color={h.color}
                emissive="#0ea5e9"
                emissiveIntensity={0.35}
                roughness={0.3}
              />
            </mesh>
          ))}

        {/* Cotas 3D dinámicas (pointer-events: none para nunca bloquear clics u órbita) */}
        {renderDims && (
          <>
            <Line
              points={[
                [0, -0.045, zm + 0.05],
                [xm, -0.045, zm + 0.05],
              ]}
              color="#0284c7"
              lineWidth={2}
            />
            <Html
              position={[xm / 2, -0.085, zm + 0.05]}
              center
              zIndexRange={[1, 4]}
              wrapperClass="dim-html-wrapper"
              style={{ pointerEvents: 'none' }}
            >
              <div className="dim-badge">X: {format3DDim(xf, displayUnit)}</div>
            </Html>

            <Line
              points={[
                [xm + 0.045, 0, zm],
                [xm + 0.045, ym, zm],
              ]}
              color="#059669"
              lineWidth={2}
            />
            <Html
              position={[xm + 0.045, ym / 2, zm]}
              center
              zIndexRange={[1, 4]}
              wrapperClass="dim-html-wrapper"
              style={{ pointerEvents: 'none' }}
            >
              <div className="dim-badge dim-y">
                <span>Y: {format3DDim(yf, displayUnit)}</span>
                {support.type === 'wheels' ? (
                  <span className="dim-sub">+{format3DDim(legHeightMm, displayUnit)} ruedas</span>
                ) : support.type === 'legs' ? (
                  <span className="dim-sub">+{format3DDim(legHeightMm, displayUnit)} patas</span>
                ) : support.type === 'toe_kick' && toeKickMm > 0 ? (
                  <span className="dim-sub">+{format3DDim(toeKickMm, displayUnit)} zócalo</span>
                ) : null}
              </div>
            </Html>

            <Line
              points={[
                [-0.055, ym + 0.03, 0],
                [-0.055, ym + 0.03, zm],
              ]}
              color="#7c3aed"
              lineWidth={2}
            />
            <Html
              position={[-0.065, ym + 0.07, zm / 2]}
              center
              zIndexRange={[1, 4]}
              wrapperClass="dim-html-wrapper"
              style={{ pointerEvents: 'none' }}
            >
              <div className="dim-badge dim-z">Z: {format3DDim(zf, displayUnit)}</div>
            </Html>

            {effectiveLPlan?.enabled && (() => {
              const rzM = effectiveLPlan.depthMm / 1000;
              const retX0 = effectiveLPlan.side === 'right' ? xm - rzM : 0;
              const retX1 = effectiveLPlan.side === 'right' ? xm : rzM;
              const l2EdgeX = effectiveLPlan.side === 'right' ? xm + 0.065 : -0.065;
              const retYm = effectiveLPlan.heightMm / 1000;
              return (
                <>
                  <Line
                    points={[
                      [l2EdgeX, -0.045, 0],
                      [l2EdgeX, -0.045, totalZm],
                    ]}
                    color="#0284c7"
                    lineWidth={2}
                  />
                  <Html
                    position={[l2EdgeX, -0.085, totalZm / 2]}
                    center
                    zIndexRange={[1, 4]}
                    wrapperClass="dim-html-wrapper"
                    style={{ pointerEvents: 'none' }}
                  >
                    <div className="dim-badge">
                      L2: {format3DDim(totalZMm, displayUnit)}
                    </div>
                  </Html>
                  <Line
                    points={[
                      [retX0, retYm + 0.03, totalZm + 0.045],
                      [retX1, retYm + 0.03, totalZm + 0.045],
                    ]}
                    color="#7c3aed"
                    lineWidth={2}
                  />
                  <Html
                    position={[(retX0 + retX1) / 2, retYm + 0.07, totalZm + 0.045]}
                    center
                    zIndexRange={[1, 4]}
                    wrapperClass="dim-html-wrapper"
                    style={{ pointerEvents: 'none' }}
                  >
                    <div className="dim-badge dim-z">
                      Z2: {format3DDim(effectiveLPlan.depthMm, displayUnit)}
                    </div>
                  </Html>
                </>
              );
            })()}
          </>
        )}
      </group>
    </group>
  );
}

export function Viewer3D({
  despiece,
  topology,
  params,
  explodeFactor,
  displayUnit = 'mm',
  variant = 'default',
  modelKey,
  selectedZoneId,
  hoveredZoneId,
  onSelectZone,
  onHoverZone,
  onExplodeChange,
  onAddCenterDivider,
  onUpdateTopology,
  onUpdateMaterialOnly,
  onChangeBaseSupport,
  onToggleLInnerCurve,
  blankSketchEmpty = false,
}: Viewer3DProps) {
  const [camPreset, setCamPreset] = useState<CameraPreset>('iso');
  const [camTrigger, setCamTrigger] = useState<number>(0);
  const [showDimensions, setShowDimensions] = useState<boolean>(true);
  const [selectedPieceId, setSelectedPieceId] = useState<string | null>(null);
  const [explodeOpen, setExplodeOpen] = useState<boolean>(false);
  const pendingReselectRef = useRef<{
    tipo: BoardPiece['tipo'];
    wing: WingRole;
    targetPos: [number, number, number];
  } | null>(null);

  // Limpia o re-vincula la pieza seleccionada cuando la topología cambia (p.ej. equidistant -> custom)
  useEffect(() => {
    if (selectedPieceId && despiece.matrizDespiece.some((p) => p.id === selectedPieceId)) {
      pendingReselectRef.current = null;
      return;
    }
    const hint = pendingReselectRef.current;
    pendingReselectRef.current = null;
    if (hint) {
      let bestPiece: BoardPiece | null = null;
      let bestDist = 80;
      for (const p of despiece.matrizDespiece) {
        if (p.tipo !== hint.tipo || (p.wing ?? 'main') !== hint.wing) continue;
        const dist = Math.hypot(
          p.posicion3D[0] - hint.targetPos[0],
          p.posicion3D[1] - hint.targetPos[1],
          p.posicion3D[2] - hint.targetPos[2],
        );
        if (dist < bestDist) {
          bestDist = dist;
          bestPiece = p;
        }
      }
      if (bestPiece) {
        setSelectedPieceId(bestPiece.id);
        return;
      }
    }
    if (selectedPieceId) {
      setSelectedPieceId(null);
    }
  }, [despiece.matrizDespiece, selectedPieceId]);

  useEffect(() => {
    setExplodeOpen(false);
  }, [modelKey]);

  const selectedPiece = useMemo(
    () => despiece.matrizDespiece.find((p) => p.id === selectedPieceId) ?? null,
    [despiece.matrizDespiece, selectedPieceId],
  );

  const activeZoneEntry = useMemo<{ zone: FrontZone; wing: WingRole } | null>(() => {
    const zId = selectedPiece?.zoneId ?? selectedZoneId ?? null;
    if (!zId) return null;
    const mainMatch = (topology.frontZones ?? []).find((z) => z.id === zId);
    if (mainMatch) return { zone: mainMatch, wing: 'main' };
    if (topology.lShape?.enabled) {
      const retMatch = (topology.lShape.frontZones ?? []).find((z) => z.id === zId);
      if (retMatch) return { zone: retMatch, wing: 'return' };
    }
    return null;
  }, [selectedPiece?.zoneId, selectedZoneId, topology.frontZones, topology.lShape]);

  const selectedPieceZoneLabel =
    activeZoneEntry?.zone.label ?? activeZoneEntry?.zone.id ?? null;

  const selectedPieceDin = useMemo(() => {
    if (!selectedPiece || selectedPiece.tipo !== 'repisa') return null;
    return calculateShelfDeflectionDIN(
      selectedPiece.ancho,
      selectedPiece.alto,
      selectedPiece.espesor,
      25,
    );
  }, [selectedPiece]);

  const supportSummary = useMemo(() => resolveBaseSupport(topology), [topology]);
  const hasToeKickPieces = useMemo(
    () => despiece.matrizDespiece.some((p) => p.tipo === 'zocalo'),
    [despiece.matrizDespiece],
  );
  const legExtraMm =
    supportSummary.type === 'toe_kick'
      ? hasToeKickPieces
        ? supportSummary.heightMm
        : 0
      : supportSummary.heightMm;
  const lPlanOuter = useMemo(() => resolveLShapePlan(topology, params), [topology, params]);
  const totalZMm = useMemo(() => {
    if (!lPlanOuter?.enabled) return params.targetDimensions.z;
    let maxZ = Math.max(params.targetDimensions.z, lPlanOuter.totalLengthMm);
    for (const p of despiece.matrizDespiece) {
      if (p.wing !== 'return') continue;
      const rotY = p.rotacion3D[1] ?? 0;
      const cosY = Math.abs(Math.cos(rotY));
      const sinY = Math.abs(Math.sin(rotY));
      const worldDz = p.dimensiones3D[0] * sinY + p.dimensiones3D[2] * cosY;
      maxZ = Math.max(maxZ, p.posicion3D[2] + worldDz / 2);
    }
    return maxZ;
  }, [lPlanOuter, params.targetDimensions.z, despiece.matrizDespiece]);

  const xm = params.targetDimensions.x / 1000;
  const maxBodyYMm = lPlanOuter?.enabled
    ? Math.max(params.targetDimensions.y, lPlanOuter.heightMm)
    : params.targetDimensions.y;
  const ymTotal = (maxBodyYMm + legExtraMm) / 1000;
  const zm = totalZMm / 1000;
  const maxDim = Math.max(xm, ymTotal, zm);
  const camDist = Math.max(2.0, maxDim * 1.84);
  const targetY = ymTotal / 2;

  const pandeoAlerts = despiece.alerts.filter((a) => a.tipo === 'pandeo');
  const maxSpan = pandeoAlerts.reduce((m, a) => Math.max(m, a.luzLibreMm ?? 0), 0);

  const canEditSelectedPos = Boolean(
    selectedPiece &&
      onUpdateTopology &&
      canEditPiecePositionIn3D(topology, params, selectedPiece, despiece.matrizDespiece),
  );

  const handleNudgePiece = (piece: BoardPiece, deltaMm: number) => {
    if (!onUpdateTopology) return;
    const next =
      piece.tipo === 'repisa'
        ? nudgeShelfMmIn3D(topology, params, piece, deltaMm, despiece.matrizDespiece)
        : piece.tipo === 'division_vertical'
          ? nudgeDividerMmIn3D(topology, params, piece, deltaMm, despiece.matrizDespiece)
          : null;
    if (!next) return;
    const [px, py, pz] = piece.posicion3D;
    let targetPos: [number, number, number] = [px, py, pz];
    if (piece.tipo === 'repisa') {
      targetPos = [px, py + deltaMm, pz];
    } else if (piece.wing === 'return') {
      const sideSign = topology.lShape?.side === 'left' ? -1 : 1;
      targetPos = [px, py, pz + sideSign * deltaMm];
    } else {
      targetPos = [px + deltaMm, py, pz];
    }
    pendingReselectRef.current = {
      tipo: piece.tipo,
      wing: piece.wing ?? 'main',
      targetPos,
    };
    onUpdateTopology(next);
  };

  const handleRemoveSelectedPiece = (piece: BoardPiece) => {
    if (!onUpdateTopology) return;
    const next =
      piece.tipo === 'repisa'
        ? removeShelfIn3D(topology, params, piece, despiece.matrizDespiece)
        : piece.tipo === 'division_vertical'
          ? removeDividerIn3D(topology, params, piece, despiece.matrizDespiece)
          : null;
    if (!next) return;
    pendingReselectRef.current = null;
    setSelectedPieceId(null);
    onUpdateTopology(next);
  };

  const lInnerCurveEnabled = Boolean(
    topology.curvedCuts?.some((c) => c.cornerTarget === 'l_inner'),
  );
  const melamineList: readonly MelamineMaterial[] = ['blanco', 'roble', 'grafito'];
  const moduleKindList: readonly FrontModuleKind[] = [
    'open',
    'door_left',
    'door_right',
    'door_double',
    'door_glass',
    'drawers',
    'baskets',
    'leg_void',
    'void_outside',
  ];

  const selectView = (next: CameraPreset) => {
    setCamPreset(next);
    setCamTrigger((n) => n + 1);
  };

  const handleToggleExplode = () => {
    if (!onExplodeChange) return;
    if (explodeOpen || explodeFactor > 0) {
      setExplodeOpen(false);
      onExplodeChange(0);
    } else {
      setExplodeOpen(true);
      onExplodeChange(0.5);
    }
  };

  const wrapperClass = [
    'viewer3d-wrapper',
    variant === 'compact' ? 'viewer3d-compact' : '',
    variant === 'solo' ? 'viewer3d-solo' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={wrapperClass}>
      <div className="viewer3d-overlay-top">
        <div className="viewer3d-badges">
          <span
            className="viewer3d-pill"
            title={
              blankSketchEmpty
                ? 'Dibuja un contorno cerrado en el lienzo 2D para generar piezas 3D'
                : 'Haz clic sobre cualquier placa para inspeccionar medidas de corte'
            }
          >
            {blankSketchEmpty ? '0 piezas' : `${despiece.matrizDespiece.length} piezas`}
          </span>
          {blankSketchEmpty && (
            <span className="badge-support">Boceto abierto · esperando contorno</span>
          )}
          {!blankSketchEmpty &&
            (supportSummary.type === 'legs' || supportSummary.type === 'wheels') && (
              <span className="badge-legs">
                {supportSummary.type === 'wheels' ? 'Ruedas' : 'Patas'} ({supportSummary.count} ×{' '}
                {format3DDim(supportSummary.heightMm, displayUnit)})
              </span>
            )}
          {!blankSketchEmpty && supportSummary.type === 'toe_kick' && hasToeKickPieces && (
            <span className="badge-support">
              Zócalo ({format3DDim(supportSummary.heightMm, displayUnit)})
            </span>
          )}
        </div>

        <div className="viewer3d-controls-right">
          <div className="viewer3d-cam-bar" role="toolbar" aria-label="Controles de cámara 3D">
            <button
              type="button"
              className={camPreset === 'iso' ? 'cam-btn active' : 'cam-btn'}
              onClick={() => selectView('iso')}
              title="Vista isométrica 3/4"
              aria-label="Vista isométrica 3/4"
            >
              Iso
            </button>
            <button
              type="button"
              className={camPreset === 'front' ? 'cam-btn active' : 'cam-btn'}
              onClick={() => selectView('front')}
              title="Vista frontal XY"
              aria-label="Vista frontal XY"
            >
              Frente
            </button>
            <button
              type="button"
              className={camPreset === 'side' ? 'cam-btn active' : 'cam-btn'}
              onClick={() => selectView('side')}
              title="Vista lateral ZY"
              aria-label="Vista lateral ZY"
            >
              Lateral
            </button>
            <button
              type="button"
              className={showDimensions ? 'cam-btn active' : 'cam-btn'}
              onClick={() => setShowDimensions((v) => !v)}
              title="Mostrar u ocultar cotas 3D"
              aria-label={showDimensions ? 'Ocultar cotas 3D' : 'Mostrar cotas 3D'}
            >
              {showDimensions ? <Eye size={13} /> : <EyeOff size={13} />} Cotas
            </button>
            {onExplodeChange && (
              <button
                type="button"
                className={explodeOpen || explodeFactor > 0 ? 'cam-btn active' : 'cam-btn'}
                onClick={handleToggleExplode}
                title="Separar piezas en vista explotada (0%–100%)"
                aria-label="Separar piezas en vista explotada"
                aria-pressed={explodeOpen || explodeFactor > 0}
              >
                <Layers size={13} />
                {explodeFactor > 0 ? `${Math.round(explodeFactor * 100)}%` : 'Explotar'}
              </button>
            )}
            <button
              type="button"
              className="cam-btn"
              onClick={() => selectView(camPreset)}
              title="Centrar y restablecer cámara"
              aria-label="Centrar y restablecer cámara"
            >
              <RotateCcw size={13} />
            </button>
          </div>

          {onExplodeChange && (explodeOpen || explodeFactor > 0) && (
            <div className="viewer3d-explode-popover" role="group" aria-label="Separación vista explotada">
              <span className="small-note muted">Explotada</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={explodeFactor}
                onChange={(e) => onExplodeChange(Number(e.target.value))}
                aria-label="Porcentaje de vista explotada"
              />
              <strong className="mono">{Math.round(explodeFactor * 100)}%</strong>
            </div>
          )}
        </div>
      </div>

      {blankSketchEmpty && (
        <div className="viewer3d-blank-empty-banner" role="status" aria-live="polite">
          <strong>Lienzo libre limpio</strong>
          <span>Dibuja líneas cerradas o contorno para generar el modelo 3D</span>
        </div>
      )}

      {!blankSketchEmpty && (selectedPiece || activeZoneEntry || pandeoAlerts.length > 0) && (
        <div className="viewer3d-bottom-stack">
          {(selectedPiece || activeZoneEntry) && (
            <div className="viewer3d-piece-hud">
              <div className="piece-hud-content">
                {selectedPiece ? (
                  <>
                    <div className="piece-hud-title">
                      <strong>{selectedPiece.nombre}</strong>
                      <span className="piece-hud-tag">{selectedPiece.tipo}</span>
                      {selectedPiece.wing && (
                        <span className="piece-hud-tag">
                          {selectedPiece.wing === 'return' ? 'Ala Retorno B' : 'Ala Principal A'}
                        </span>
                      )}
                      {selectedPieceZoneLabel && (
                        <span className="piece-hud-tag zone-tag">
                          Zona: {selectedPieceZoneLabel}
                        </span>
                      )}
                      <span className="mono">
                        Corte:{' '}
                        <strong>
                          {selectedPiece.ancho.toFixed(1)} × {selectedPiece.alto.toFixed(1)} ×{' '}
                          {selectedPiece.espesor} mm
                        </strong>
                      </span>
                    </div>
                    <div className="piece-hud-meta mono">
                      <span>
                        Centro ℝ³: ({selectedPiece.posicion3D.map((v) => Math.round(v)).join(', ')})
                        mm
                      </span>
                      <span>Acabado: {selectedPiece.material}</span>
                      <span>Veta: {selectedPiece.respectGrain ? 'Eje ancho' : 'Libre'}</span>
                      {selectedPiece.miterAngleDeg !== undefined && (
                        <span>Inglete: {selectedPiece.miterAngleDeg.toFixed(1)}°</span>
                      )}
                      {selectedPiece.curveProfile && (
                        <span>
                          Curva: arco={selectedPiece.curveProfile.arcLengthMm.toFixed(1)} mm (R_mín=
                          {selectedPiece.curveProfile.minRadiusMm.toFixed(0)} mm)
                        </span>
                      )}
                      {selectedPieceDin && (
                        <span className={selectedPieceDin.passesDIN ? 'din-pill ok' : 'din-pill bad'}>
                          DIN 68874-1: δ={selectedPieceDin.deflectionMm.toFixed(2)} mm /{' '}
                          {selectedPieceDin.allowableMm.toFixed(2)} mm (máx.{' '}
                          {selectedPieceDin.maxLoadKg.toFixed(1)} kg)
                        </span>
                      )}
                    </div>
                  </>
                ) : (
                  activeZoneEntry && (
                    <div className="piece-hud-title">
                      <strong>Zona {activeZoneEntry.zone.label ?? activeZoneEntry.zone.id}</strong>
                      <span className="piece-hud-tag zone-tag">
                        {ZONE_LABELS[activeZoneEntry.zone.kind]}
                      </span>
                      <span className="piece-hud-tag">
                        {activeZoneEntry.wing === 'return' ? 'Ala Retorno B' : 'Ala Principal A'}
                      </span>
                    </div>
                  )
                )}

                {(onUpdateTopology ||
                  onUpdateMaterialOnly ||
                  onChangeBaseSupport ||
                  onToggleLInnerCurve) && (
                  <div className="piece-hud-edit-bar" role="group" aria-label="Edición directa en 3D">
                    {canEditSelectedPos && selectedPiece && (
                      <div className="hud-edit-group">
                        <span className="hud-edit-label">
                          {selectedPiece.tipo === 'repisa' ? 'Altura:' : 'Posición:'}
                        </span>
                        <button
                          type="button"
                          className="hud-edit-btn"
                          onClick={() => handleNudgePiece(selectedPiece, -10)}
                          title="Desplazar -10 mm"
                        >
                          {selectedPiece.tipo === 'repisa' ? '▼ -10 mm' : '◀ -10 mm'}
                        </button>
                        <button
                          type="button"
                          className="hud-edit-btn"
                          onClick={() => handleNudgePiece(selectedPiece, 10)}
                          title="Desplazar +10 mm"
                        >
                          {selectedPiece.tipo === 'repisa' ? '▲ +10 mm' : '▶ +10 mm'}
                        </button>
                        <button
                          type="button"
                          className="hud-edit-btn danger"
                          onClick={() => handleRemoveSelectedPiece(selectedPiece)}
                          title="Eliminar esta placa del mueble"
                        >
                          <Trash2 size={11} /> Quitar
                        </button>
                      </div>
                    )}

                    {activeZoneEntry && onUpdateTopology && (() => {
                      const { zone, wing } = activeZoneEntry;
                      const supportsColor =
                        zone.kind === 'door_left' ||
                        zone.kind === 'door_right' ||
                        zone.kind === 'door_double' ||
                        zone.kind === 'door_glass' ||
                        zone.kind === 'drawers';
                      const activeCubiertaWingMat =
                        wing === 'return'
                          ? topology.lShape?.cubiertaMaterialOverride
                          : topology.cubiertaMaterialOverride;
                      return (
                        <>
                          <div className="hud-edit-group">
                            <span className="hud-edit-label">Módulo:</span>
                            <select
                              className="hud-edit-select"
                              aria-label="Tipo de módulo 3D"
                              value={zone.kind}
                              onChange={(ev) =>
                                onUpdateTopology(
                                  changeZoneKindFrom3D(
                                    topology,
                                    wing,
                                    zone.id,
                                    ev.target.value as FrontModuleKind,
                                  ),
                                )
                              }
                            >
                              {moduleKindList.map((mk) => (
                                <option key={mk} value={mk}>
                                  {ZONE_LABELS[mk]}
                                </option>
                              ))}
                            </select>
                            {(zone.kind === 'drawers' || zone.kind === 'baskets') && (() => {
                              const isDrawers = zone.kind === 'drawers';
                              const count = isDrawers
                                ? (zone.drawerCount ?? 3)
                                : (zone.basketCount ?? 3);
                              const setCount = (nextN: number) => {
                                const clamped = Math.max(1, Math.min(6, nextN));
                                onUpdateTopology(
                                  updateZoneFrom3D(
                                    topology,
                                    wing,
                                    zone.id,
                                    isDrawers ? { drawerCount: clamped } : { basketCount: clamped },
                                  ),
                                );
                              };
                              return (
                                <>
                                  <button
                                    type="button"
                                    className="hud-edit-btn"
                                    onClick={() => setCount(count - 1)}
                                    aria-label="Menos cajones o canastos"
                                  >
                                    −
                                  </button>
                                  <span className="hud-edit-count mono">{count}</span>
                                  <button
                                    type="button"
                                    className="hud-edit-btn"
                                    onClick={() => setCount(count + 1)}
                                    aria-label="Más cajones o canastos"
                                  >
                                    +
                                  </button>
                                </>
                              );
                            })()}
                            <button
                              type="button"
                              className="hud-edit-btn"
                              onClick={() => {
                                const res = splitZoneIn3D(topology, params, wing, zone.id, 'cols');
                                if (res) {
                                  setSelectedPieceId(null);
                                  onUpdateTopology(res.topology);
                                  onSelectZone?.(res.newSelectedZoneId);
                                }
                              }}
                              title="Dividir esta zona verticalmente"
                            >
                              + Divisor
                            </button>
                            <button
                              type="button"
                              className="hud-edit-btn"
                              onClick={() => {
                                const res = splitZoneIn3D(topology, params, wing, zone.id, 'rows');
                                if (res) {
                                  setSelectedPieceId(null);
                                  onUpdateTopology(res.topology);
                                  onSelectZone?.(res.newSelectedZoneId);
                                }
                              }}
                              title="Dividir esta zona con una repisa horizontal"
                            >
                              + Repisa
                            </button>
                          </div>

                          {supportsColor && (
                            <div className="hud-edit-group">
                              <span className="hud-edit-label">Frente:</span>
                              <button
                                type="button"
                                className={
                                  !zone.materialOverride ? 'hud-edit-btn active' : 'hud-edit-btn'
                                }
                                onClick={() =>
                                  onUpdateTopology(
                                    updateZoneFrom3D(topology, wing, zone.id, {
                                      materialOverride: activeCubiertaWingMat,
                                    }),
                                  )
                                }
                              >
                                Cuerpo
                              </button>
                              {melamineList.map((mat) => (
                                <button
                                  key={`z_mat_${mat}`}
                                  type="button"
                                  className={
                                    zone.materialOverride === mat
                                      ? 'hud-edit-btn active'
                                      : 'hud-edit-btn'
                                  }
                                  onClick={() =>
                                    onUpdateTopology(
                                      updateZoneFrom3D(topology, wing, zone.id, {
                                        materialOverride: mat,
                                      }),
                                    )
                                  }
                                >
                                  {MELAMINE_LABELS[mat]}
                                </button>
                              ))}
                            </div>
                          )}
                        </>
                      );
                    })()}

                    {selectedPiece?.tipo === 'cubierta' && onUpdateTopology && (() => {
                      const wing: WingRole = selectedPiece.wing === 'return' ? 'return' : 'main';
                      const curCubMat =
                        wing === 'return'
                          ? topology.lShape?.cubiertaMaterialOverride
                          : topology.cubiertaMaterialOverride;
                      return (
                        <div className="hud-edit-group">
                          <span className="hud-edit-label">Cubierta:</span>
                          <button
                            type="button"
                            className={!curCubMat ? 'hud-edit-btn active' : 'hud-edit-btn'}
                            onClick={() =>
                              onUpdateTopology(updateCubiertaMaterialIn3D(topology, wing, undefined))
                            }
                          >
                            Cuerpo
                          </button>
                          {melamineList.map((mat) => (
                            <button
                              key={`cub_mat_${mat}`}
                              type="button"
                              className={curCubMat === mat ? 'hud-edit-btn active' : 'hud-edit-btn'}
                              onClick={() =>
                                onUpdateTopology(updateCubiertaMaterialIn3D(topology, wing, mat))
                              }
                            >
                              {MELAMINE_LABELS[mat]}
                            </button>
                          ))}
                          {topology.lShape?.enabled && onToggleLInnerCurve && (
                            <button
                              type="button"
                              className={
                                lInnerCurveEnabled ? 'hud-edit-btn active' : 'hud-edit-btn'
                              }
                              onClick={() => onToggleLInnerCurve(!lInnerCurveEnabled)}
                            >
                              Curva interior L
                            </button>
                          )}
                        </div>
                      );
                    })()}

                    {selectedPiece &&
                      (selectedPiece.tipo === 'lateral' ||
                        selectedPiece.tipo === 'base' ||
                        selectedPiece.tipo === 'fondo' ||
                        selectedPiece.tipo === 'zocalo') && (
                        <>
                          {onUpdateMaterialOnly && (
                            <div className="hud-edit-group">
                              <span className="hud-edit-label">Melamina:</span>
                              {melamineList.map((mat) => (
                                <button
                                  key={`body_mat_${mat}`}
                                  type="button"
                                  className={
                                    params.material === mat ? 'hud-edit-btn active' : 'hud-edit-btn'
                                  }
                                  onClick={() => onUpdateMaterialOnly(mat)}
                                >
                                  {MELAMINE_LABELS[mat]}
                                </button>
                              ))}
                            </div>
                          )}
                          {(selectedPiece.tipo === 'base' || selectedPiece.tipo === 'zocalo') &&
                            onChangeBaseSupport && (
                              <div className="hud-edit-group">
                                <span className="hud-edit-label">Apoyo:</span>
                                <select
                                  className="hud-edit-select"
                                  aria-label="Tipo de apoyo del mueble"
                                  value={supportSummary.type}
                                  onChange={(ev) =>
                                    onChangeBaseSupport(ev.target.value as BaseSupportType)
                                  }
                                >
                                  <option value="none">Al piso</option>
                                  <option value="legs">Patas</option>
                                  <option value="wheels">Ruedas</option>
                                  <option value="toe_kick">Zócalo</option>
                                </select>
                              </div>
                            )}
                          {selectedPiece.tipo === 'fondo' &&
                            !activeZoneEntry &&
                            onAddCenterDivider && (
                              <button
                                type="button"
                                className="hud-edit-btn"
                                onClick={onAddCenterDivider}
                              >
                                + Divisor central
                              </button>
                            )}
                        </>
                      )}
                  </div>
                )}
              </div>
              <button
                type="button"
                className="hud-close-btn"
                onClick={() => {
                  setSelectedPieceId(null);
                  onSelectZone?.(null);
                }}
                aria-label="Cerrar inspector de pieza"
                title="Cerrar"
              >
                <X size={14} />
              </button>
            </div>
          )}

          {pandeoAlerts.length > 0 && (
            <div className="viewer3d-pandeo-bar">
              <span>
                <AlertTriangle size={14} /> Pandeo en {pandeoAlerts.length} repisa(s) (luz máx.{' '}
                {Math.round(maxSpan)} mm &gt; 850 mm)
              </span>
              {onAddCenterDivider && (
                <button type="button" className="btn-fix-pandeo" onClick={onAddCenterDivider}>
                  + Divisor central
                </button>
              )}
            </div>
          )}
        </div>
      )}

      <Canvas
        shadows
        camera={{
          position: [camDist * 0.72, Math.max(targetY * 1.15, camDist * 0.58), camDist * 1.08],
          fov: 42,
        }}
        onPointerMissed={() => {
          setSelectedPieceId(null);
          onSelectZone?.(null);
        }}
      >
        <color attach="background" args={['#eef2f6']} />
        <ambientLight intensity={0.75} />
        <hemisphereLight args={['#ffffff', '#cbd5e1', 0.6]} />
        <directionalLight position={[4, 7, 5]} intensity={1.1} castShadow />
        <directionalLight position={[-4, 3, -3]} intensity={0.4} />
        <gridHelper args={[6, 24, '#94a3b8', '#cbd5e1']} position={[0, -0.001, 0]} />
        {!blankSketchEmpty && (
          <FurnitureMeshGroup
            despiece={despiece}
            topology={topology}
            params={params}
            support={supportSummary}
            hasToeKickPieces={hasToeKickPieces}
            displayUnit={displayUnit}
            explodeFactor={explodeFactor}
            showDimensions={showDimensions}
            selectedPieceId={selectedPieceId}
            selectedZoneId={selectedZoneId}
            hoveredZoneId={hoveredZoneId}
            onSelectPiece={setSelectedPieceId}
            onSelectZone={onSelectZone}
            onHoverZone={onHoverZone}
            onNudgePiece3D={onUpdateTopology ? handleNudgePiece : undefined}
          />
        )}
        <CameraRig
          preset={camPreset}
          presetTrigger={camTrigger}
          modelKey={modelKey}
          camDist={camDist}
          targetY={targetY}
          furnitureDimsM={[xm, ymTotal, zm]}
        />
      </Canvas>
    </div>
  );
}
