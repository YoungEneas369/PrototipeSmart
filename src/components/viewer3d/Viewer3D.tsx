/**
 * SMARTFURNITURE — VISOR 3D PARAMÉTRICO 100% OFFLINE (v3.1 UX)
 * - Three.js 0.162 + R3F 8.18 + Drei 9.122 (luces nativas, cero Environment/HDRI remoto).
 * - Texturas procedurales `THREE.CanvasTexture` con veta orientada (horizontal vs vertical en laterales).
 * - Controles rápidos de cámara (Isométrica, Frontal, Lateral) y toggle de cotas 3D (auto-ocultas al explotar).
 * - Aviso en vivo de pandeo (> 850 mm) con botón rápido "+ Divisor central".
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentRef } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { Edges, Html, Line, OrbitControls } from '@react-three/drei';
import { AlertTriangle, Eye, EyeOff, RotateCcw, X } from 'lucide-react';
import * as THREE from 'three';
import type {
  BoardPiece,
  DespieceResult,
  FurnitureTopology,
  MelamineMaterial,
  ScaleAndBoardParams,
} from '../../types/contracts';
import { calculateShelfDeflectionDIN, resolveBaseSupport } from '../../core/mathEngine';

interface Viewer3DProps {
  despiece: DespieceResult;
  topology: FurnitureTopology;
  params: ScaleAndBoardParams;
  explodeFactor: number;
  onAddCenterDivider?: () => void;
}

type CameraPreset = 'iso' | 'front' | 'side';

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

function CameraRig({
  preset,
  presetTrigger,
  camDist,
  targetY,
}: {
  preset: CameraPreset;
  presetTrigger: number;
  camDist: number;
  targetY: number;
}) {
  const { camera } = useThree();
  const controlsRef = useRef<ComponentRef<typeof OrbitControls> | null>(null);

  useEffect(() => {
    const pos: [number, number, number] =
      preset === 'front'
        ? [0, targetY, camDist * 1.38]
        : preset === 'side'
          ? [camDist * 1.38, targetY * 1.05, 0.02]
          : [camDist * 0.72, Math.max(targetY * 1.15, camDist * 0.58), camDist * 1.05];

    camera.position.set(pos[0], pos[1], pos[2]);
    if (controlsRef.current) {
      controlsRef.current.target.set(0, targetY, 0);
      controlsRef.current.update();
    } else {
      camera.lookAt(0, targetY, 0);
    }
  }, [camera, preset, presetTrigger, camDist, targetY]);

  return <OrbitControls ref={controlsRef} makeDefault enableDamping dampingFactor={0.08} />;
}

interface MeshGroupProps extends Viewer3DProps {
  showDimensions: boolean;
  selectedPieceId: string | null;
  onSelectPiece: (id: string | null) => void;
}

function FurnitureMeshGroup({
  despiece,
  topology,
  params,
  explodeFactor,
  showDimensions,
  selectedPieceId,
  onSelectPiece,
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
  const support = resolveBaseSupport(topology);
  const hasLegVoidAtBottom = (topology.frontZones ?? []).some(
    (z) => z.kind === 'leg_void' && z.vStart <= 1e-3,
  );
  const legHeightMm = support.type === 'legs' || support.type === 'wheels' ? support.heightMm : 0;
  const toeKickMm =
    support.type === 'toe_kick' && !hasLegVoidAtBottom ? support.heightMm : 0;
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

  const { glassDoorIds, doorHandleSide } = useMemo(() => {
    const glass = new Set<string>();
    const sideMap = new Map<string, 'left' | 'right'>();
    for (const z of topology.frontZones ?? []) {
      if (z.kind === 'door_glass') {
        glass.add(`puerta_${z.id}`);
        sideMap.set(`puerta_${z.id}`, 'right');
      } else if (z.kind === 'door_left') {
        sideMap.set(`puerta_${z.id}`, 'right');
      } else if (z.kind === 'door_right') {
        sideMap.set(`puerta_${z.id}`, 'left');
      } else if (z.kind === 'door_double') {
        sideMap.set(`puerta_${z.id}_izq`, 'right');
        sideMap.set(`puerta_${z.id}_der`, 'left');
      }
    }
    return { glassDoorIds: glass, doorHandleSide: sideMap };
  }, [topology.frontZones]);

  const alertMap = useMemo(() => {
    const map = new Map<string, 'warning' | 'critical'>();
    for (const al of despiece.alerts) {
      map.set(al.piezaId, al.severidad);
    }
    return map;
  }, [despiece.alerts]);

  const cx0 = xf / 2;
  const cy0 = yf / 2;
  const cz0 = zf / 2;
  const explodeDist = explodeFactor * 0.24;

  const piecePosition = (p: BoardPiece): [number, number, number] => {
    const [px, py, pz] = p.posicion3D;
    let dx = px - cx0;
    let dy = py - cy0;
    let dz = pz - cz0;
    const len = Math.hypot(dx, dy, dz);
    if (p.tipo === 'fondo') {
      dx = 0;
      dy = 0;
      dz = -1;
    } else if (len > 1e-4) {
      dx /= len;
      dy /= len;
      dz /= len;
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
  const legInset = Math.min(0.06, xm * 0.12, zm * 0.18);

  const legCoords = useMemo<[number, number][]>(() => {
    const total = Math.max(2, Math.min(12, Math.round(support.count || 4)));
    const frontCount = Math.ceil(total / 2);
    const backCount = Math.max(1, total - frontCount);
    const spanX = Math.max(0.02, xm - 2 * legInset);
    const distributeX = (count: number): number[] => {
      if (count <= 1) return [xm / 2];
      return Array.from({ length: count }, (_, idx) => legInset + (spanX * idx) / (count - 1));
    };
    const coords: [number, number][] = [];
    for (const lx of distributeX(backCount)) coords.push([lx, legInset]);
    for (const lx of distributeX(frontCount)) coords.push([lx, zm - legInset]);
    return coords;
  }, [support.count, xm, zm, legInset]);

  // Geometría 3D procedural de canastos metálicos extraíbles (excluidos de melamina)
  const basketVisuals = useMemo(() => {
    const list: Array<{
      key: string;
      cx: number;
      cy: number;
      cz: number;
      w: number;
      h: number;
      d: number;
      xLeftRail: number;
      xRightRail: number;
    }> = [];
    for (const z of topology.frontZones ?? []) {
      if (z.kind !== 'baskets') continue;
      const nb = Math.max(1, Math.min(6, Math.round(z.basketCount ?? 3)));
      const u0 = Math.min(z.uStart, z.uEnd);
      const u1 = Math.max(z.uStart, z.uEnd);
      const v0 = Math.min(z.vStart, z.vEnd);
      const v1 = Math.max(z.vStart, z.vEnd);
      const x0 = e + u0 * xInt + (u0 > 0.01 ? e / 2 : 0);
      const x1 = e + u1 * xInt - (u1 < 0.99 ? e / 2 : 0);
      const y0 = e + v0 * yInt + (v0 > 0.01 ? e / 2 : 0);
      const y1 = e + v1 * yInt - (v1 < 0.99 ? e / 2 : 0);
      const wIn = x1 - x0;
      const hIn = y1 - y0;
      if (wIn < 80 || hIn < 90) continue;
      const bw = Math.max(60, wIn - 24) / 1000;
      const bd = Math.max(120, zf - 44) / 1000;
      const slotH = hIn / nb;
      const bh = Math.max(70, Math.min(175, slotH * 0.6)) / 1000;
      for (let k = 0; k < nb; k++) {
        const cyMm = y0 + (k + 0.44) * slotH;
        list.push({
          key: `basket_${z.id}_${k}`,
          cx: (x0 + x1) / 2000,
          cy: cyMm / 1000,
          cz: (zf - 12 - (bd * 1000) / 2) / 1000 + explodeDist * 0.65,
          w: bw,
          h: bh,
          d: bd,
          xLeftRail: (x0 + 5) / 1000,
          xRightRail: (x1 - 5) / 1000,
        });
      }
    }
    return list;
  }, [topology.frontZones, e, xInt, yInt, zf, explodeDist]);

  const edgeLineColor = params.material === 'grafito' ? '#94a3b8' : '#334155';
  const renderDims = showDimensions && explodeFactor <= 0.1;

  return (
    <group position={[-xm / 2, 0, -zm / 2]}>
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
                <group key={`ext_wheel_${idx}`} position={[lx, 0, lz]} rotation={[0, swivelAngle, 0]}>
                  {/* Platina superior de montaje */}
                  <mesh position={[0, legOffsetY - plateH / 2, 0]}>
                    <boxGeometry args={[wheelR * 1.7, plateH, wheelR * 1.7]} />
                    <meshStandardMaterial color="#94a3b8" metalness={0.75} roughness={0.3} />
                  </mesh>
                  {/* Horquilla metálica */}
                  <mesh position={[-(wheelW / 2 + 0.0025), legOffsetY - plateH - wheelR * 0.65, 0]}>
                    <boxGeometry args={[0.004, wheelR * 1.3, wheelR * 0.85]} />
                    <meshStandardMaterial color="#64748b" metalness={0.8} roughness={0.28} />
                  </mesh>
                  <mesh position={[wheelW / 2 + 0.0025, legOffsetY - plateH - wheelR * 0.65, 0]}>
                    <boxGeometry args={[0.004, wheelR * 1.3, wheelR * 0.85]} />
                    <meshStandardMaterial color="#64748b" metalness={0.8} roughness={0.28} />
                  </mesh>
                  {/* Rueda giratoria (apoya exactamente en y = 0.000) */}
                  <mesh position={[0, wheelR, 0]} rotation={[0, 0, Math.PI / 2]} castShadow>
                    <cylinderGeometry args={[wheelR, wheelR, wheelW, 20]} />
                    <meshStandardMaterial color="#f1f5f9" roughness={0.4} metalness={0.1} />
                  </mesh>
                  {/* Banda de rodadura / eje */}
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

      {/* Cuerpo de Melamina + Puertas/Cajones + Fondo Durolac 3 mm (correspondencia física 1:1) */}
      <group position={[0, bodyOffsetY, 0]}>
        {despiece.matrizDespiece.map((piece) => {
          const [dx, dy, dz] = piece.dimensiones3D;
          const pos = piecePosition(piece);
          const sev = alertMap.get(piece.id);
          const isBack = piece.tipo === 'fondo' || piece.tipo === 'fondo_cajon';
          const isGlassDoor = glassDoorIds.has(piece.id);
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
          const pieceEdgeColor = melMat === 'grafito' ? '#94a3b8' : edgeLineColor;
          const dxM = dx / 1000;
          const dyM = dy / 1000;
          const dzM = dz / 1000;

          const handleSide = doorHandleSide.get(piece.id);
          const showDoorHandle = piece.tipo === 'puerta' && dxM > 0.14 && dyM > 0.18;
          const showDrawerHandle = piece.tipo === 'frente_cajon' && dxM > 0.14 && dyM > 0.06;
          const doorHandleX =
            handleSide === 'left'
              ? -dxM / 2 + Math.min(0.042, dxM * 0.16)
              : dxM / 2 - Math.min(0.042, dxM * 0.16);

          return (
            <mesh
              key={piece.id}
              position={pos}
              rotation={piece.rotacion3D}
              castShadow={!isGlassDoor}
              receiveShadow
              onClick={(e) => {
                e.stopPropagation();
                onSelectPiece(isSelected ? null : piece.id);
              }}
              onPointerOver={(e) => {
                e.stopPropagation();
                document.body.style.cursor = 'pointer';
              }}
              onPointerOut={() => {
                document.body.style.cursor = 'auto';
              }}
            >
              <boxGeometry args={[dxM, dyM, dzM]} />
              {sev ? (
                <meshStandardMaterial
                  color={sev === 'critical' ? '#ef4444' : '#f59e0b'}
                  emissive={isSelected ? '#0284c7' : '#000000'}
                  emissiveIntensity={isSelected ? 0.35 : 0}
                  roughness={0.45}
                />
              ) : isGlassDoor ? (
                <meshStandardMaterial
                  color="#bae6fd"
                  transparent
                  opacity={0.44}
                  emissive={isSelected ? '#0284c7' : '#000000'}
                  emissiveIntensity={isSelected ? 0.25 : 0}
                  roughness={0.14}
                  metalness={0.15}
                />
              ) : (
                <meshStandardMaterial
                  map={tex}
                  emissive={isSelected ? '#0284c7' : '#000000'}
                  emissiveIntensity={isSelected ? 0.28 : 0}
                  roughness={isBack ? 0.85 : 0.55}
                />
              )}
              <Edges color={isSelected ? '#0284c7' : sev ? '#7f1d1d' : pieceEdgeColor} />

              {showDoorHandle && (
                <mesh position={[doorHandleX, 0, dzM / 2 + 0.008]}>
                  <boxGeometry args={[0.01, Math.min(0.12, dyM * 0.24), 0.012]} />
                  <meshStandardMaterial color="#1e293b" metalness={0.75} roughness={0.28} />
                </mesh>
              )}

              {showDrawerHandle && (
                <mesh position={[0, 0, dzM / 2 + 0.008]}>
                  <boxGeometry args={[Math.min(0.13, dxM * 0.32), 0.01, 0.012]} />
                  <meshStandardMaterial color="#1e293b" metalness={0.75} roughness={0.28} />
                </mesh>
              )}
            </mesh>
          );
        })}

        {/* Canastos metálicos cromados extraíbles (herraje externo no-melamina) */}
        {basketVisuals.map((bk) => {
          const rodR = 0.003;
          const wireOffsets = [-0.36, -0.18, 0, 0.18, 0.36];
          return (
            <group key={bk.key}>
              {/* Rieles laterales */}
              <mesh position={[bk.xLeftRail, bk.cy + bk.h * 0.35, bk.cz]}>
                <boxGeometry args={[0.008, 0.012, bk.d]} />
                <meshStandardMaterial color="#64748b" metalness={0.75} roughness={0.3} />
              </mesh>
              <mesh position={[bk.xRightRail, bk.cy + bk.h * 0.35, bk.cz]}>
                <boxGeometry args={[0.008, 0.012, bk.d]} />
                <meshStandardMaterial color="#64748b" metalness={0.75} roughness={0.3} />
              </mesh>
              <group position={[bk.cx, bk.cy, bk.cz]}>
                {/* Borde superior frontal/trasero/laterales */}
                <mesh position={[0, bk.h / 2, bk.d / 2]}>
                  <boxGeometry args={[bk.w, rodR * 2, rodR * 2]} />
                  <meshStandardMaterial color="#cbd5e1" metalness={0.85} roughness={0.22} />
                </mesh>
                <mesh position={[0, -bk.h / 2, bk.d / 2]}>
                  <boxGeometry args={[bk.w, rodR * 2, rodR * 2]} />
                  <meshStandardMaterial color="#cbd5e1" metalness={0.85} roughness={0.22} />
                </mesh>
                <mesh position={[0, bk.h / 2, -bk.d / 2]}>
                  <boxGeometry args={[bk.w, rodR * 2, rodR * 2]} />
                  <meshStandardMaterial color="#cbd5e1" metalness={0.85} roughness={0.22} />
                </mesh>
                <mesh position={[-bk.w / 2, bk.h / 2, 0]}>
                  <boxGeometry args={[rodR * 2, rodR * 2, bk.d]} />
                  <meshStandardMaterial color="#cbd5e1" metalness={0.85} roughness={0.22} />
                </mesh>
                <mesh position={[bk.w / 2, bk.h / 2, 0]}>
                  <boxGeometry args={[rodR * 2, rodR * 2, bk.d]} />
                  <meshStandardMaterial color="#cbd5e1" metalness={0.85} roughness={0.22} />
                </mesh>
                {/* Base metálica enrejada */}
                <mesh position={[0, -bk.h / 2, 0]}>
                  <boxGeometry args={[bk.w, rodR * 1.4, bk.d]} />
                  <meshStandardMaterial color="#94a3b8" metalness={0.7} roughness={0.32} transparent opacity={0.72} />
                </mesh>
                {/* Varillas verticales frontales */}
                {wireOffsets.map((frac, wi) => (
                  <mesh key={wi} position={[bk.w * frac, 0, bk.d / 2]}>
                    <boxGeometry args={[rodR * 1.6, bk.h, rodR * 1.6]} />
                    <meshStandardMaterial color="#e2e8f0" metalness={0.85} roughness={0.2} />
                  </mesh>
                ))}
                {/* 4 postes esquineros */}
                {([-1, 1] as const).map((sx) =>
                  ([-1, 1] as const).map((sz) => (
                    <mesh key={`${sx}_${sz}`} position={[(sx * bk.w) / 2, 0, (sz * bk.d) / 2]}>
                      <boxGeometry args={[rodR * 2, bk.h, rodR * 2]} />
                      <meshStandardMaterial color="#cbd5e1" metalness={0.85} roughness={0.22} />
                    </mesh>
                  )),
                )}
              </group>
            </group>
          );
        })}

        {/* Cotas 3D dinámicas (ocultas automáticamente al explotar para no chocar con placas) */}
        {renderDims && (
          <>
            <Line
              points={[
                [0, -0.05, zm + 0.06],
                [xm, -0.05, zm + 0.06],
              ]}
              color="#0284c7"
              lineWidth={2}
            />
            <Html position={[xm / 2, -0.09, zm + 0.06]} center>
              <div className="dim-badge">X: {Math.round(xf)} mm</div>
            </Html>

            <Line
              points={[
                [xm + 0.07, 0, zm],
                [xm + 0.07, ym, zm],
              ]}
              color="#059669"
              lineWidth={2}
            />
            <Html position={[xm + 0.14, ym / 2, zm]} center>
              <div className="dim-badge dim-y">
                Y: {Math.round(yf)} mm
                {support.type === 'wheels'
                  ? ` (+${legHeightMm} ruedas)`
                  : support.type === 'legs'
                    ? ` (+${legHeightMm} patas)`
                    : support.type === 'toe_kick'
                      ? ` (+${toeKickMm} zócalo)`
                      : ''}
              </div>
            </Html>

            <Line
              points={[
                [-0.07, ym + 0.03, 0],
                [-0.07, ym + 0.03, zm],
              ]}
              color="#7c3aed"
              lineWidth={2}
            />
            <Html position={[-0.12, ym + 0.07, zm / 2]} center>
              <div className="dim-badge dim-z">Z: {Math.round(zf)} mm</div>
            </Html>
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
  onAddCenterDivider,
}: Viewer3DProps) {
  const [camPreset, setCamPreset] = useState<CameraPreset>('iso');
  const [camTrigger, setCamTrigger] = useState<number>(0);
  const [showDimensions, setShowDimensions] = useState<boolean>(true);
  const [selectedPieceId, setSelectedPieceId] = useState<string | null>(null);

  const selectedPiece = useMemo(
    () => despiece.matrizDespiece.find((p) => p.id === selectedPieceId) ?? null,
    [despiece.matrizDespiece, selectedPieceId],
  );

  const selectedPieceDin = useMemo(() => {
    if (!selectedPiece || selectedPiece.tipo !== 'repisa') return null;
    return calculateShelfDeflectionDIN(
      selectedPiece.ancho,
      selectedPiece.alto,
      selectedPiece.espesor,
      25,
    );
  }, [selectedPiece]);

  const supportSummary = resolveBaseSupport(topology);
  const legExtraMm = supportSummary.heightMm;
  const maxDim =
    Math.max(params.targetDimensions.x, params.targetDimensions.y + legExtraMm, params.targetDimensions.z) /
    1000;
  const camDist = Math.max(1.8, maxDim * 1.65);
  const targetY = (params.targetDimensions.y + legExtraMm) / 2000;

  const pandeoAlerts = despiece.alerts.filter((a) => a.tipo === 'pandeo');
  const maxSpan = pandeoAlerts.reduce((m, a) => Math.max(m, a.luzLibreMm ?? 0), 0);

  const selectView = (next: CameraPreset) => {
    setCamPreset(next);
    setCamTrigger((n) => n + 1);
  };

  return (
    <div className="viewer3d-wrapper">
      <div className="viewer3d-overlay-top">
        <div className="viewer3d-badges">
          <span className="viewer3d-pill">
            Visor 3D Offline · {despiece.matrizDespiece.length} placas
            {!selectedPiece ? ' · Clic en pieza' : ''}
          </span>
          {(supportSummary.type === 'legs' || supportSummary.type === 'wheels') && (
            <span className="badge-legs">
              {supportSummary.type === 'wheels' ? 'Ruedas' : 'Patas'} ({supportSummary.count} × {supportSummary.heightMm} mm) aparte
            </span>
          )}
        </div>

        <div className="viewer3d-cam-bar">
          <button
            type="button"
            className={camPreset === 'iso' ? 'cam-btn active' : 'cam-btn'}
            onClick={() => selectView('iso')}
            title="Vista isométrica 3/4"
          >
            Iso
          </button>
          <button
            type="button"
            className={camPreset === 'front' ? 'cam-btn active' : 'cam-btn'}
            onClick={() => selectView('front')}
            title="Vista frontal XY"
          >
            Frente
          </button>
          <button
            type="button"
            className={camPreset === 'side' ? 'cam-btn active' : 'cam-btn'}
            onClick={() => selectView('side')}
            title="Vista lateral ZY"
          >
            Lateral
          </button>
          <button
            type="button"
            className={showDimensions ? 'cam-btn active' : 'cam-btn'}
            onClick={() => setShowDimensions((v) => !v)}
            title="Mostrar u ocultar cotas 3D"
          >
            {showDimensions ? <Eye size={13} /> : <EyeOff size={13} />} Cotas
          </button>
          <button
            type="button"
            className="cam-btn"
            onClick={() => selectView(camPreset)}
            title="Centrar cámara"
          >
            <RotateCcw size={13} />
          </button>
        </div>
      </div>

      {(selectedPiece || pandeoAlerts.length > 0) && (
        <div className="viewer3d-bottom-stack">
          {selectedPiece && (
            <div className="viewer3d-piece-hud">
              <div className="piece-hud-content">
                <div className="piece-hud-title">
                  <strong>{selectedPiece.nombre}</strong>
                  <span className="piece-hud-tag">{selectedPiece.tipo}</span>
                  <span className="mono">
                    Corte: <strong>{selectedPiece.ancho.toFixed(1)} × {selectedPiece.alto.toFixed(1)} × {selectedPiece.espesor} mm</strong>
                  </span>
                </div>
                <div className="piece-hud-meta mono">
                  <span>
                    Centro ℝ³: ({selectedPiece.posicion3D.map((v) => Math.round(v)).join(', ')}) mm
                  </span>
                  <span>
                    Acabado: {selectedPiece.material}
                  </span>
                  <span>
                    Veta: {selectedPiece.respectGrain ? 'Eje ancho' : 'Libre'}
                  </span>
                  {selectedPieceDin && (
                    <span
                      className={
                        selectedPieceDin.passesDIN ? 'din-pill ok' : 'din-pill bad'
                      }
                    >
                      DIN 68874-1: δ={selectedPieceDin.deflectionMm.toFixed(2)} mm /{' '}
                      {selectedPieceDin.allowableMm.toFixed(2)} mm (máx.{' '}
                      {selectedPieceDin.maxLoadKg.toFixed(1)} kg)
                    </span>
                  )}
                </div>
              </div>
              <button
                type="button"
                className="hud-close-btn"
                onClick={() => setSelectedPieceId(null)}
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
        camera={{ position: [camDist * 0.72, Math.max(targetY * 1.15, camDist * 0.58), camDist * 1.05], fov: 42 }}
        onPointerMissed={() => setSelectedPieceId(null)}
      >
        <color attach="background" args={['#eef2f6']} />
        <ambientLight intensity={0.75} />
        <hemisphereLight args={['#ffffff', '#cbd5e1', 0.6]} />
        <directionalLight position={[4, 7, 5]} intensity={1.1} castShadow />
        <directionalLight position={[-4, 3, -3]} intensity={0.4} />
        <gridHelper args={[6, 24, '#94a3b8', '#cbd5e1']} position={[0, -0.001, 0]} />
        <FurnitureMeshGroup
          despiece={despiece}
          topology={topology}
          params={params}
          explodeFactor={explodeFactor}
          showDimensions={showDimensions}
          selectedPieceId={selectedPieceId}
          onSelectPiece={setSelectedPieceId}
        />
        <CameraRig
          preset={camPreset}
          presetTrigger={camTrigger}
          camDist={camDist}
          targetY={targetY}
        />
      </Canvas>
    </div>
  );
}
