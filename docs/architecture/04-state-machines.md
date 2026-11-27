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

    NoPhoto --> Step1Frame : Sube foto o boceto en papel (Frente XY, Arriba XZ o Lado ZY)
    NoPhoto --> Step2Lines : Pulsa Dibujar en lienzo libre (createBlankSketchBitmap con cuadrícula)

    state "Vista Activa (viewTab: frontal XY | superior XZ | lateral ZY)" as ViewTabs {
        state "frontal (Alzado XY · líneas, diagonales, curvas top/arco)" as TabFront
        state "superior (Planta XZ · L derecha/izquierda y empalme curvo L)" as TabTop
        state "lateral (Perfil ZY · calibración profundidad Z)" as TabSide
        TabFront --> TabTop : Pestaña 2. Arriba (XZ)
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
        [*] --> DrawConnect : linesSubMode = draw_only (Dibujar · libre desde cualquier esquina) o smart (Mover / Editar)
        DrawConnect --> DrawStroke : Arrastra desde esquina, punta existente o vacío (snap 12 px sin salto de soltar)
        DrawConnect --> DragSegment : En Mover/Editar arrastra cuerpo (o extremo de línea ya seleccionada)
        DrawStroke --> DrawConnect : PointerUp (vectorizeUserStroke exactStartPos / fitDifferentialCurveFromStroke + UndoStack)
        DragSegment --> DrawConnect : PointerUp (actualiza segmento, commit UndoStack)
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

    Step1Frame --> Step2Lines : Siguiente paso (contorno válido)
    Step2Lines --> Step3Zones : Siguiente paso (partición planar lista)
    Step3Zones --> Step2Lines : Volver a Líneas
    Step2Lines --> Step1Frame : Volver a Contorno
    Step3Zones --> Step1Frame : Volver a Contorno

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
    LateralZY --> Step1Frame : Vuelve a Vista Frontal XY (estima profundidad Z)

    note right of Step2Lines
        Pila Undo / Redo activa en las 3 vistas y los 3 pasos (Ctrl+Z / Ctrl+Y):
        Restaura snapshot inmutable de
        (quad, vDividers, hShelves, diagonalDividers, curvedCuts, lShape,
        frontZones, cubiertaMaterialOverride, shelfMode, equalShelfCount y dims)
    end note
```

## Invariantes de Interacción v8.0

1. **Lienzo Limpio sin Barras Innecesarias + Barra Superior de 3 Vistas:** Sin vista cargada en `frontal`, solo se muestran las pestañas `1. Frente (XY)`, `2. Arriba (XZ)`, `3. Lado (ZY)`, `"Medidas razonables"` y el acceso directo `"Dibujar en lienzo libre"`.
2. **Sincronización Automática 3-Vistas y Cálculo Diferencial:** Ajustar `quad` (XY), `topQuad` (XZ) o `sideQuad` (ZY) ejecuta `synthesize3DFromTriViews`, sincronizando proporción `Alto Y`, profundidad `Z`, topología en L y curvas Bézier (`s = ∫ds`, `κ = 1/R`) en tiempo real.
3. **Revelación Progresiva y Cero Duplicación:** En Paso 2 (`lines`), la barra visible inicia en `Dibujar` (`draw_only`) junto al selector explícito `Línea recta | Curva` y el botón `Milimetrado` (cuadrícula proyectiva + ajuste a múltiplos de `10 mm`/`50 mm`), manteniendo `Mover / Editar` separado para que ninguna línea previa secuestre al trazar en una esquina (tanto esquinas azules del marco exterior como vértices internos); en `Arriba XZ` y `Lado ZY` la barra separa `Dibujar` de `Marco` e incluye `Línea recta | Curva`.
4. **Historial Unificado (`Undo/Redo`):** Toda mutación confirmada guarda un snapshot inmutable completo que incluye `dims`, `cubiertaMaterialOverride`, `curvedCuts` y `lShape`.
