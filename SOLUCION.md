# SOLUCIÓN — Agente "Registro como Proveedor"

## 1. Problema en una frase

El área administrativa transcribe a mano, entre 8 y 12 veces al mes, los mismos datos de Periferia en formularios de clientes con formatos distintos (Excel, PDF o portal). Eso genera errores en datos sensibles, depende de una sola persona y retrasa la facturación. **Le duele a la analista administrativa** (retrabajo) y **a la empresa** (facturación tardía y riesgo de error en NIT o cuenta bancaria).

## 2. Arquitectura

```
┌──────────────────┐  POST /api/chat   ┌───────────────────────────────────────────────┐
│ web/index.html   │ ────────────────▶ │ src/server.ts  (API HTTP + sirve el front)    │
│ - historial      │ ◀──────────────── │        │                                      │
│ - tool calls     │  reply, toolCalls,│        ▼                                      │
│ - confirmación   │  needsConfirmation│ src/agent.ts   (ciclo, confirmación, sesiones)│
└──────────────────┘                   │   │                    │                      │
                                       │   ▼                    ▼                      │
                                       │ src/llm/adapter.ts   src/tools/registry.ts    │
                                       │   ├ anthropic.ts       (validación zod)       │
                                       │   └ simulado.ts          │                    │
                                       │                          ▼                    │
                                       │                  src/tools/proveedor.ts       │
                                       └──────────────────────────┬────────────────────┘
                                                 lee              │            escribe
                                  fixtures/ + src/knowledge/ ◀────┴────▶ out/
```

Dónde vive cada cosa:

| Capa | Archivo | Qué cambia aquí |
|---|---|---|
| **Comportamiento** | `agent/prompt.md` | Cómo conversa el agente, orden de pasos, formato de respuesta, reglas de confirmación |
| **Conocimiento** | `src/knowledge/registro-proveedor.md` (para el modelo) y `src/knowledge/reglas.json` (para las herramientas) | Identificador por país, umbrales de confianza, etiquetas ambiguas, nombres de soportes |
| **Ejecución** | `src/tools/` | Lectura, mapeo, generación de archivos, paquete, envío simulado |

Un cambio de reglas de negocio (por ejemplo, agregar Guatemala → NIT, o subir el umbral a 0.9) se hace en `reglas.json`. No toca el servidor ni el código.

## 3. Ciclo del agente

`src/agent.ts → procesarTurno()`:

1. Se agrega el mensaje de la usuaria al historial.
2. **Bucle** de hasta `MAX_ITERACIONES` (25 por defecto):
   - Se envía al modelo el system prompt (`prompt.md` + conocimiento), el historial y las herramientas (JSON Schema generado desde zod).
   - Si el modelo pide herramientas, el backend **valida los argumentos con zod** (si fallan, devuelve el error al modelo), ejecuta, registra en `out/log.jsonl` y en el historial visible, y vuelve a llamar al modelo.
   - Si el modelo responde texto sin herramientas, el turno termina.
3. **Tope de iteraciones (CA1)**: si se alcanza, el agente responde qué hizo y qué falta.
4. **Tope de costo**: tokens por sesión y globales configurables; al superarlos el turno termina con un mensaje claro.
5. **Errores (CA5)**: un error del proveedor (timeout, clave inválida, saturación) se traduce a un mensaje en español y la sesión sigue viva.

**Confirmación humana (CA3 / RN4)**, en tres capas:

1. **Prompt**: el agente termina con una pregunta explícita y la marca `[CONFIRMACION_REQUERIDA]`.
2. **Servidor**: si hubo marca o se armó un paquete sin enviar, la sesión queda en `esperandoConfirmacion` y la respuesta trae `needsConfirmation: true`. El front lo resalta en amarillo, con botones.
3. **Herramienta**: en el turno siguiente, el servidor calcula `confirmacionHumana` (estado pendiente + mensaje afirmativo como "sí", "confirmo" o "envía") y lo pasa en el `ctx`. `proveedor_simular_envio` exige `confirmado: true` **y** que el servidor lo haya habilitado. Aunque el modelo "decida" enviar sin confirmación, la herramienta lo rechaza con `requiere confirmación explícita`.

**CA2 (no inventar valores)** también se garantiza por diseño:
- `generar_formulario` toma **siempre** los valores del maestro por su clave. Si el modelo envía un mapeo, solo se usan las claves; nunca los valores.
- `mapear_campos` devuelve al modelo los datos bancarios enmascarados (`****2345`). Así el modelo no puede repetirlos en el chat, y el archivo usa el valor real.

## 4. Elección del modelo

- **Proveedor / modelo:** Anthropic, `claude-sonnet-5-5`, configurable con `LLM_MODEL`.
- **Por qué:** es confiable en el uso de herramientas en varios pasos, sigue bien las instrucciones en español y tiene un costo moderado. Un modelo más grande no aporta aquí, porque la lógica crítica está en las herramientas y no en el modelo.
- **Costo estimado por caso:** un caso usa ~5 llamadas al modelo (4 herramientas + respuesta final). Cada una lleva ~6–8 mil tokens de entrada (prompt + conocimiento + historial + resultados), es decir, unos 35 mil tokens de entrada y ~2.5 mil de salida. Al precio de Sonnet 5.5 (US$2 por millón de entrada y US$10 por millón de salida), son **≈ US$0.10 por caso**, y ≈ US$0.12 con el turno de confirmación. Con 12 casos al mes, el costo es de ~US$1.5 al mes.
- **Cambio de proveedor:** se implementa `ProveedorLLM` (`src/llm/adapter.ts`) para otro proveedor y se elige en `crearProveedor()`. El ciclo del agente no cambia. Como prueba de ello existe `simulado.ts`, una segunda implementación sin modelo.

## 5. Diseño del portal web (formato `portal`)

**Lo implementado hoy:** el agente responde "formato no soportado" y genera `valores-portal.md`, con cada campo, su valor y su estado, listo para copiar.

**Diseño para producción:**

- **Estrategia:** navegador controlado por el agente (Playwright) en modo **asistido**, no RPA desatendido.
  - Se usa una "receta" por portal (selectores de cada campo), guardada como conocimiento y no como código.
  - Si la receta falla, porque el layout cambió, el agente vuelve a `valores-portal.md`. No improvisa.
  - Alternativa evaluada: una extensión de navegador que rellena campos en la sesión de la analista. Es más robusta frente a MFA, pero exige instalar y mantener la extensión.
- **Límites:**
  - CAPTCHA y MFA: siempre los resuelve el humano. El agente se detiene y espera.
  - Cambios de layout: recetas versionadas, con detección de campos no encontrados.
  - Cargas de archivos: el agente prepara los archivos; el humano los adjunta o los revisa.
- **Credenciales:**
  - Nunca en el repositorio, en el prompt ni en los logs.
  - Viven en un gestor de secretos corporativo (Bitwarden o Azure Key Vault).
  - La analista las ingresa directamente en la ventana del navegador; el agente nunca las lee.
  - Los logs del navegador y las capturas excluyen los campos de contraseña.
- **Reparto de tareas:**

| Agente | Humano |
|---|---|
| Abrir el portal, navegar al formulario, rellenar campos desde el mapeo, marcar los faltantes, preparar los adjuntos | Ingresar credenciales, resolver MFA/CAPTCHA, revisar los valores, **hacer clic en "Enviar"** |

## 6. Decisiones y trade-offs

| # | Decisión | Alternativa descartada | Por qué |
|---|---|---|---|
| 1 | **Valores siempre desde el maestro**, incluso si el modelo envía el mapeo | Usar los valores que manda el modelo | CA2: elimina por diseño el riesgo de que el modelo "complete" o altere un dato. Costo: el modelo no puede corregir un valor, pero el maestro es la fuente oficial. |
| 2 | **Confirmación validada en el servidor** (`ctx.confirmacionHumana`) | Confiar en `confirmado: true` del modelo | Un modelo puede equivocarse o ser manipulado ("ya confirmé antes"). La regla RN4 queda en código. Costo: frases afirmativas poco comunes ("mándalo ya") se deben confirmar con el botón. |
| 3 | **Front en HTML plano servido por el backend** | React + Vite | Un solo proceso, sin paso de build, menos piezas que puedan fallar en el despliegue. Para un chat de una pantalla, React no aporta. |
| 4 | **PDF generado con `pdf-lib`** | Rellenar un AcroForm | No se recibió el PDF original y el PRD acepta el PDF generado. Las celdas en amarillo y las notas marcan lo que requiere confirmación. |
| 5 | **Mapeo determinista** (glosario exacto → normalizado → similitud por palabras) | Pedir al modelo que mapee | Es reproducible (`demo.ts` da siempre lo mismo), trazable (ruta y confianza) y gratis. El modelo solo orquesta. |
| 6 | **`fetch` directo a la API** en lugar del SDK | `@anthropic-ai/sdk` | Una dependencia menos y control explícito del timeout y de los mensajes de error. |
| 7 | **Render (servidor siempre activo, Docker)** | Vercel (serverless) | El agente mantiene sesión y escribe en `out/`. En serverless, cada request puede caer en otra instancia y perder ambos. |

## 7. Supuestos

- La **fecha de ejecución** es la fecha actual en Bogotá (o `FECHA_REFERENCIA`). Con fecha 2026-11-03, la Cámara de Comercio (vence 2026-09-30) y los parafiscales (vencen 2026-08-31) están vencidos, así que **ningún caso queda listo para firma**. Ese es el comportamiento correcto.
- Las plantillas Excel se **reconstruyen** escribiendo etiqueta y valor en la hoja y celda indicadas, porque no se recibió el `.xlsx` original.
- "País" se llena con el valor del maestro (`CO`) sin traducirlo a "Colombia", para no transformar datos.
- "Correo electrónico" corresponde a `contacto_comercial.email`, según el glosario.
- "Ingresos anuales" se escribe como número (en COP, según el maestro).
- El **envío simulado se permite aunque el paquete no esté listo para firma**, si la usuaria lo confirma explícitamente. La decisión es humana; el archivo y la pregunta de confirmación llevan una advertencia visible.
- Los datos bancarios se incluyen en el formulario cuando la plantilla los pide, pero **no** en el borrador de correo ni en el chat (enmascarados).
- Las sesiones se guardan en memoria y en `out/sesiones/`. En el plan gratuito de Render se pierden al reiniciar el servicio, lo cual es aceptable según el PRD (sin persistencia).

## 8. Cobertura

| Historia | Estado | Notas |
|---|---|---|
| HU-1 Leer la solicitud | Hecho | País, cliente, formato, campos, soportes. Las etiquetas ambiguas y el identificador por país se marcan como `requiere_confirmacion` en el mapeo. |
| HU-2 Mapear campos | Hecho | Tres estados, con ruta `maestro.json#clave` y confianza. Glosario automático. Nunca inventa valores. |
| HU-3 Formulario | Hecho (P0 xlsx, P1 pdf, P2 portal) | El portal genera `valores-portal.md` + "formato no soportado". |
| HU-4 Paquete para firma | Hecho | Copias de soportes vigentes, `checklist.md` (presentes/vencidos/ausentes), `borrador-correo.md` sin datos bancarios, pregunta de confirmación, `ENVIO-SIMULADO.md`. |
| HU-5 Errores | Hecho | `{ ok:false, error }` en todas las herramientas, sin trazas. Prueba en `demo.ts`. |
| Bonus módulo | Hecho | `modulo/` se genera desde las mismas fuentes en cada arranque; las herramientas se re-exportan, no se copian. |

**Qué falta para producción:**
- Leer los Excel y PDF reales del cliente, no fixtures JSON.
- Integración con correo y SharePoint.
- Autenticación y roles.
- Persistencia real (base de datos o almacenamiento).
- Recetas de portal.
- Pruebas automatizadas con más plantillas reales.
- Revisión de seguridad.
- Un dueño del dato del maestro.

## 9. Uso de IA

> **Completar con tus palabras antes de entregar.**

- **Claude (Anthropic), en la app de Claude.** Lo usé para:
  - Analizar el PRD y los fixtures.
  - Proponer la arquitectura.
  - Generar el código base (herramientas, ciclo del agente, adaptador, front), `demo.ts` y la documentación.
  - Verificar el flujo de punta a punta.
- **Revisión propia:** revisé y ejecuté cada parte (`demo.ts`, el chat, los archivos generados) y validé las reglas de negocio contra el PRD.
- **Lo que descarté de lo propuesto:**
  - Desplegar en Vercel o en Google Apps Script. Vercel porque es serverless, y Apps Script porque no cumple TypeScript con Bun/Node, zod ni `bun run demo.ts`.
  - React para el front, por el tiempo disponible.
  - Que el modelo hiciera el mapeo de campos, porque no sería determinista ni trazable.

## 10. Riesgos de llevar esto a producción

| Riesgo | Mitigación |
|---|---|
| El modelo afirma un valor no verificado en el chat | Los valores salen solo de las herramientas; los formularios se generan desde el maestro; los datos bancarios llegan enmascarados al modelo; prompt con prohibición explícita. |
| Maestro desactualizado | Asignar un dueño del dato; agregar fecha de última actualización y alerta si es antigua. |
| Plantillas reales más desordenadas (celdas combinadas, PDFs escaneados) | Leer los archivos reales con librerías de Excel/PDF; dejar el mapeo dudoso en `requiere_confirmacion`; ampliar el glosario con cada caso nuevo. |
| Envío por error | Confirmación validada en el servidor; en producción, además, que el envío lo haga siempre una persona desde su correo. |
| Gasto descontrolado de la clave | Topes por turno, por sesión y global; `APP_ACCESS_KEY`; alertas de gasto en la consola del proveedor. |
| Fuga de datos sensibles en logs | Los logs guardan solo resúmenes; los argumentos no contienen valores bancarios; la clave nunca se registra. |
| Portales con MFA/CAPTCHA o cambios de layout | Modo asistido: el humano opera las credenciales y el envío; fallback a valores para copiar. |
| Dependencia de un proveedor de modelo | El adaptador permite cambiar de proveedor sin tocar el ciclo. |
