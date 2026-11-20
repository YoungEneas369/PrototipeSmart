# SmartFurniture — Especificación Técnica y Plan de Ejecución (v2.0 Auditada)

> Documento maestro de alineación interna del equipo y especificación modular lista para implementación en Antigravity.  
> **Nota de revisión (v2.0):** Este archivo reemplaza la exportación OCR corrupta del PDF original ([Especificación Técnica.pdf](file:///D:/Escritorio/OneDrive%20-%20INACAP/Escritorio/Nueva%20carpeta%20(6)/Especificación%20Técnica.pdf)), restaura todos los textos truncados e incorpora las correcciones matemáticas, geométricas y de arquitectura de la auditoría técnica ([Auditoria y Prompts.txt](file:///D:/Escritorio/OneDrive%20-%20INACAP/Escritorio/Nueva%20carpeta%20(6)/Auditoria%20y%20Prompts.txt)).

---

## 1. Encabezado y Ficha del Proyecto

El presente documento establece la arquitectura del sistema, la formulación matemática corregida y el plan de implementación guiado para el prototipo interactivo de **SmartFurniture**. Este instrumento servirá como guía de desarrollo modular y referencia técnica compartida para la revisión, validación y posterior grabación del video explicativo.

| Campo | Detalle Operativo |
|---|---|
| **Proyecto** | SmartFurniture (Diseño, escalamiento y optimización de cortes para muebles en melamina) |
| **Asignatura / Unidad** | Funciones y Matrices — Unidad 3 (Sucesiones, Sumatorias, Vectores y Matrices), INACAP |
| **Docente** | Marco Antonio Troncoso Soto |
| **Integrantes** | Fernando A. Durán Leiva · Cristopher D. Figueroa Arthur · Francisco A. Lara Yevenes · Génesis T. Sepúlveda Muñoz |
| **Entregable Etapa 3** | Prototipo web local + Video explicativo de funcionamiento y respaldo matemático |
| **Fecha Límite Objetivo** | 1 de diciembre de 2026 (Prototipo listo: 28 nov · Grabación y edición de video: 29–30 nov) |
| **Restricción Clave (Etapa 2)** | Ejecución **100% local en navegador**, sin APIs, CDNs de fuentes/HDRI ni motores externos en tiempo de ejecución. |

---

## 2. Visión Concreta del Prototipo Web

El prototipo se construirá como una Web App de ejecución **100% cliente** (Single Page Application) utilizando **React, TypeScript y Vite**. La renderización tridimensional y la manipulación espacial de las piezas se realizarán mediante **Three.js** a través de **React Three Fiber** y **@react-three/drei**, empleando iluminación local y texturas procedurales (`THREE.CanvasTexture`) para garantizar operación completamente offline.

Todo el procesamiento vectorial, la rectificación de perspectiva mediante homografía matricial $3 \times 3$, las transformaciones matriciales, las progresiones de repisas y el algoritmo de empaquetado 2D (Cutting Stock) se ejecutarán directamente en el navegador. Esta decisión elimina dependencias de backend, costos de API y problemas de compatibilidad de entornos entre los equipos del grupo de trabajo, garantizando el cumplimiento irrestricto de la autonomía computacional declarada en la Etapa 2.

El núcleo del sistema se basa en un **motor paramétrico unificado de paneles rectangulares de melamina**. Para el software, cualquier estructura de mueble recto (libreros, racks de TV, veladores, módulos de cocina o clósets) responde a una misma abstracción matemática: un volumen delimitado por una caja exterior, divisiones internas (verticales y horizontales, con soporte de vanos mixtos) y un fondo opcional de 3 mm.

---

## 3. Flujo Funcional del Usuario (Paso a Paso)

El flujo de uso dentro de la aplicación consta de 4 pasos secuenciales, diseñados para estructurar la demostración práctica en el video final (manteniendo además acceso directo a 3 Presets de demostración):

### Paso 1 — Carga de referencia (1 o 2 vistas)
- **Vista Frontal (Obligatoria, plano XY):** Carga local (`FileReader` / `URL.createObjectURL`) de una imagen o croquis de frente del mueble objetivo para extraer la topología y relaciones de proporción entre divisiones. Incluye un generador local de croquis de muestra para pruebas rápidas sin archivos externos.
- **Vista Lateral (Opcional, plano ZY):** Carga de una fotografía lateral con marco interactivo para calcular la relación real Profundidad/Alto ($z_f / y_f$) compartiendo el eje vertical $Y$. Esto elimina las distorsiones métricas introducidas por el escorzo proyectivo de fotografías en perspectiva o anguladas.
- **Selector de Fondo:** Interruptor simple (*¿Incluye fondo de Durolac/MDF de 3 mm? Sí / No*) que añade el panel posterior a la matriz de despiece extendida ($n \times 5$) sin requerir capturas fotográficas traseras.

### Paso 2 — Vectores de estructura sobre la imagen
- **Rectificación de contorno (4 nodos + Homografía $3 \times 3$):** El usuario posiciona interactivamente 4 nodos del contorno exterior en orden horario (`TL, TR, BR, BL`). Una homografía matricial $3 \times 3$ pura (resuelta por eliminación gaussiana $8 \times 8$) corrige perspectivas leves y proyecta simultáneamente al cuadrado normalizado $[0, 1]^2$ con el eje $Y$ invertido ($0 = \text{piso}$, $1 = \text{techo}$).
- **Divisiones internas con tramos acotados:** El usuario traza divisiones verticales y repisas horizontales (con imán ortogonal y enganche automático a muros exteriores o divisores verticales existentes), soportando tanto libreros simples como vanos mixtos (ej. Rack de TV o Clóset).
- **Normalización:** No se requiere conocer las dimensiones reales de la foto; el lienzo convierte todos los trazos a coordenadas normalizadas $[0, 1]^2$.
- **Calibración por Referencia (Opcional):** Herramienta para marcar un segmento con dimensión conocida (ej. botón rápido *Hoja A4 = 297 mm* o medida manual en mm) que calcula la escala absoluta en mm/píxel y autocompleta $V_0$ y $V_f$.

### Paso 3 — Parámetros del espacio disponible y carpintería real
- **Vector de Espacio Objetivo:** Ingreso manual/sliders de $V_f = (x_f, y_f, z_f)$ en milímetros (Ancho, Alto, Profundidad) y visualización respecto al vector de referencia $V_0$.
- **Restricciones de Tablero y Sierra:**
  - Plancha estándar de **2440 × 1220 mm** (equivalente a 1220 × 2440 mm con dirección de veta definida a lo largo del eje mayor de 2440 mm).
  - Espesor de melamina estructural $e = 18\text{ mm}$ (**invariante** durante el escalamiento) y fondo opcional $e_{\text{fondo}} = 3\text{ mm}$ (Durolac/MDF sin veta ni tapacanto).
  - Grosor de disco de corte / *kerf* ($s = 3{,}2 \text{ a } 4{,}0\text{ mm}$, por defecto $4{,}0\text{ mm}$).
  - Restricción de orientación de veta ($v_i \in \{0, 1\}$ / `respectGrain`) para impedir la rotación de $90^\circ$ en piezas maderadas.
- **Criterios Constructivos:**
  - Encuentro en esquinas: **Cubierta sobre laterales** (`topOverSides`) vs. **Cubierta entre laterales** (`topBetweenSides`).
  - Modalidad de tapacanto: **Perímetro total** (`fullPerimeter`, respaldo Etapa 2) vs. **Solo cantos frontales/expuestos** (`visibleEdgesOnly`).

### Paso 4 — Resultados sincronizados en tiempo real (4 vistas conectadas)
- **Visor 3D Paramétrico:** Modelo 3D interactivo donde cada pieza física de `matrizDespiece` se renderiza como un sólido exacto (18 mm melamina / 3 mm fondo) con aristas resaltadas (`<Edges />`). Incluye rotación de cámara, acabados procedurales locales (**Blanco Estándar**, **Roble Claro**, **Grafito Mate**), **Vista Explotada** (slider 0%–100%), cotas 3D en mm y resaltado visual (ámbar/rojo) de repisas con alerta de pandeo.
- **Panel Matemático en Vivo:** Despliegue en tiempo real del vector $V_f$, factores de escala $(k_x, k_y, k_z)$, progresión aritmética de repisas ($H_{\text{int}}, s_{\text{libre}}, a_1, d, a_n$), matriz base $n \times 3$, matriz extendida $n \times 5$ y sumatorias de área neta ($\text{m}^2$) y tapacanto ($\text{m}$).
- **Matriz de Despiece y Alertas Mecánicas:** Tabla dinámica exportable a **CSV (con BOM UTF-8 compatible con Excel)** y módulo de validación mecánica que emite una alerta (`StructuralAlert`) si una repisa horizontal de 18 mm supera los **850 mm de luz libre** sin apoyo vertical intermedio (riesgo de pandeo). Al agregar un divisor vertical, las repisas se subdividen automáticamente y la alerta desaparece en vivo.
- **Plano de Corte 2D (Cutting Stock):** Generación vectorial en **SVG descargable** de la distribución óptima de piezas separada por espesor/material (**Planchas Melamina 18 mm** y **Planchas Durolac 3 mm**), aplicando correctamente el *kerf* $s$ entre piezas adyacentes, calculando número total de planchas, porcentaje de aprovechamiento y desperdicio ($\text{uso}\% + \text{desperdicio}\% = 100\%$).

---

## 4. Conexión Directa con la Materia (Guion Visual para el Video de Etapa 3)

La siguiente tabla establece la correspondencia matemática exacta entre los contenidos de la Unidad 3 y la demostración práctica en la interfaz:

| Contenido Unidad 3 | Formulación Matemática / Concepto (Corregido v2.0) | Demostración Práctica en Video |
|---|---|---|
| **Vectores en $\mathbb{R}^3$** | Vector de espacio objetivo $V_f = (x_f, y_f, z_f)$ en mm y coordenadas 2D normalizadas $P_i = (u_i, v_i) \in [0, 1]^2$ con $v = 0$ en la base y $v = 1$ en la cubierta. | Fijar $V_0$ con ancho 1500 mm, desplazar el control a 1800 mm y mostrar la actualización inmediata de $V_f$ y $k_x = 1{,}20$ en el Panel Matemático. |
| **Funciones de Escalamiento** | $k_x = x_f / x_0,\; k_y = y_f / y_0,\; k_z = z_f / z_0$ con espesor $e = 18\text{ mm}$ constante. En `topOverSides`, cubierta/base miden $x_f \times z_f$ y laterales $(y_f - 2e) \times z_f$; en `topBetweenSides`, laterales miden $y_f \times z_f$ y cubierta/base $(x_f - 2e) \times z_f$. | Resaltar en el Visor 3D que al duplicar la altura del mueble, el espesor de las placas permanece invariante en 18 mm y los descuentos interiores se recalculan automáticamente. |
| **Sucesiones (Progresiones Aritméticas)** | Para $N$ repisas equidistantes dentro de $H_{\text{int}} = y_f - 2e$, la luz libre neta es $s_{\text{libre}} = \frac{H_{\text{int}} - N \cdot e}{N + 1}$. La altura de la cara inferior de la $n$-ésima repisa desde el piso es $a_n = a_1 + (n - 1)\cdot d$, con $a_1 = e + s_{\text{libre}}$ y razón constante $d = s_{\text{libre}} + e$. | En el Preset Estantería, variar $N$ de 3 a 5 repisas y observar el recálculo dinámico de $s_{\text{libre}}$, $d$ y los términos $a_1, a_2, \dots, a_5$ sincronizados con el 3D. |
| **Álgebra de Matrices** | 1) Escalamiento de matriz de piezas $M_0 \in \mathbb{R}^{n \times 3}$ (`[Ancho, Alto, Espesor]`) mediante $M = M_0 \cdot \text{diag}(k_1, k_2, 1)$ preservando $e = 18\text{ mm}$ (y escalamiento volumétrico en $\mathbb{R}^3$ por $\text{diag}(k_x, k_y, k_z)$).<br>2) Extensión de matriz $n \times 3$ a $n \times 5$ (`[Ancho, Alto, Espesor, Cantidad, Material]`) al activar fondo de 3 mm.<br>3) Homografía proyectiva $H \in \mathbb{R}^{3 \times 3}$ para rectificar fotos tomadas en ángulo. | Activar *"Incluir Fondo de Durolac (3 mm)"* y mostrar la transición $n \times 3 \to n \times 5$; además mostrar el ajuste de 4 esquinas en perspectiva sobre una foto en `VectorCanvas`. |
| **Sumatorias y Optimización** | Área neta $A = \sum (\text{ancho}_i \times \text{alto}_i \times \text{cantidad}_i)$; Tapacantos $T_{\text{total}} = \sum 2(\text{ancho}_i + \text{alto}_i)$ vs. cantos vistos; optimización 2D sobre planchas $2440 \times 1220\text{ mm}$ con *kerf* $s$ entre cortes y separación de materiales (18 mm vs. 3 mm). | Alternar la restricción de sentido de veta (`respectGrain`) y observar el cambio directo en el acomodo SVG y en el porcentaje de aprovechamiento / desperdicio. |

### Casos de Prueba (Presets Integrados para la Demostración)

1. **Preset 1 — Estantería / Librero Abierto:** $V_f = (800, 1800, 320)\text{ mm}$, `shelfMode: 'equidistant'`, 4 repisas, sin fondo, `topOverSides`. Demuestra la progresión aritmética al pasar de 3 a 5 repisas y dispara la **alerta de pandeo** en vivo al superar 886 mm de ancho exterior (luz libre $> 850\text{ mm}$).
2. **Preset 2 — Rack de TV / Módulo Bajo:** $V_f = (1600, 550, 400)\text{ mm}$, `shelfMode: 'custom'`, 2 divisores verticales en $u = 1/3$ y $2/3$ + 1 repisa central en $v = 0{,}5$ acotada a $[1/3, 2/3]$, sin fondo, `topBetweenSides`. Demuestra vanos mixtos, descuentos de espesor en esquinas (`topOverSides` vs. `topBetweenSides`) y cambio de tapacanto visto vs. total.
3. **Preset 3 — Clóset / Módulo Alto con Fondo:** $V_f = (1500, 2100, 550)\text{ mm}$, `shelfMode: 'custom'`, 1 divisor central en $u = 0{,}5$, 3 repisas en el vano izquierdo + 1 repisa superior en el vano derecho, **con fondo de Durolac 3 mm** (subdividido automáticamente en 2 paños de $750 \times 2100\text{ mm}$ tras el divisor central para entrar en planchas estándar). Demuestra empaquetado **multi-plancha** separado por espesor (18 mm y 3 mm) y la matriz extendida $n \times 5$.

---

## 5. Arquitectura Modular y Contratos de Datos (Anti-Caos para Antigravity)

Para evitar acoplamientos y fallas de compilación entre bloques, la aplicación se divide en módulos estrictamente desacoplados articulados por **un único archivo inmutable de contratos** (`src/types/contracts.ts`), congelado desde el Bloque 1.

```text
src/
├── types/
│   └── contracts.ts              # Contratos inmutables (única fuente de verdad, congelado en Bloque 1)
├── core/
│   ├── mathEngine/
│   │   ├── homography.ts         # Homografía proyectiva 3x3 + inversa (álgebra lineal pura)
│   │   ├── presets.ts            # Presets 1, 2 y 3 (Estantería, Rack TV, Clóset)
│   │   ├── index.ts              # Motor matemático puro Unidad 3 (Sin UI, 100% Vitest)
│   │   └── mathEngine.test.ts    # Suite unitaria (incluye validación exacta Etapa 2)
│   └── cuttingStock/
│       ├── optimizer.ts          # Empaquetado 2D MaxRects/Guillotine con kerf, veta y separación por espesor
│       ├── svgGenerator.ts       # Generador SVG vectorial offline (planchas 2440x1220, cotas, veta)
│       ├── index.ts              # Orquestador generateCuttingPlan()
│       └── cuttingStock.test.ts  # Suite unitaria (cero solapamiento, kerf, veta, multi-plancha)
├── components/
│   ├── vectorCanvas/
│   │   └── VectorCanvas.tsx      # Carga 1-2 vistas, 4 nodos con homografía, líneas con snap, calibración A4
│   ├── viewer3d/
│   │   └── Viewer3D.tsx          # Visor R3F/Three.js offline + texturas procedurales + Vista Explotada + cotas
│   └── mathPanel/
│       └── MathPanel.tsx         # Panel matemático en vivo, matrices n×3/n×5, alertas, SVG y export CSV/SVG
└── App.tsx                       # Flujo de 4 pasos + barra de Presets + estado reactivo sincronizado
```

### Convenciones Geométricas Congeladas (Cero Ambigüedad)

1. **Sistema de Coordenadas 3D (mano derecha, mm):**
   - Origen `(0, 0, 0)` en la **esquina inferior-izquierda-trasera** del mueble.
   - `+X`: izquierda → derecha (`0` a `x_f`).
   - `+Y`: piso → cubierta (`0` a `y_f`).
   - `+Z`: pared trasera → frente visible (`0` a `z_f`).
   - Fondo 3 mm (si está activo): clavado exterior trasero en `z ∈ [-3, 0]` (`cz = -1.5 mm`), evitando *Z-fighting* y manteniendo intactas las medidas de la caja de 18 mm al activar/desactivar el fondo.
2. **Piezas físicas 1:1 con 3D:** `matrizDespiece` emite **una `BoardPiece` por cada placa física** (`cantidad: 1`), con su centro `posicion3D: [cx, cy, cz]` y dimensiones exactas alineadas a ejes `dimensiones3D: [dx, dy, dz]` en mm. La agrupación por medidas iguales (`cantidad >= 1`) se entrega en `matrixNx5` y `consolidatedRows`.
3. **Eje de veta y plancha estándar:** La plancha se modela como `width = 2440 mm` (eje horizontal = sentido de veta) × `height = 1220 mm` (transversal). En cada `BoardPiece`, `ancho` es la dimensión paralela a la veta (largo horizontal en cubierta/base/repisas; altura vertical en laterales/divisores) y `alto` es la dimensión transversal (profundidad). Así, piezas largas de hasta 2440 mm caben respetando la veta.
4. **Regla de tapacanto:** Los bordes `top`/`bottom` tienen longitud `ancho` (`top` = canto frontal visible `+Z`), y `left`/`right` tienen longitud `alto`. El fondo Durolac 3 mm no lleva veta (`respectGrain: false`) ni tapacanto (`edges` todos `false`).
5. **Subdivisión automática en vanos mixtos:** Las divisiones verticales son continuas en su rango `[start, end]`; toda repisa horizontal que cruce un divisor vertical se subdivide automáticamente en sub-repisas descontando `e = 18 mm`, actualizando en vivo su luz libre y la alerta de pandeo (`> 850 mm`).

### Contratos de Datos Principales (`src/types/contracts.ts`)

| Contrato | Campos Clave | Productor | Consumidores |
|---|---|---|---|
| `FurnitureTopology` | `viewsMode: 1 \| 2`, `aspectRatioXY`, `aspectRatioZY?`, `quadCorners?` (`[TL,TR,BR,BL]`), `homographyMatrix?`, `vDividers: NormalizedSegment[]`, `hShelves: NormalizedSegment[]`, `shelfMode: 'equidistant' \| 'custom'`, `equalShelfCount`, `hasBackPanel` | `vectorCanvas`, `presets` | `mathEngine` |
| `ScaleAndBoardParams` | `targetDimensions: {x,y,z}`, `referenceDimensions: {x,y,z}`, `boardThickness: 18`, `backPanelThickness: 3`, `sheetDimensions: {width: 2440, height: 1220}`, `kerf`, `respectGrain`, `cornerJointType`, `edgeBandingMode`, `material` | Formulario UI (`App.tsx`) | `mathEngine`, `cuttingStock`, `viewer3d` |
| `BoardPiece` | `id`, `nombre`, `tipo`, `ancho`, `alto`, `espesor`, `cantidad`, `respectGrain`, `edges`, `posicion3D`, `dimensiones3D`, `rotacion3D`, `material` | `mathEngine` | `viewer3d`, `cuttingStock`, `mathPanel` |
| `DespieceResult` | `scaleFactors`, `shelfProgression` (`count, hInteriorMm, clearSpanMm, a1, d, terms`), `matrizDespiece`, `matrixNx3`, `matrixNx5`, `consolidatedRows`, `totalNetAreaM2`, `backPanelAreaM2`, `totalEdgeBandingMeters`, `alerts` | `mathEngine` | `viewer3d`, `mathPanel`, `cuttingStock` |
| `CuttingPlanResult` | `sheetsUsed: SheetLayout[]` (incl. `espesorMm`, `materialLabel`), `unplacedPieces`, `totalSheetsCount`, `melamineSheetsCount`, `backPanelSheetsCount`, `usagePercentage`, `wastePercentage`, `svgMarkup` | `cuttingStock` | `mathPanel` |

---

## 6. Plan de Ejecución de 10 Días (19 al 28 de Noviembre)

El desarrollo se organiza en 4 bloques secuenciales. **Regla de compuerta:** no se avanza al siguiente bloque hasta que `npx vitest run` (y `npm run build` desde el Bloque 3) finalice al 100% sin errores.

| Bloque / Fechas | Objetivo Principal | Entregable Verificable |
|---|---|---|
| **Bloque 1 (19–21 nov)** | Contratos congelados (`contracts.ts`), homografía $3 \times 3$, presets y Motor Matemático Puro (`mathEngine`). | `npx vitest run` en verde validando Etapa 2 ($k = 1{,}2$: área $0{,}8800 \to 1{,}2672\text{ m}^2$, tapacanto $6{,}80 \to 8{,}16\text{ m}$, $e = 18\text{ mm}$), descuentos de esquina, vanos mixtos, progresión $a_n$ y alerta $> 850\text{ mm}$. |
| **Bloque 2 (22–23 nov)** | Optimizador 2D (`cuttingStock`) con separación de espesores y generador SVG offline. | `npx vitest run` (Bloques 1 + 2) verificando cero solapamientos con *kerf* $s$, bloqueo de veta, separación 18 mm / 3 mm, multi-plancha y `unplacedPieces`. |
| **Bloque 3 (24–26 nov)** | Visor 3D Paramétrico offline (`viewer3d`), Panel Matemático en Vivo (`mathPanel`) y `App.tsx` con los 3 Presets. | `npm run build` + `npx vitest run` en verde; sliders sincronizan 3D, Vista Explotada, fórmulas, alertas, plano SVG y descargas CSV/SVG. |
| **Bloque 4 (27–28 nov)** | Lienzo Vectorial sobre Imagen (`vectorCanvas`: 1–2 vistas, homografía, snap, calibración A4) e integración de 4 pasos. | Flujo completo 100% local operativo sin errores de compilación ni peticiones de red externas. |
| **Cierre y Video (29–30 nov)** | Grabación de los 3 casos de prueba + flujo de foto, narración matemática y edición. | Video final listo para entrega oficial el **1 de diciembre de 2026**. |

---

## 7. Ejecución Guiada por Bloques en Antigravity

Los **4 prompts definitivos, auditados y sincronizados** con los contratos de la Sección 5 se mantienen en una única fuente para evitar desincronización:

- Ver **[Auditoria y Prompts.txt](file:///D:/Escritorio/OneDrive%20-%20INACAP/Escritorio/Nueva%20carpeta%20(6)/Auditoria%20y%20Prompts.txt)** (Sección 4: Prompts Bloque 1, Bloque 2, Bloque 3 y Bloque 4).

---

## 8. Espacio de Revisión y Decisiones del Equipo

### Decisiones de Diseño y Contenido (Alineadas antes del Bloque 1)

- **Selección de Casos de Referencia (Fotos / Croquis para Paso 1):**
  - Caso 1 (Estantería): `[ Indicar foto o croquis del equipo ]` *(respaldo: croquis procedural local incluido en el Bloque 4)*
  - Caso 2 (Rack de TV): `[ Indicar foto o croquis del equipo ]`
  - Caso 3 (Clóset / Módulo Alto): `[ Indicar foto o croquis del equipo ]`
- **Alcance de la Calibración A4 (Bloque 4):**
  - `[x]` Implementar completamente en la interfaz (botón rápido *Referencia A4 = 297 mm* + medida personalizada en mm, 100% local).
  - `[ ]` Incluir solo como demostración conceptual.
- **Paleta de Texturas Procedurales en Visor 3D (100% offline):**
  - Melamina **Blanco Estándar** / **Roble Claro** / **Grafito Mate** (generadas localmente vía `CanvasTexture`).

### Distribución de Roles para la Grabación del Video (Etapa 3)

| Integrante | Rol Asignado | Bloque del Video a Presentar |
|---|---|---|
| **Fernando A. Durán Leiva** | `[ Definir rol ]` | Introducción, problemática y captura de vectores + homografía sobre foto (`VectorCanvas`). |
| **Cristopher D. Figueroa Arthur** | `[ Definir rol ]` | Demostración del motor matemático ($\mathbb{R}^3$, escalamiento $k$, matrices $n \times 3$ / $n \times 5$). |
| **Francisco A. Lara Yevenes** | `[ Definir rol ]` | Progresiones aritméticas en repisas, alertas de pandeo ($> 850\text{ mm}$) y Visor 3D en vivo. |
| **Génesis T. Sepúlveda Muñoz** | `[ Definir rol ]` | Optimización Cutting Stock 2D (SVG, veta, *kerf*, multi-plancha), tapacantos y conclusiones. |

### Notas Adicionales del Equipo

- Mantener verificación estricta de funcionamiento **sin conexión a internet** (modo avión o DevTools Network Offline) antes de grabar el video para certificar cumplimiento 100% de la Etapa 2.
