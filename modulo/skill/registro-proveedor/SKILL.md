---
name: registro-proveedor
description: Conocimiento del proceso de registro de Periferia como proveedor (identificador tributario por país, soportes y vigencias, reglas de datos bancarios y portales). Usar al procesar solicitudes de registro de proveedor.
---
<!-- ARCHIVO GENERADO por scripts/build-modulo.ts. No editar aquí: editar la fuente indicada. -->
<!-- Fuente: src/knowledge/registro-proveedor.md (reglas automáticas en src/knowledge/reglas.json) -->

# Conocimiento: registro de Periferia como proveedor

Este archivo describe **el proceso**. El agente lo recibe como contexto. Las reglas que las herramientas aplican de forma automática están en `reglas.json` (misma carpeta), para que un cambio de negocio no toque el código.

## El proceso de punta a punta

1. **Recepción** deposita el correo del cliente en `fixtures/reto-01/casos/<caso>/`.
2. **Leer la solicitud**: país, cliente, formato de salida (xlsx, pdf o portal), campos que pide la plantilla y soportes exigidos.
3. **Mapear campos al maestro** (`repositorio/maestro.json`). Cada campo termina en uno de tres estados:
   - `lleno`: el dato existe en el maestro; se informa la ruta (ej. `maestro.json#banco.swift`).
   - `faltante`: no existe en el maestro. **Nunca se inventa.**
   - `requiere_confirmacion`: el mapeo es dudoso (confianza < 0.8) o aplica una regla de país.
4. **Generar el formulario** en el mismo formato del cliente en `out/<caso>/`.
5. **Armar el paquete para firma** en `out/<caso>/paquete/`: formulario, copias de soportes, `checklist.md` y `borrador-correo.md`.
6. **Pedir confirmación** a la analista. Solo con confirmación explícita se simula el envío (`ENVIO-SIMULADO.md`).

El agente **nunca firma ni envía**. La firma es del representante legal y el envío es decisión humana.

## Identificador tributario por país

| País | Nombre del identificador |
|---|---|
| Colombia (CO) | NIT |
| Ecuador (EC) | RUC |
| Perú (PE) | RUC |
| Panamá (PA) | RUC |
| Honduras (HN) | RTN |

Periferia solo tiene NIT colombiano. Si el cliente es de otro país, el campo se llena con el NIT y se marca `requiere_confirmacion` con la nota "identificador extranjero". La analista decide si el cliente lo acepta.

Si la plantilla usa una etiqueta ambigua ("Identificación tributaria"), se propone el equivalente del país del cliente y se marca `requiere_confirmacion`.

## Soportes

| Tipo | Qué es | Cómo vence |
|---|---|---|
| `camara_comercio` | Certificado de existencia y representación legal | Normalmente 30 días |
| `rut` | Registro Único Tributario | No vence |
| `certificacion_bancaria` | Certificación de la cuenta | Según fecha del banco |
| `estados_financieros` | Estados financieros del último año | Hasta el cierre del siguiente año |
| `parafiscales` | Pago de seguridad social y parafiscales | Mensual |
| `certificado_cumplimiento_tributario` | Paz y salvo tributario | Periferia no lo tiene en el repositorio |

Reglas:
- Un soporte con `vigencia_hasta` anterior a la fecha de ejecución está **vencido** y bloquea `listo_para_firma`.
- Un soporte exigido que no existe en el repositorio está **ausente** y bloquea `listo_para_firma`.
- Un campo `faltante` **no** bloquea, pero aparece en el checklist.

## Datos bancarios

- Se llenan **solo** si la plantilla los pide explícitamente.
- **Nunca** aparecen en el borrador de correo ni en el resumen del chat (en el chat se dice "datos bancarios incluidos en el formulario", sin el número de cuenta).

## Portales web

Si el formato es `portal`, el agente no entra al portal. Genera `valores-portal.md` con los valores listos para copiar. Las credenciales y el clic en "Enviar" son siempre humanos.
