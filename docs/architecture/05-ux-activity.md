# 05 — Diagrama de Actividad del Flujo UX Dual (SmartFurniture v8.0)

> Describe las dos entradas complementarias de **SmartFurniture v8.0** —la ruta académica/QA instantánea (Rama A) y la ruta de digitalización desde fotografía propia (Rama B)— y su convergencia hacia el escalamiento paramétrico, la validación 2D/3D y la exportación 100 % offline.

```mermaid
flowchart TD
    START(["Inicio en navegador o PWA Offline"]) --> CHOICE{"Origen del mueble"}

    subgraph RAMA_A["Rama A — Presets Oficiales Unidad 3 y Catálogo QA (14 Fotos)"]
        A1["Elegir Preset Oficial (Estantería, Rack TV o Clóset) o Mueble del Catálogo 14"]
        A2["Cargar topología verificada (detectionSource = preset)"]
        A3{"Desea probar motor de visión real sobre la foto del catálogo?"}
        A4["Abrir foto en VectorCanvas y ejecutar Auto-sugerir o trazado real"]
        A1 --> A2 --> A3
        A3 -- "Sí (Benchmark / Demo)" --> A4
    end

    subgraph RAMA_B["Rama B — Foto Propia del Usuario"]
        B1["Subir foto local (Protocolo: centrada, >= 3 m, zoom 1x-2x, sin recortar)"]
        B2["Paso 1 frame: Marcar contorno 4 pts (TL, TR, BR, BL) o marco recto con lupa 4x e imán Sobel"]
        B3["Calcular homografía H 3x3 (Hartley) y rectificar imagen RGBA"]
        B4["Calibrar escala real: confirmar 1 medida conocida (ancho o alto) o Hoja A4 (297 mm)"]
        B5["Paso 2 lines: Trazar divisores/repisas/diagonales con snap o pulsar Auto-sugerir (CIE-Lab + XY-Cut)"]
        B6{"Confianza de detección >= 0.50?"}
        B7["Ajuste fino opcional con drag de extremos y Undo/Redo"]
        B8["Aviso explícito de baja confianza: completar líneas manualmente en segundos"]
        B9["Paso 3 zones: Clasificar módulos en Inspector (Abierto, Puerta, Vidrio, Cajones, Canastos, Piernas, Recorte exterior) y acabado bicolor"]
        B1 --> B2 --> B3 --> B4 --> B5 --> B6
        B6 -- "Sí" --> B7 --> B9
        B6 -- "No" --> B8 --> B9
    end

    CHOICE -- "Rama A: Demo rápida / Unidad 3 / QA" --> A1
    CHOICE -- "Rama B: Foto real propia" --> B1

    A3 -- "No (Ir directo a parametrización)" --> CONV
    A4 --> CONV
    B9 --> CONV

    subgraph CONVERGENCIA["Fase Común — Parametrización, Validación y Taller Offline"]
        CONV["Ajustar medidas objetivo Vf (mm), espesor e (18 mm), unión, apoyo (patas/ruedas/zócalo) y formato plancha (2440x1220 o Chile)"]
        REV["Revisar sincronizado: Visor 3D interactivo (hover 2D<->3D, vista explotada) + Plano Vectorial 2D (V0 vs Vf)"]
        ALERT{"Alerta estructural DIN 68874-1 o pandeo > 850 mm?"}
        FIX["Agregar divisor vertical o ajustar vano en vivo hasta 0 alertas"]
        APPROVE["Aprobar modelo redimensionado (modelApproved = true)"]
        WORKSHOP["Abrir Taller: Fórmulas Unidad 3 + Matrices n x 3 / n x 5 + Plano de Corte 2D Bicolor + Presupuesto CLP editable"]
        EXPORT["Exportar 100 % offline: Excel .xls (3 hojas), CSV Chile (; + BOM UTF-8) y Planos SVG"]

        CONV --> REV --> ALERT
        ALERT -- "Sí" --> FIX --> REV
        ALERT -- "No" --> APPROVE --> WORKSHOP --> EXPORT
    end

    EXPORT --> ENDNODE(["Fin: Proyecto listo para corte en taller y entrega INACAP"])
```

## Claves de Usabilidad del Flujo Dual

- **Transparencia en Rama A:** Los 14 muebles del catálogo de prueba cargan con `detectionSource: 'preset'` para demostrar el abanico completo de tipologías (puertas, vidrio, cajones, canastos, ruedas, escritorios, bicolor, recortes escalonados) y permiten lanzar en cualquier momento una corrida real del motor de visión sobre la foto subyacente.
- **Ruta Garantizada en Rama B:** Aunque una foto presente bajo contraste (ej. mueble blanco frente a muro blanco), la detección automática actúa como asistente con índice de confianza explícito (`< 0.50`) y el trazado guiado en 3 pasos (`frame` -> `lines` -> `zones`) garantiza siempre llegar al modelo 3D y al despiece milimétrico sin bloqueos.
- **Aislamiento de Costos y Herrajes:** Tanto en Rama A como en Rama B, patas, ruedas, tiradores, bisagras, correderas y canastos se gestionan en `hardwareSummary` y en el estimador CLP sin alterar nunca las cotas de melamina ni contaminar las planchas de corte.
