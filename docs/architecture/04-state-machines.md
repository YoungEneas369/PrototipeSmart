# 04 — Diagramas de Máquinas de Estados (SmartFurniture v8.0)

> Especificación formal de estados para el orquestador global (`App.tsx`) y el editor interactivo de fotografía (`VectorCanvas` v8.0), reflejando la UX simplificada con revelación progresiva, cero secuestros de herramientas y cero duplicación de controles.

## Máquina de Estados A — Navegación, Modos de Estudio y Aprobación de `App.tsx`

```mermaid
stateDiagram-v2
    [*] --> Studio : Inicio en activeView = studio (Preset 1 Estantería)

    state "Vista Studio (activeView = studio)" as Studio {
        [*] --> SplitMode : studioMode = split (Foto + 3D en vivo)
        SplitMode --> PhotoMode : Cambia a studioMode = photo (Solo Foto)
        SplitMode --> ThreeDMode : Cambia a studioMode = 3d (Solo 3D)
        PhotoMode --> SplitMode : Cambia a studioMode = split
        PhotoMode --> ThreeDMode : Cambia a studioMode = 3d
        ThreeDMode --> SplitMode : Cambia a studioMode = split
        ThreeDMode --> PhotoMode : Cambia a studioMode = photo

        SplitMode --> SplitMode : Selector Presets U3, Presets L o Catálogo 14, Forma Recto/L Der/L Izq o VectorCanvas
        ThreeDMode --> ThreeDMode : Control Explotar en Viewer3D, hover 2D-3D ambas alas y edición directa 3D (flechas ±20 mm, HUD módulos/acabados/curva L)
    }

    state "Vista Blueprint (activeView = blueprint · Plano 2D V0 vs Vf)" as Blueprint {
        [*] --> PendingApproval : modelApproved = false
        PendingApproval --> PendingApproval : Edita Vf / Ala L y zonas FrontZones A/B (ZoneInspector)
        PendingApproval --> Approved : Usuario pulsa Aprobar Modelo (opcional)
        Approved --> PendingApproval : Modifica topología o cotas Vf
    }

    state "Vista Workshop (activeView = workshop · Taller Offline)" as Workshop {
        [*] --> TabUnidad3
        TabUnidad3 --> TabAlertas : Revisa pandeo DIN 68874-1
        TabAlertas --> TabMatrices : Revisa n x 3 y n x 5
        TabMatrices --> TabHerrajes : Ajusta herrajes y precios CLP
        TabHerrajes --> TabCorte : Inspecciona planchas bicolor y exporta XLS/CSV/SVG
        TabCorte --> TabUnidad3 : Vuelve a fórmulas Unidad 3
        TabUnidad3 --> TabUnidad3 : Alterna vista 3D lateral opcional (showWorkshop3D)
    }

    Studio --> Blueprint : Cambia a Plano 2D (activeView = blueprint)
    Studio --> Workshop : Acceso directo a Taller sin bloqueo (activeView = workshop)
    Blueprint --> Workshop : Pasa a Taller con o sin aprobación (activeView = workshop)
    Blueprint --> Studio : Regresa a Estudio (activeView = studio)
    Workshop --> Studio : Regresa a Estudio (activeView = studio)
    Workshop --> Blueprint : Regresa a Plano 2D (activeView = blueprint)

    note right of Studio
        Controles ortogonales en App:
        - Selector unificado Presets U3 y Catálogo 14 (preset:* / catalog:*)
        - Sidebar progresivo con 3 desplegables colapsados por defecto:
          Repisas y estructura · Tableros, Fondo y Bicolor · Taller y Sierra
        - Control Explotar (explodeFactor) integrado en Viewer3D
        - lockProportion, selectedZoneId, hoveredZoneId y modelApproved
    end note
```

## Máquina de Estados B — `VectorCanvas` v8.0 (3 Vistas Ortogonales, Dibujo Libre con Curvas Diferenciales y Undo/Redo)

```mermaid
stateDiagram-v2
    [*] --> NoPhoto : Sin vista frontal cargada (selector de 3 vistas siempre accesible)

    NoPhoto --> Step1Frame : Sube foto o boceto en papel (Frente XY, Arriba XZ o Lado ZY, frontZones = [])
    NoPhoto --> BlankOpenSketch : Pulsa Dibujar en lienzo libre (3 vistas XY/XZ/ZY limpias, blankSketchHasStructure = false)

    state "Boceto Libre Abierto (frontIsBlankSketch = true, blankSketchHasStructure = false)" as BlankOpenSketch {
        [*] --> OpenLines : Lienzo blanco cuadriculado sin marco impuesto, sin traced_zone_1 y sin sólido fantasma en Viewer3D (0 piezas)
        OpenLines --> OpenLines : Traza rectas/curvas abiertas (frontZones = [], hasBackPanel = false, sin sobrescribir trazos)
    }
    BlankOpenSketch --> Step2Lines : Cierra contorno (detectDrawnClosedStructure rect/stepped/curved_top) -> blankSketchHasStructure = true
    BlankOpenSketch --> Step1Frame : Usuario activa Paso 1 Contorno explícito -> blankSketchHasStructure = true

    state "Vista Activa (viewTab: frontal XY | superior XZ | lateral ZY)" as ViewTabs {
        state "frontal (Alzado XY · líneas, diagonales, curvas top/arco)" as TabFront
        state "superior (Planta XZ · Fondo Z=0 arriba, Frente +Z abajo, XLINEs XY y chaflanes/L)" as TabTop
        state "lateral (Perfil ZY · Fondo Z=0 izq, Frente +Z der, XLINEs XY/XZ y perfil lateral)" as TabSide
        TabFront --> TabTop : Pestaña 2. Arriba (XZ) resetea traceStep = lines si estaba en zones
        TabTop --> TabSide : Pestaña 3. Lado (ZY)
        TabSide --> TabFront : Pestaña 1. Frente (XY)
    }

    state "Paso 1 — frame (Contorno Exterior · Inicia en quad)" as Step1Frame {
        [*] --> FrameQuad : Submodo por defecto (4 esquinas + handles de borde ampliados)
        FrameQuad --> FrameBox : Activa marco recto en menú plegado Opciones
        FrameQuad --> Frame4Tap : Activa marcado guiado 4-tap (TL, TR, BR, BL)
        FrameBox --> FrameQuad : Vuelve a perspectiva 4 esquinas
        Frame4Tap --> FrameQuad : Completa 4to punto (calcula H y sincroniza Alto Y)

        FrameQuad --> DraggingFrame : PointerDown en esquina, borde ampliado o interior
        FrameBox --> DraggingFrame : PointerDown en esquina, borde o interior
        DraggingFrame --> FrameQuad : PointerUp (commit UndoStack + sincroniza Alto Y 3D / XZ)
        DraggingFrame --> FrameBox : PointerUp (commit UndoStack + sincroniza Alto Y 3D / XZ)
    }

    state "Paso 2 — lines (Trazado en Vivo + Curvas Diferenciales Bézier)" as Step2Lines {
        [*] --> DrawConnect : linesSubMode = draw_only (Dibujar · libre) o smart (Mover / Editar líneas y nodos Bézier)
        DrawConnect --> DrawStroke : Arrastra en XY, XZ o ZY (Lupa 4x + cuadrícula 0-based en los 3 planos, Space+Drag sobre activeBmp)
        DrawConnect --> DragSegment : En Mover/Editar arrastra línea, extremo o nodo Bézier P0..P3 en XY/XZ/ZY
        DrawStroke --> DrawConnect : PointerUp (vectorizeUserStroke / fitDifferentialCurveFromStroke / planeLinesXZ / planeLinesZY + UndoStack)
        DragSegment --> DrawConnect : PointerUp (actualiza segmento/curva + synthesize3DFromTriViews + UndoStack)
        DrawConnect --> AutoSuggesting : Pulsa Sugerir líneas o Reconocer boceto (sketchRecognizer + photoPipeline)
        AutoSuggesting --> DrawConnect : Aplica candidatos, curvas e inferencia L + commit UndoStack
        DrawConnect --> ReasonableNorm : Pulsa Medidas razonables (simetría, colinealidad, alas L iguales, 10 mm)
        ReasonableNorm --> DrawConnect : Commit UndoStack con cotas y topología normalizadas
        DrawConnect --> AdvancedModes : Abre menú plegado Opciones (Secciones auto, Auto/Recta/Diagonal/Curva, Imán OFF)
        AdvancedModes --> DrawConnect : Vuelve a modo Dibujar o Mover / Editar
    }

    state "Paso 3 — zones (ZoneInspector Simplificado con Revelación Progresiva)" as Step3Zones {
        [*] --> ZoneInspector : Selecciona celda (hover sincronizado 2D-3D)
        ZoneInspector --> ZoneInspector : Cambia kind (9 tipos), cajones/canastos, color bicolor o acciones +2 col / +2 filas / Unir
        ZoneInspector --> ZoneAdvanced : Despliega Ajustes avanzados de esta parte (mm exactos, repisas internas, 3-5 divisiones, etiqueta)
        ZoneAdvanced --> ZoneInspector : Commit UndoStack
    }

    state "Subherramientas Exclusivas en Barra 2 (CalibrationBar oculto para cero duplicados)" as SubTools {
        state "calibA4 (Hoja A4 297 mm en Barra 2)" as CalibA4
        state "eyedropper (Gotero 1 clic color melamina)" as Eyedropper
        state "viewTab = lateral (Vista Lateral ZY desde Avanzado)" as LateralZY
    }

    Step1Frame --> Step2Lines : Siguiente paso (contorno válido, sin mostrar frontZones)
    Step2Lines --> Step3Zones : Siguiente paso (solo si !isBlankSketch || blankSketchHasStructure y con partición lista)
    Step3Zones --> Step2Lines : Volver a Líneas (oculta frontZones y ZoneInspector de inmediato)
    Step2Lines --> Step1Frame : Volver a Contorno (permanece en viewTab activo para XZ/ZY)
    Step3Zones --> Step1Frame : Volver a Contorno (oculta frontZones y ZoneInspector de inmediato)

    Step1Frame --> CalibA4 : Activa calibración A4 desde CalibrationBar
    Step2Lines --> CalibA4 : Activa calibración A4 desde CalibrationBar
    Step3Zones --> CalibA4 : Activa calibración A4 desde CalibrationBar
    CalibA4 --> Step1Frame : Aplica escala o cancela (retorna al paso origen)

    Step1Frame --> Eyedropper : Activa gotero 1 clic
    Step2Lines --> Eyedropper : Activa gotero 1 clic (en Opciones)
    Step3Zones --> Eyedropper : Activa Color (Gotero)
    Eyedropper --> Step2Lines : Muestrea píxel o cancela (retorna al paso origen)

    Step1Frame --> LateralZY : Abre Vista Lateral ZY (Avanzado en CalibrationBar)
    Step2Lines --> LateralZY : Abre Vista Lateral ZY (Avanzado en CalibrationBar)
    LateralZY --> Step1Frame : Vuelve a Vista Frontal XY (synthesize3DFromTriViews actualiza Z y topología)

    note right of Step2Lines
        Pila Undo / Redo (Deshacer y Rehacer Ctrl+Z / Ctrl+Y) activa en las 3 vistas (XY, XZ, ZY), 4 toques y los 3 pasos:
        Restaura snapshot inmutable de
        (quad, topQuad, sideQuad, vDividers, hShelves, diagonalDividers,
        planeLinesXZ, planeLinesZY, blankSketchHasStructure, curvedCuts, lShape, frontZones,
        cubiertaMaterialOverride, shelfMode, equalShelfCount y dims)
    end note
```

## Invariantes de Interacción v8.0

1. **Lienzo Limpio sin Barras Innecesarias, 3 Vistas Coherentes y Estado Vacío Real:** Al iniciar `"Dibujar en lienzo libre (3 vistas)"`, se crean los 3 lienzos ortogonales (`XY`, `XZ`, `ZY`) alineados sin marco sólido impuesto, sin sombreado fuera del marco, sin `traced_zone_1`, sin `hasBackPanel: true` y con `Viewer3D` en estado de espera (`0 piezas`, sin mueble fantasma) hasta detectar un contorno cerrado (`detectDrawnClosedStructure`) o confirmar `1. Contorno`.
2. **Separación Estricta de Partes (`3. Partes`) vs Dibujo (`1. Contorno` / `2. Líneas`):** `frontZones` y `ZoneInspector` solo se muestran cuando `traceStep === 'zones' && viewTab === 'frontal' && hasPhoto && (!isBlankSketch || blankSketchHasStructure)`. Al cambiar a `Arriba (XZ)` o `Lado (ZY)`, cualquier estado `'zones'` se normaliza automáticamente a `'lines'`, y `BARRA 1` conserva la pestaña activa al alternar `1. Contorno` / `2. Líneas`.
3. **Coherencia Ortogonal (`XLINE`), Cuadrícula `0-based` y Curvas Diferenciales en 3 Planos:** `Arriba (XZ)` ubica Fondo (`Z = 0`) arriba y Frente (`Z = +D`) abajo compartiendo `X` con `XY`; `Lado (ZY)` ubica Fondo (`Z = 0`) a la izquierda y Frente (`Z = +D`) a la derecha compartiendo `Y` con `XY`. La cuadrícula milimetrada es `0-based` exterior `[0..xf]×[0..yf]` sin desfase de `18 mm`, las proyecciones `XLINE` reflejan divisores/repisas/profundidad entre planos, `Lupa 4×` y `Space + Arrastrar` operan en los 3 planos, `planeLinesXZ`/`planeLinesZY` y curvas `zy` recortan piezas 3D reales en `differentialCurve.ts`/`Viewer3D`, y los nodos Bézier `P0..P3` son seleccionables y editables en `2D` y `LineSelectionBar`.
4. **Historial Unificado (`Undo/Redo` en XY/XZ/ZY + 4 Toques):** Toda mutación confirmada (contorno, líneas en `Frente`/`Arriba`/`Lado`, curvas, zonas, `blankSketchHasStructure` y toques de esquina) guarda estado reversible con `Deshacer` (`Ctrl+Z`) y `Rehacer` (`Ctrl+Y`).
