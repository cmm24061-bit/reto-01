# Reto 01 — Agente "Registro como Proveedor"

Agente conversacional que lee la solicitud de un cliente, llena el formulario de registro como proveedor desde el repositorio maestro, arma el paquete para firma y **pide confirmación humana** antes de cualquier envío (simulado).

- **Link de prueba:** `PEGAR_AQUI_EL_LINK_DE_RENDER`
- **Clave de acceso:** no requerida (si se activa `APP_ACCESS_KEY`, se indicará aquí).
- Planteamiento de la solución: [`SOLUCION.md`](SOLUCION.md)

> El link usa el plan gratuito de Render: si estuvo inactivo, la primera carga puede tardar ~1 minuto en despertar.

## Levantar en local (un comando)

Requisito: [Bun](https://bun.sh) 1.1 o superior.

```bash
cp .env.example .env        # y poner ANTHROPIC_API_KEY
bun install && bun run dev  # abre http://localhost:3000
```

Front y backend se sirven desde el mismo proceso. Sin `ANTHROPIC_API_KEY` el servidor arranca con el **proveedor simulado** (guion fijo, sin modelo) para poder probar el flujo de la interfaz.

Con Docker: `docker build -t reto01 . && docker run -p 3000:3000 --env-file .env reto01`

## Verificación sin modelo

```bash
bun install && bun run demo.ts
```

Ejecuta las herramientas sobre todos los casos de `fixtures/reto-01/casos/`, imprime un resumen por caso, prueba el bloqueo del envío sin confirmación y dos errores controlados. Limpia `out/` al inicio. No necesita clave.

Para resultados idénticos en cualquier fecha: `FECHA_REFERENCIA=2026-11-03 bun run demo.ts` (las vigencias de soportes dependen de la fecha de ejecución).

## Variables de entorno

| Variable | Obligatoria | Descripción |
|---|---|---|
| `ANTHROPIC_API_KEY` | Sí (para usar el modelo) | Clave del proveedor. Solo vive en el backend. |
| `LLM_PROVIDER` | No | `anthropic` (defecto) o `simulado`. |
| `LLM_MODEL` | No | Defecto `claude-sonnet-5-5`. |
| `LLM_TIMEOUT_MS` | No | Timeout al proveedor. Defecto 90000. |
| `MAX_ITERACIONES` | No | Tope de ciclos herramienta→modelo por turno. Defecto 25. |
| `MAX_TOKENS_SESION` | No | Tope de tokens por sesión. Defecto 300000. |
| `MAX_TOKENS_GLOBAL` | No | Tope de tokens de todo el servidor desde que arrancó. Defecto 3000000. |
| `APP_ACCESS_KEY` | No | Si se define, el chat pide esta clave. |
| `FECHA_REFERENCIA` | No | Fija la fecha de ejecución (YYYY-MM-DD). |
| `PORT` | No | Defecto 3000. |

## API

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/api/chat` | `{ sessionId, message }` → `{ reply, toolCalls[], needsConfirmation }` |
| `GET` | `/api/sessions/:id` | Historial visible de la sesión (mensajes y llamadas a herramientas) |
| `GET` | `/api/health` | `{ ok, provider, model }` — nunca expone la clave |
| `GET` | `/api/casos` | Casos disponibles |
| `GET` | `/api/solicitudes` | Lista de solicitudes (correos) con estado |
| `GET` | `/api/casos/:caso` | Detalle: correo, información extraída, campos, soportes, borradores (solo lectura de lo que generaron las herramientas) |
| `GET` | `/api/paquete/:caso.zip` | Descarga del paquete para firma en .zip |
| `GET` | `/api/archivos/:caso` | Archivos generados en `out/<caso>/` |
| `GET` | `/api/archivo?ruta=out/...` | Descarga de un archivo generado (solo dentro de `out/`) |

Si `APP_ACCESS_KEY` está activa, enviar la cabecera `x-access-key` (o `?key=` en descargas).

## Estructura

```
agent/prompt.md                 comportamiento (system prompt)
src/knowledge/                  conocimiento: registro-proveedor.md (proceso) + reglas.json (reglas que aplican las herramientas)
src/tools/proveedor.ts          herramientas (cada export → proveedor_<export>), validadas con zod
src/tools/registry.ts           validación zod + JSON Schema para el modelo
src/llm/adapter.ts              interfaz enviar(mensajes, herramientas) → respuesta
src/llm/anthropic.ts            implementación Anthropic (fetch, timeout)
src/llm/simulado.ts             implementación sin modelo (guion fijo) para pruebas
src/agent.ts                    ciclo del agente, confirmación humana, sesiones, log
src/server.ts                   API HTTP + front estático
web/index.html                  pantalla: formulario de solicitudes, detalle del caso y chat
src/solicitudes.ts              datos de solo lectura para la pantalla y zip del paquete
modulo/                         bonus: agente empaquetado (generado desde las mismas fuentes)
demo.ts                         herramientas sin modelo
```

## Salidas

- `out/<caso>/formulario.xlsx | formulario.pdf | valores-portal.md`
- `out/<caso>/paquete/` → formulario, soportes vigentes, `checklist.md`, `borrador-correo.md`
- `out/<caso>/ENVIO-SIMULADO.md` (solo tras confirmación explícita)
- `out/<caso>/log.jsonl` y `out/log.jsonl`
