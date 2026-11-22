# 04 — Diagramas de Máquinas de Estados (SmartFurniture v8.0)

> Especificación formal de estados para el orquestador global (`App.tsx`) y el editor interactivo de fotografía (`VectorCanvas` v8.0), garantizando transiciones predecibles y cero secuestros de herramientas.

## Máquina de Estados A — Navegación y Aprobación de `App.tsx`

```mermaid
stateDiagram-v2
    [*] --> Studio : Inicio con Preset 1 (Estantería)

    state "Paso Studio (Foto + 3D en vivo)" as Studio {
        [*] --> IdleStudio
        IdleStudio --> EditingPhoto : Carga foto propia o prueba visión en catálogo
        IdleStudio --> PresetLoaded : Selecciona Preset U3 o Catálogo 14
        EditingPhoto --> Synced3D : Actualiza topology y V0/Vf
        PresetLoaded --> Synced3D : Render inmediato 3D y despiece
        Synced3D --> EditingPhoto : Ajusta trazos o zonas
    }

    state "Paso Blueprint (Plano Vectorial 2D V0 vs Vf)" as Blueprint {
        [*] --> PendingApproval : modelApproved = false
        PendingApproval --> PendingApproval : Edita dimensiones Vf o FrontZones
        PendingApproval --> Approved : Usuario pulsa Aprobar Modelo
        Approved --> PendingApproval : Modifica topología o cotas Vf
    }

    state "Paso Workshop (Taller: Unidad 3, Corte 2D y BOM CLP)" as Workshop {
        [*] --> TabUnidad3
        TabUnidad3 --> TabAlertas : Revisa pandeo DIN 68874-1
        TabAlertas --> TabMatrices : Revisa n x 3 y n x 5
        TabMatrices --> TabHerrajes : Ajusta herrajes y precios CLP
        TabHerrajes --> TabCorte : Inspecciona planchas bicolor y exporta XLS/CSV/SVG
        TabCorte --> TabUnidad3 : Vuelve a fórmulas Unidad 3
    }

    Studio --> Blueprint : Cambia a Plano 2D (activeStep = blueprint)
    Blueprint --> Workshop : Aprueba o pasa a Taller (activeStep = workshop)
    Studio --> Workshop : Acceso directo a Taller (activeStep = workshop)
    Blueprint --> Studio : Regresa a Estudio (activeStep = studio)
    Workshop --> Studio : Regresa a Estudio (activeStep = studio)
    Workshop --> Blueprint : Regresa a Plano 2D (activeStep = blueprint)

    note right of Studio
        Banderas ortogonales en App:
        lockProportion (mantiene lockedRatioXY al escalar X o Y)
        modelApproved (se reinicia a false ante cambios estructurales)
    end note
```

## Máquina de Estados B — `VectorCanvas` v8.0 (3 Pasos Exclusivos + Subherramientas + Undo/Redo)

```mermaid
stateDiagram-v2
    [*] --> NoPhoto : Sin imagen cargada

    NoPhoto --> Step1Frame : Carga foto local, ejemplo o croquis procedural

    state "Paso 1 — frame (Contorno Exterior)" as Step1Frame {
        [*] --> FrameBox : Submodo por defecto (rectángulo rápido)
        FrameBox --> FrameQuad : Activa perspectiva 4 esquinas (H 3x3)
        FrameBox --> Frame4Tap : Activa marcado 4-tap secuencial (TL, TR, BR, BL)
        FrameQuad --> FrameBox : Vuelve a marco recto
        Frame4Tap --> FrameQuad : Completa 4to punto (calcula H y H^-1)

        FrameBox --> DraggingFrame : PointerDown en esquina, borde o interior
        FrameQuad --> DraggingFrame : PointerDown en esquina, borde o marco
        DraggingFrame --> FrameQuad : PointerUp (commit en UndoStack)
        DraggingFrame --> FrameBox : PointerUp (commit en UndoStack)
    }

    state "Paso 2 — lines (Trazado Interno H/V/Diagonal)" as Step2Lines {
        [*] --> SelectMove : Seleccionar, mover segmento o editar extremos
        SelectMove --> DrawOrtho : Activa trazo H/V (auto-orienta + snap T-junctions)
        SelectMove --> DrawDiagonal : Activa trazo diagonal (dEdge / inglete)
        DrawOrtho --> SelectMove : PointerUp (vectoriza, cotas mm, commit UndoStack)
        DrawDiagonal --> SelectMove : PointerUp (crea DiagonalSegment, commit UndoStack)
        SelectMove --> AutoSuggesting : Pulsa Sugerir líneas auto
        AutoSuggesting --> SelectMove : Aplica candidatos y commit UndoStack
    }

    state "Paso 3 — zones (Clasificación de Zonas)" as Step3Zones {
        [*] --> ZoneInspector : Selecciona celda (hover sincronizado con 3D)
        ZoneInspector --> ZoneInspector : Cambia kind, cajones, canastos o material bicolor
        ZoneInspector --> MergingZones : Selecciona celda adyacente para fusionar (merge)
        ZoneInspector --> SplittingZone : Divide celda en subzonas (split)
        MergingZones --> ZoneInspector : Commit UndoStack
        SplittingZone --> ZoneInspector : Commit UndoStack
    }

    state "Subherramientas Temporales (No secuestran el paso activo)" as SubTools {
        state "calibA4 (Calibración A4 297 mm o 1 Medida)" as CalibA4
        state "eyedropper (Gotero 1 clic color melamina)" as Eyedropper
    }

    Step1Frame --> Step2Lines : Siguiente paso (contorno válido)
    Step2Lines --> Step3Zones : Siguiente paso (partición planar lista)
    Step3Zones --> Step2Lines : Volver a ajustar líneas
    Step2Lines --> Step1Frame : Volver a ajustar contorno
    Step3Zones --> Step1Frame : Volver a contorno

    Step1Frame --> CalibA4 : Activa calibración métrica
    Step2Lines --> CalibA4 : Activa calibración métrica
    Step3Zones --> CalibA4 : Activa calibración métrica
    CalibA4 --> Step1Frame : Completa o cancela (retorna al paso origen)

    Step1Frame --> Eyedropper : Activa gotero 1 clic
    Step2Lines --> Eyedropper : Activa gotero 1 clic
    Step3Zones --> Eyedropper : Activa gotero 1 clic
    Eyedropper --> Step2Lines : Muestrea píxel o cancela (retorna al paso origen)

    note right of Step2Lines
        Pila Undo / Redo activa en los 3 pasos:
        Ctrl+Z / Ctrl+Y restaura snapshot inmutable de
        (quadCorners, vDividers, hShelves, diagonalDividers, frontZones)
    end note
```

## Invariantes de Interacción v8.0

1. **Exclusividad de Paso:** En todo instante el usuario opera exactamente en uno de los 3 pasos (`frame`, `lines` o `zones`), evitando interacciones accidentales (por ejemplo, arrastrar una esquina del marco mientras intenta seleccionar una puerta en `zones`).
2. **Retorno Limpio de Subherramientas:** Activar `calibA4` o `eyedropper` memoriza el paso previo y, al finalizar el clic/trazo o pulsar `Escape`, devuelve el control automáticamente al paso anterior sin dejar la herramienta bloqueada.
3. **Historial Unificado (`Undo/Redo`):** Toda mutación confirmada (al soltar el puntero en drag, completar un trazo, ejecutar auto-sugerencia, fusionar/dividir zonas o cambiar tipo/color) inserta exactamente un estado en la pila `Undo` y limpia `Redo`.
