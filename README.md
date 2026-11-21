# PrototipeSmart: SmartFurniture v3.1

Prototipo web **100 % offline** (React + TypeScript + Three.js) para analizar fotografías de muebles, escalarlos paramétricamente en 3D, demostrar la matemática de **Funciones y Matrices — Unidad 3 (INACAP)** y optimizar el corte de planchas de melamina (Guillotina 2 etapas / MaxRects) con exportación **Excel `.xls` (3 hojas)**, **CSV Chile (`;`)** y **SVG**.

> **Demo web en vivo (GitHub Pages):** https://youngeneas369.github.io/PrototipeSmart/  
> *(Una vez cargada la página, toda la matemática, visión computacional, render 3D y exportación funcionan 100 % en el navegador sin peticiones externas ni backend).*

## Stack fijado (verificado offline)

- React `18.3.1` · TypeScript `~5.8.3` · Vite `6.3.5` · Vitest `3.2.4`
- Three.js `0.162.0` · `@react-three/fiber 8.18.0` · `@react-three/drei 9.122.0` · `lucide-react`

## Ejecución y pruebas locales

```bash
# Instalar dependencias (solo primera vez)
npm ci

# Ejecutar toda la suite de pruebas (Bloques 1 + 2 + Visión)
npx vitest run
# En Termux (Android):
node node_modules/vitest/vitest.mjs run

# Compilación estricta TypeScript + build de producción
npx tsc -b && npx vite build
# En Termux (Android):
node node_modules/typescript/bin/tsc -b && node node_modules/vite/bin/vite.js build

# Iniciar servidor local (o doble clic en INICIAR_SMARTFURNITURE.bat en Windows)
npm run dev
```

## Documentación y Evidencia

| Documento | Contenido |
|---|---|
| [`pauta.md`](pauta.md) | Especificación maestra INACAP (Unidad 3, 4 pasos, 3 presets) |
| [`docs/RESUMEN_PARA_EL_EQUIPO.md`](docs/RESUMEN_PARA_EL_EQUIPO.md) | Resumen ejecutivo, protocolo de fotos y guion del video |
| [`docs/ANALISIS_TECNICO_v2.1.md`](docs/ANALISIS_TECNICO_v2.1.md) | Análisis técnico pre-implementación con evidencia reproducible |
| [`docs/AUDITORIA_Y_PROMPTS_BLINDADOS_v3.0_EQUIPO.md`](docs/AUDITORIA_Y_PROMPTS_BLINDADOS_v3.0_EQUIPO.md) | Auditoría v3.0 y prompts blindados del equipo |
| [`docs/evidencia/`](docs/evidencia/) | Scripts reproducibles (`zhang_sim.ts`, `bandDetector.ts`, `guillotine_sim.ts`, `toolchain-spike/`) |
| [`.agents/skills/`](.agents/skills/) | 6 skills operativas de Antigravity |
