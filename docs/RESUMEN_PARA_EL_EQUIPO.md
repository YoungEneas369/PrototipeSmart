# SmartFurniture: Resumen para el equipo (en simple)

> Lectura de 5 minutos. El detalle técnico completo está en [`ANALISIS_TECNICO_v2.1.md`](./ANALISIS_TECNICO_v2.1.md).

## ¿En qué estamos?

Todavía **no hemos programado nada**. Antes de empezar revisamos el plan a fondo, hicimos pruebas pequeñas y encontramos cosas que conviene cambiar **ahora**, cuando cambiarlas es barato.

**Veredicto: el proyecto es totalmente lograble para el 1 de diciembre**, siempre que hagamos los cambios de abajo.

---

## Lo que ya está bien (no se toca)

- La parte **matemática** (vectores, escalamiento, progresión de repisas, matrices, sumatorias) está correcta y se puede probar automáticamente.
- El **visor 3D** y el **plano de corte** se pueden construir sin problemas.
- Ya probamos que las herramientas (React, Three.js, Vite) **funcionan juntas y sin internet**.

---

## El problema principal: pasar de una foto al mueble 3D

### Lo que descubrimos

**No necesitamos que la foto entregue medidas exactas.** El usuario igual escribe las medidas reales del espacio (ancho, alto y fondo, en mm). De la foto solo necesitamos saber **cuántas repisas y divisiones tiene el mueble y dónde están**. Esa parte se puede sacar con precisión.

### Qué cambiamos y por qué

| Antes | Ahora | Por qué (en simple) |
|---|---|---|
| Una fórmula (Zhang) adivinaba el "zoom" de la cámara | Usamos el zoom típico de un celular (o el que viene guardado en la foto) | En la foto más común de un clóset, la fórmula fallaba **casi la mitad de las veces**. Con el zoom típico, el error baja a ~2 % |
| Detectar bordes "a ciegas" | El programa **aprende el color del mueble** mirando sus costados y busca tablas de 18 mm de ese color | Probado con libros, sombras y luz desigual: encontró todas las repisas con menos de 1,2 mm de error |
| Prometer que la detección automática siempre funciona | La detección es una **ayuda**: si no está segura, **lo dice** y el usuario dibuja a mano | En un mueble blanco con fondo blanco ningún programa simple puede ver las repisas. Es mejor avisar que inventar |

### Lo más importante que falta probar

**Fotos reales.** Todas las pruebas fueron con imágenes simuladas. Necesitamos **10 a 15 fotos reales de muebles** lo antes posible.

---

## 📸 Cómo sacar las fotos (por favor, seguir esto)

1. El mueble **abierto**, sin puertas, y en lo posible con pocas cosas dentro.
2. Ponte **al centro** del mueble, con el celular a **media altura** del mueble.
3. **Aléjate unos 3 metros** y usa zoom **1× o 2×**. **No uses 0,5×** (gran angular), porque curva las líneas.
4. Que salga el mueble **completo**. **No recortes** la foto.
5. Envíala por WhatsApp **como Documento** (no como foto), o por Drive/cable. Así no pierde calidad ni información.
6. Opcional: pega una hoja carta o A4 en el frente del mueble.
7. Anota a mano: ¿cuántas repisas y divisiones tiene? Si puedes, mide el ancho, el alto y el fondo.

---

## Otros cambios

- **Plano de corte "de taller":** las piezas se acomodan en **franjas**, como corta la sierra de Sodimac o Imperial (cortes de lado a lado). Es más realista, más fácil de explicar en el video con sumatorias y, en nuestras pruebas, usa la menor cantidad posible de planchas.
- **Planchas chilenas:** además del tamaño de la pauta (2440×1220), se puede elegir el tamaño que se vende en Chile (2500×1830). Por ejemplo, la estantería del Preset 1 cabe en **1 plancha chilena** en vez de 2.
- **Corrección de un error escondido:** había una confusión entre medir desde el borde **exterior** o **interior** del mueble que movía las repisas hasta 1 cm. Ya está identificada y se corrige desde el inicio.
- **Menos alcance:** la segunda foto lateral pasa a ser **opcional**. La profundidad se elige por tipo de mueble (estantería 32 cm, rack 40 cm, clóset 55 cm) o se escribe.

---

## Nuevo calendario

| Fecha | Qué se hace | ¿Quién? (a definir) |
|---|---|---|
| **20–21 nov** | Base matemática del programa · **📸 sacar las fotos reales** | Programación + 1 persona para las fotos |
| 22–23 nov | Plano de corte · probar la detección con las fotos | Programación + visión |
| 24–26 nov | Visor 3D, panel matemático y los 3 presets | Programación + visión |
| 27–28 nov | Pantalla de la foto (dibujar y corregir líneas) | Programación |
| 29–30 nov | **Grabar el video:** primero la matemática, después la foto | Los 4 |
| **1 dic** | Entrega | — |

**Cambio clave:** la parte de la foto, que es la más difícil, **empieza hoy en paralelo** y no al final.

---

## Para el video (lo que más pesa en la nota)

El profesor evalúa la **Unidad 3**. El orden recomendado es:
1. **Vectores y escalamiento:** cambiar el ancho de 1500 a 1800 mm y mostrar k = 1,20, con el espesor que se mantiene en 18 mm.
2. **Progresión aritmética:** pasar de 3 a 5 repisas y ver cómo se recalculan las alturas.
3. **Matrices:** activar el fondo y ver cómo la tabla pasa de 3 a 5 columnas, más la matriz de la foto (homografía).
4. **Sumatorias:** área total, metros de tapacanto y plano de corte.
5. **El "wow" final:** sacar una foto y que aparezca el mueble en 3D.

---

## ¿Qué necesitamos de ti?

- [ ] Leer este resumen y decir si estás de acuerdo con los cambios.
- [ ] **Conseguir fotos reales** siguiendo las instrucciones de arriba.
- [ ] Opinar: ¿quién se encarga de la parte de la foto?
