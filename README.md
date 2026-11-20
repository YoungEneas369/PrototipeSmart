# PrototipeSmart: SmartFurniture

Prototipo web **100 % offline** (React + TypeScript + Three.js) para diseñar, escalar, analizar desde fotografía y optimizar el corte de muebles de melamina. Proyecto de **Funciones y Matrices, Unidad 3 (INACAP)**. Entrega: **1 de diciembre de 2026**.

> **Estado (20 nov 2026 — v2.1 Rev. 2):** fase de especificación y validación técnica **cerrada y 100 % sincronizada** entre todos los documentos, prompts por bloque, skills de agente y scripts de evidencia reproducibles. Listo para iniciar el **Bloque 1** de implementación.

## Documentación (empieza por aquí)

| Documento | Para quién | Versión |
|---|---|---|
| [`docs/RESUMEN_PARA_EL_EQUIPO.md`](docs/RESUMEN_PARA_EL_EQUIPO.md) | **Equipo (lectura 5 min).** Plan simple, mejoras de foto → 3D, protocolo de fotos y calendario | v2.1 Rev. 2 |
| [`docs/ANALISIS_TECNICO_v2.1.md`](docs/ANALISIS_TECNICO_v2.1.md) | **Revisión técnica (persona o IA).** Evidencia reproducible, enmiendas de contratos, visión con paralaje + croma y preguntas abiertas | v2.1 Rev. 2 |
| [`pauta.md`](pauta.md) | **Especificación maestra INACAP.** Rúbrica Unidad 3, flujo de 4 pasos, 3 presets oficiales y arquitectura | v2.1 Rev. 2 |
| [`Auditoria y Prompts.txt`](Auditoria%20y%20Prompts.txt) | **Auditoría consolidada + 5 prompts listos para ejecutar** (Bloques 1, 2, Visión, 3 y 4) sin contradicciones | v2.1 Rev. 2 |
| [`docs/evidencia/`](docs/evidencia/) | Scripts reproducibles (`zhang_sim.ts`, `bandDetector.ts` + `band_test.ts`, `guillotine_sim.ts`, `toolchain-spike/`) | Verificados |
| [`.agents/skills/`](.agents/skills/) | 6 skills operativas de Antigravity sincronizadas 1:1 con v2.1 Rev. 2 | v2.1 Rev. 2 |

## Reproducir la evidencia técnica (Node ≥ 22/24)

```bash
node --no-warnings docs/evidencia/zhang_sim.ts
node --no-warnings docs/evidencia/band_test.ts
node --no-warnings docs/evidencia/guillotine_sim.ts
```
